// Client logic shared by plugin/ui.html (inlined by scripts/build-ui.ts) and scripts/serve.test.ts.
// Talks HTTP to scripts/serve.ts and postMessage-style RPC to plugin/src/code.ts.

export type Msg = { type: string; [k: string]: any };

/** Sends a message to the plugin main thread and resolves with its reply (or rejects on {type:"error"}). */
export interface CodeBridge {
  call(msg: Msg, replyType: string): Promise<Msg>;
}

export interface Status {
  state: "connecting" | "idle" | "building" | "exporting" | "probing" | "offline";
  text: string;
  lastError?: string;
}

export interface ClientOptions {
  base: string; // e.g. http://localhost:4747
  bridge: CodeBridge;
  onStatus?: (s: Status) => void;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface Job {
  jobId: string;
  kind: "build" | "probe" | "export" | "remove";
  slides: { index: number; file: string }[];
  options?: { exportScale?: number; families?: string[]; removeBlank?: boolean };
}


/** Collect every image ref used by a slide (node images, image fills, background fills). */
export function collectImageRefs(ir: any): string[] {
  const refs = new Set<string>();
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      if (v.type === "image" && typeof v.ref === "string") refs.add(v.ref);
      for (const k in v) walk(v[k]);
    }
  };
  walk(ir);
  return [...refs];
}

export function createClient(opts: ClientOptions) {
  const f: typeof fetch = opts.fetchFn ?? ((...a) => fetch(...a));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.base.replace(/\/$/, "");
  let lastError: string | undefined;
  const status = (state: Status["state"], text: string) => opts.onStatus?.({ state, text, lastError });
  const fail = (msg: string) => {
    lastError = msg;
  };

  async function post(path: string, body: any, contentType = "application/json") {
    const r = await f(base + path, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: contentType === "application/json" ? JSON.stringify(body) : body,
    });
    if (!r.ok) throw new Error(`POST ${path} -> ${r.status}`);
  }
  const log = (level: string, msg: string) => post("/log", { level, msg }).catch(() => {});

  async function getBytes(path: string): Promise<Uint8Array> {
    const r = await f(base + path);
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async function fetchImages(ir: any): Promise<{ [ref: string]: Uint8Array }> {
    const images: { [ref: string]: Uint8Array } = {};
    for (const ref of collectImageRefs(ir)) {
      images[ref] = await getBytes("/asset/" + ref.split("/").map(encodeURIComponent).join("/"));
    }
    return images;
  }

  async function exportShot(job: Job, index: number, scale: number) {
    status("exporting", `exporting slide ${index + 1}`);
    const png = await opts.bridge.call({ type: "export", index, scale }, "png");
    await post(`/shot/${job.jobId}/${index}`, png.bytes, "image/png");
  }

  async function processSlide(job: Job, s: { index: number; file: string }, errors: string[]) {
    try {
      if (job.kind === "export") {
        await exportShot(job, s.index, job.options?.exportScale ?? 1);
        return;
      }
      status("building", `building slide ${s.index + 1}`);
      const ir = await (await f(`${base}/ir/${s.file}`)).json();
      const images = await fetchImages(ir);
      const built = await opts.bridge.call({ type: "build", ir, images, removeBlank: !!job.options?.removeBlank }, "built");
      await post(`/report/${job.jobId}/${s.index}`, built.report);
      if (job.options?.exportScale) await exportShot(job, s.index, job.options.exportScale);
    } catch (e: any) {
      const msg = `slide ${s.index}: ${e?.message ?? e}`;
      errors.push(msg);
      fail(msg);
      await log("error", msg);
    }
  }

  async function processJob(job: Job): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    if (job.kind === "probe") {
      status("probing", "probing fonts");
      try {
        const families = job.options?.families ?? [];
        const res = await opts.bridge.call({ type: "probe", families }, "probe-result");
        await post(`/report/${job.jobId}/0`, res);
      } catch (e: any) {
        errors.push(String(e?.message ?? e));
        fail(errors[0]);
      }
    } else if (job.kind === "remove") {
      status("building", `removing ${job.slides.length} slide(s)`);
      try {
        const res = await opts.bridge.call({ type: "remove", indices: job.slides.map((s) => s.index) }, "removed");
        if (res.missing && res.missing.length) {
          const m = `remove: no tagged slide with index ${res.missing.join(",")}`;
          errors.push(m);
          fail(m);
        }
      } catch (e: any) {
        errors.push(String(e?.message ?? e));
        fail(errors[errors.length - 1]!);
      }
    } else {
      for (const s of job.slides) await processSlide(job, s, errors);
    }
    const result = { ok: errors.length === 0, errors };
    try {
      await post(`/done/${job.jobId}`, result);
    } catch (e: any) {
      fail(`done: ${e?.message ?? e}`);
    }
    status("idle", `job ${job.jobId} ${result.ok ? "done" : "finished with errors"}`);
    return result;
  }

  /** One poll. Returns the processed job or null when idle/offline. */
  async function pollOnce(): Promise<{ job: Job; ok: boolean; errors: string[] } | null> {
    let r: Response;
    try {
      r = await f(base + "/job");
    } catch (e: any) {
      status("offline", `server unreachable (${base})`);
      return null;
    }
    if (r.status === 204) {
      status("idle", "connected, idle");
      return null;
    }
    if (!r.ok) {
      fail(`GET /job -> ${r.status}`);
      status("offline", `server error ${r.status}`);
      return null;
    }
    const job = (await r.json()) as Job;
    const res = await processJob(job);
    return { job, ...res };
  }

  async function loop(shouldStop: () => boolean = () => false) {
    status("connecting", "connecting");
    while (!shouldStop()) {
      try {
        const did = await pollOnce();
        if (did) continue; // check again straight away
      } catch (e: any) {
        fail(String(e?.message ?? e));
        status("offline", "client error");
      }
      await sleep(opts.pollMs ?? 1500);
    }
  }

  return { pollOnce, processJob, loop };
}

/** Browser wiring: postMessage bridge to the plugin main thread, status line, poll loop. */
export function startUiClient(base = "http://localhost:4747") {
  const el = document.getElementById("status")!;
  const pending: { replyType: string; resolve: (m: Msg) => void; reject: (e: Error) => void }[] = [];
  window.onmessage = (ev: MessageEvent) => {
    const m = ev.data && ev.data.pluginMessage;
    if (!m) return;
    const p = pending.shift();
    if (!p) return;
    if (m.type === "error") p.reject(new Error(m.msg));
    else if (m.type === p.replyType) p.resolve(m);
    else {
      pending.unshift(p); // unrelated message, keep waiting
    }
  };
  const bridge: CodeBridge = {
    call(msg, replyType) {
      return new Promise((resolve, reject) => {
        pending.push({ replyType, resolve, reject });
        parent.postMessage({ pluginMessage: msg }, "*");
      });
    },
  };
  const client = createClient({
    base,
    bridge,
    onStatus: (s) => {
      el.textContent = s.text + (s.lastError ? `  |  last error: ${s.lastError}` : "");
      el.dataset.state = s.state;
    },
  });
  client.loop();
}
