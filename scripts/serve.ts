// Local converter server for the design-figma Figma plugin (D-005).
//   bun serve.ts --ir <dir> --out <dir> [--port 4747]
//   bun serve.ts enqueue --kind build --slides 0,16,26 [--scale 1] [--port 4747]
//   bun serve.ts enqueue --kind remove --slides 1000,1001 [--force]   (deletes tagged slides; indices < 1000 need --force)
import { mkdirSync, existsSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { $ } from "bun";

export const MAX_DIM = 4096;
/** Slide indices below this belong to the deck; "remove" jobs on them need force. Calibration slides use 1000+. */
export const CALIBRATION_BASE = 1000;
const LEASE_MS = 5 * 60_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const nnn = (i: number) => String(i + 1).padStart(3, "0");

export interface Job {
  jobId: string;
  kind: "build" | "probe" | "export" | "remove";
  slides: { index: number; file: string }[];
  options: { exportScale: number; families?: string[]; removeBlank?: boolean };
}

export function startServer(o: { irDir: string; outDir: string; port?: number }) {
  const irDir = resolve(o.irDir);
  const outDir = resolve(o.outDir);
  const assetDir = join(irDir, "assets");
  const cacheDir = join(outDir, "asset-cache");
  for (const d of ["reports", "shots", "asset-cache"]) mkdirSync(join(outDir, d), { recursive: true });
  const jobsLog = join(outDir, "jobs.jsonl");
  const event = (e: Record<string, unknown>) => appendFileSync(jobsLog, JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n");

  const queue: Job[] = [];
  let active: { job: Job; lease: number } | null = null;
  let lastJob: { jobId: string; ok?: boolean; errors?: string[] } | null = null;
  let lastPoll = 0;
  let seq = 0;
  const touch = () => { if (active) active.lease = Date.now() + LEASE_MS; };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  const empty = (status: number) => new Response(null, { status, headers: CORS });
  const text = (s: string, status = 200) => new Response(s, { status, headers: { ...CORS, "Content-Type": "text/plain" } });

  function deckFamilies(): string[] {
    const fams = new Set<string>();
    const walk = (v: any) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        if (typeof v.fontFamily === "string") fams.add(v.fontFamily);
        for (const k in v) walk(v[k]);
      }
    };
    for (const f of readdirSync(irDir).filter((f) => /^slide-\d+\.json$/.test(f))) walk(JSON.parse(readFileSync(join(irDir, f), "utf8")));
    return [...fams].sort();
  }

  function enqueue(kind: string, slides: number[] | "all", exportScale = 1, families?: string[], removeBlank = false, force = false) {
    if (!["build", "probe", "export", "remove"].includes(kind)) throw new Error(`bad kind ${kind}`);
    let idx: number[];
    if (slides === "all") {
      idx = readdirSync(irDir).filter((f) => /^slide-\d+\.json$/.test(f)).map((f) => parseInt(/^slide-(\d+)\.json$/.exec(f)![1]!, 10) - 1).sort((a, b) => a - b);
    } else idx = slides;
    // JSON turns NaN into null, and nnn(null) would quietly name slide-001: refuse anything that is not an index.
    if (!idx.every((i) => Number.isInteger(i) && i >= 0)) throw new Error(`bad slide index in ${JSON.stringify(slides)}`);
    if (kind === "remove") {
      // Deletes slides in the open Figma file: a list is required, and deck slides (below CALIBRATION_BASE) need force.
      if (slides === "all" || idx.length === 0) throw new Error("remove needs an explicit list of slide indices");
      const deck = idx.filter((i) => i < CALIBRATION_BASE);
      if (deck.length && !force) throw new Error(`remove: slide indices ${deck.join(",")} are below ${CALIBRATION_BASE} (deck slides); pass force to delete them`);
    }
    const list = idx.map((index) => ({ index, file: `slide-${nnn(index)}.json` }));
    for (const s of list) if (kind !== "probe" && kind !== "remove" && !existsSync(join(irDir, s.file))) throw new Error(`missing IR ${s.file}`);
    // A probe with no families asks about every font family the deck's text uses.
    if (kind === "probe" && !families) families = deckFamilies();
    const job: Job = { jobId: `j${Date.now().toString(36)}${++seq}`, kind: kind as Job["kind"], slides: list, options: { exportScale, ...(families ? { families } : {}), ...(removeBlank ? { removeBlank } : {}) } };
    queue.push(job);
    event({ ev: "enqueue", jobId: job.jobId, kind, slides: idx });
    return job;
  }

  // ---- assets: downscale to <= MAX_DIM on the long side via sips, never upscale ----
  async function assetFile(rel: string): Promise<{ path: string; type: string } | null> {
    const name = rel.replace(/^assets\//, "");
    if (!name || name.includes("..") || name.includes("/")) return null;
    const src = join(assetDir, name);
    if (!existsSync(src)) return null;
    const ext = extname(name).toLowerCase();
    const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : "application/octet-stream";
    const dims = await $`sips -g pixelWidth -g pixelHeight ${src}`.quiet().nothrow().text();
    const w = parseInt(/pixelWidth:\s*(\d+)/.exec(dims)?.[1] ?? "0", 10);
    const h = parseInt(/pixelHeight:\s*(\d+)/.exec(dims)?.[1] ?? "0", 10);
    if (Math.max(w, h) <= MAX_DIM) return { path: src, type };
    const dst = join(cacheDir, `${MAX_DIM}-${basename(name)}`);
    if (!existsSync(dst)) {
      const r = await $`sips -Z ${MAX_DIM} ${src} --out ${dst}`.quiet().nothrow();
      if (r.exitCode !== 0) return null;
    }
    return { path: dst, type };
  }

  async function fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const p = url.pathname;
      if (req.method === "OPTIONS") return empty(204);
      try {
        if (req.method === "GET" && p === "/job") {
          lastPoll = Date.now();
          if (active && Date.now() > active.lease) {
            event({ ev: "lease-expired", jobId: active.job.jobId });
            active = null;
          }
          if (active || queue.length === 0) return empty(204);
          const job = queue.shift()!;
          active = { job, lease: Date.now() + LEASE_MS };
          event({ ev: "handout", jobId: job.jobId });
          return json(job);
        }
        if (req.method === "GET" && p.startsWith("/ir/")) {
          const f = decodeURIComponent(p.slice(4));
          if (!/^slide-\d+\.json$/.test(f)) return text("bad file", 400);
          const file = Bun.file(join(irDir, f));
          if (!(await file.exists())) return text("not found", 404);
          return new Response(file, { headers: { ...CORS, "Content-Type": "application/json" } });
        }
        if (req.method === "GET" && p.startsWith("/asset/")) {
          const a = await assetFile(decodeURIComponent(p.slice(7)));
          if (!a) return text("not found", 404);
          return new Response(Bun.file(a.path), { headers: { ...CORS, "Content-Type": a.type } });
        }
        let m: RegExpExecArray | null;
        if (req.method === "POST" && (m = /^\/(report|shot)\/([\w-]+)\/(\d+)$/.exec(p))) {
          const [, what, jobId, idxS] = m;
          const index = parseInt(idxS!, 10);
          touch();
          if (what === "report") {
            const body = await req.json();
            // Probe results go to probe.json so they never overwrite a slide's build report.
            const isProbe = active?.job.jobId === jobId && active.job.kind === "probe";
            await Bun.write(isProbe ? join(outDir, "probe.json") : join(outDir, "reports", `slide-${nnn(index)}.json`), JSON.stringify(body, null, 2));
          } else {
            await Bun.write(join(outDir, "shots", `slide-${nnn(index)}.png`), new Uint8Array(await req.arrayBuffer()));
          }
          event({ ev: what, jobId, index });
          return json({ ok: true });
        }
        if (req.method === "POST" && (m = /^\/done\/([\w-]+)$/.exec(p))) {
          const body = (await req.json().catch(() => ({}))) as { ok?: boolean; errors?: string[] };
          event({ ev: "done", jobId: m[1], ok: body.ok, errors: body.errors ?? [] });
          lastJob = { jobId: m[1]!, ok: body.ok, errors: body.errors ?? [] };
          if (active?.job.jobId === m[1]) active = null;
          return json({ ok: true });
        }
        if (req.method === "POST" && p === "/log") {
          const body = (await req.json().catch(() => ({}))) as { level?: string; msg?: string };
          event({ ev: "log", level: body.level, msg: body.msg });
          return json({ ok: true });
        }
        if (req.method === "POST" && p === "/enqueue") {
          const b = (await req.json()) as { kind?: string; slides?: number[] | "all"; exportScale?: number; families?: string[]; removeBlank?: boolean; force?: boolean };
          try {
            const job = enqueue(b.kind ?? "build", b.slides ?? [], b.exportScale ?? 1, b.families, !!b.removeBlank, !!b.force);
            return json(job);
          } catch (e: any) {
            return json({ error: e.message }, 400);
          }
        }
        if (req.method === "GET" && p === "/status") {
          const ago = lastPoll ? Math.round((Date.now() - lastPoll) / 1000) : null;
          return text(
            [
              `design-figma bridge, ir=${irDir} out=${outDir}`,
              `plugin last polled: ${ago === null ? "never" : ago + "s ago"}`,
              `queued jobs: ${queue.length}`,
              `active: ${active ? active.job.jobId + " (" + active.job.kind + ", " + active.job.slides.length + " slides)" : "none"}`,
              `last finished: ${lastJob ? JSON.stringify(lastJob) : "none"}`,
            ].join("\n") + "\n",
          );
        }
        return text("not found", 404);
      } catch (e: any) {
        event({ ev: "server-error", path: p, msg: String(e?.message ?? e) });
        return json({ error: String(e?.message ?? e) }, 500);
      }
  }

  // Figma may resolve "localhost" to ::1, so answer on both loopback addresses (never on the network).
  const server = Bun.serve({ port: o.port ?? 4747, hostname: "127.0.0.1", idleTimeout: 60, fetch });
  let server6: ReturnType<typeof Bun.serve> | null = null;
  try { server6 = Bun.serve({ port: server.port, hostname: "::1", idleTimeout: 60, fetch }); } catch { /* no IPv6 loopback */ }
  return { server, port: server.port, enqueue, stop: () => { server.stop(true); server6?.stop(true); } };
}

// ---------------- CLI ----------------
/** "0,16,26-28" -> [0,16,26,27,28]; "all" stays "all". Anything else throws, so a typo never reaches the plugin. */
export function parseSlides(sl: string): number[] | "all" {
  if (sl === "all") return "all";
  return sl.split(",").filter(Boolean).flatMap((part) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad --slides part "${part}" (use 0,16,26-28 or all)`);
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (b < a) throw new Error(`bad --slides range "${part}"`);
    return Array.from({ length: b - a + 1 }, (_, k) => a + k);
  });
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "enqueue") {
    const port = arg(argv, "port") ?? "4747";
    const sl = arg(argv, "slides") ?? "";
    let slides: number[] | "all";
    try { slides = parseSlides(sl); } catch (e) { console.error(String((e as Error).message)); process.exit(1); }
    const res = await fetch(`http://127.0.0.1:${port}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: arg(argv, "kind") ?? "build", slides, exportScale: Number(arg(argv, "scale") ?? 1), removeBlank: argv.includes("--remove-blank"), force: argv.includes("--force") }),
    }).catch(() => null);
    if (!res) { console.error(`no server on port ${port}; start it with: bun serve.ts --ir <dir> --out <dir>`); process.exit(1); }
    const body = await res.json();
    console.log(JSON.stringify(body));
    process.exit(res.ok ? 0 : 1);
  }
  const ir = arg(argv, "ir"), out = arg(argv, "out");
  if (!ir || !out) { console.error("usage: bun serve.ts --ir <dir> --out <dir> [--port 4747] | enqueue --kind build --slides 0,16"); process.exit(1); }
  const s = startServer({ irDir: ir, outDir: out, port: Number(arg(argv, "port") ?? 4747) });
  console.log(`design-figma bridge on http://localhost:${s.port}  (status: /status)`);
}
