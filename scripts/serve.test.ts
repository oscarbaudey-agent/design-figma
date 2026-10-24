import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { $ } from "bun";
import { startServer } from "./serve";
import { createClient, collectImageRefs, type CodeBridge } from "../plugin/ui-client";

const VERIFY_IR = join(import.meta.dir, "fixtures", "sample", "ir"); // neutral sample deck
const SLIDES = [0, 1, 2, 3, 4];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const tmp = mkdtempSync(join(tmpdir(), "serve-test-"));
const out = join(tmp, "out");
let srv: ReturnType<typeof startServer>;
let base: string;

beforeAll(() => {
  srv = startServer({ irDir: VERIFY_IR, outDir: out, port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => srv.stop());

/** Fake plugin main thread: records calls and answers per the postMessage contract. */
function fakeBridge(calls: any[], opts: { failBuildIndex?: number } = {}): CodeBridge {
  return {
    async call(msg, replyType) {
      calls.push(msg);
      if (msg.type === "build") {
        if (msg.ir.index === opts.failBuildIndex) throw new Error("boom");
        return { type: "built", index: msg.ir.index, report: { index: msg.ir.index, label: msg.ir.label, nodes: [], errors: [], missingFonts: [], fontsUsed: [], slideId: "1:1", imageBytes: Object.fromEntries(Object.entries(msg.images as Record<string, Uint8Array>).map(([k, v]) => [k, v.length])) } };
      }
      if (msg.type === "export") return { type: "png", index: msg.index, bytes: new Uint8Array([...PNG_MAGIC, msg.index]) };
      throw new Error("unexpected " + replyType);
    },
  };
}

test("full build job: handout, assets, reports, shots, done, then idle", async () => {
  const enq = await fetch(base + "/enqueue", { method: "POST", body: JSON.stringify({ kind: "build", slides: SLIDES }) });
  expect(enq.status).toBe(200);
  const queued = await enq.json();
  expect(queued.slides.map((s: any) => s.file)).toEqual(["slide-001.json", "slide-002.json", "slide-003.json", "slide-004.json", "slide-005.json"]);

  const calls: any[] = [];
  const statuses: string[] = [];
  const client = createClient({ base, bridge: fakeBridge(calls), onStatus: (s) => statuses.push(s.text) });
  const res = await client.pollOnce();
  expect(res).not.toBeNull();
  expect(res!.job.jobId).toBe(queued.jobId);
  expect(res!.ok).toBe(true);

  // plugin was asked to build each slide in order, with every image ref delivered as bytes
  const builds = calls.filter((c) => c.type === "build");
  expect(builds.map((b) => b.ir.index)).toEqual(SLIDES);
  let totalRefs = 0;
  for (const b of builds) {
    const refs = collectImageRefs(b.ir);
    totalRefs += refs.length;
    expect(Object.keys(b.images).sort()).toEqual(refs.sort());
    for (const r of refs) expect(b.images[r]).toBeInstanceOf(Uint8Array);
  }
  expect(totalRefs).toBeGreaterThan(0); // test would be vacuous without images
  expect(statuses.some((s) => s.includes("building slide 5"))).toBe(true);

  // reports and shots landed with 1-based padded names
  for (const i of SLIDES) {
    const n = String(i + 1).padStart(3, "0");
    const rep = JSON.parse(readFileSync(join(out, "reports", `slide-${n}.json`), "utf8"));
    expect(rep.index).toBe(i);
    const shot = new Uint8Array(readFileSync(join(out, "shots", `slide-${n}.png`)));
    expect([...shot]).toEqual([...PNG_MAGIC, i]);
  }
  expect(readdirSync(join(out, "reports")).length).toBe(5);

  // job log has enqueue, handout, 5 reports, 5 shots, done(ok)
  const log = readFileSync(join(out, "jobs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.filter((e) => e.ev === "report").length).toBe(5);
  expect(log.filter((e) => e.ev === "shot").length).toBe(5);
  expect(log.find((e) => e.ev === "done")).toMatchObject({ jobId: queued.jobId, ok: true });

  // job closed: a second /job is 204
  expect((await fetch(base + "/job")).status).toBe(204);
  expect(await client.pollOnce()).toBeNull();
});

test("job stays handed out (204 to others) until /done", async () => {
  const j = await (await fetch(base + "/enqueue", { method: "POST", body: JSON.stringify({ kind: "build", slides: [0] }) })).json();
  expect((await fetch(base + "/job")).status).toBe(200);
  expect((await fetch(base + "/job")).status).toBe(204);
  await fetch(`${base}/done/${j.jobId}`, { method: "POST", body: JSON.stringify({ ok: true, errors: [] }) });
  expect((await fetch(base + "/job")).status).toBe(204);
});

test("a failing slide is reported in /done errors but the job still closes", async () => {
  await fetch(base + "/enqueue", { method: "POST", body: JSON.stringify({ kind: "build", slides: [0, 1], exportScale: 0 }) });
  const client = createClient({ base, bridge: fakeBridge([], { failBuildIndex: 0 }) });
  const res = await client.pollOnce();
  expect(res!.ok).toBe(false);
  expect(res!.errors[0]).toContain("boom");
  expect(existsSync(join(out, "reports", "slide-002.json"))).toBe(true);
  expect((await fetch(base + "/job")).status).toBe(204);
});

test("every real asset is served, within 4096px, and CORS is open", async () => {
  const files = readdirSync(join(VERIFY_IR, "assets"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const r = await fetch(`${base}/asset/assets/${f}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const p = join(tmp, "got-" + f);
    writeFileSync(p, new Uint8Array(await r.arrayBuffer()));
    const d = await $`sips -g pixelWidth -g pixelHeight ${p}`.quiet().text();
    expect(Math.max(+/pixelWidth: (\d+)/.exec(d)![1]!, +/pixelHeight: (\d+)/.exec(d)![1]!)).toBeLessThanOrEqual(4096);
  }
  expect((await fetch(`${base}/asset/assets/..%2Fslide-001.json`)).status).toBe(404);
  const pre = await fetch(base + "/job", { method: "OPTIONS" });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
});

function bigPng(w: number, h: number): Uint8Array {
  // minimal 8-bit grayscale PNG, flat colour
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Uint8Array) => {
    const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer);
    v.setUint32(0, d.length); o.set(new TextEncoder().encode(t), 4); o.set(d, 8);
    v.setUint32(8 + d.length, crc(o.subarray(4, 8 + d.length))); return o;
  };
  const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w); iv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 0;
  const raw = new Uint8Array((w + 1) * h); // filter byte 0 + zero pixels
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts);
}

test("oversize image is downscaled to 4096 on the long side, small one is untouched", async () => {
  const ir = join(tmp, "ir2");
  mkdirSync(join(ir, "assets"), { recursive: true });
  writeFileSync(join(ir, "assets", "big.png"), bigPng(6000, 300));
  writeFileSync(join(ir, "assets", "small.png"), bigPng(100, 50));
  const s2 = startServer({ irDir: ir, outDir: join(tmp, "out2"), port: 0 });
  try {
    const big = new Uint8Array(await (await fetch(`http://127.0.0.1:${s2.port}/asset/assets/big.png`)).arrayBuffer());
    const p = join(tmp, "big-got.png");
    writeFileSync(p, big);
    const d = await $`sips -g pixelWidth -g pixelHeight ${p}`.quiet().text();
    expect(+/pixelWidth: (\d+)/.exec(d)![1]!).toBe(4096);
    expect(+/pixelHeight: (\d+)/.exec(d)![1]!).toBe(205); // 300 * 4096/6000
    const small = new Uint8Array(await (await fetch(`http://127.0.0.1:${s2.port}/asset/assets/small.png`)).arrayBuffer());
    expect(small.length).toBe(readFileSync(join(ir, "assets", "small.png")).length);
  } finally {
    s2.stop();
  }
});

test("enqueue of a missing slide is rejected; probe job round-trips", async () => {
  const bad = await fetch(base + "/enqueue", { method: "POST", body: JSON.stringify({ kind: "build", slides: [999] }) });
  expect(bad.status).toBe(400);
  await fetch(base + "/enqueue", { method: "POST", body: JSON.stringify({ kind: "probe", slides: [] }) });
  const calls: any[] = [];
  const bridge: CodeBridge = { async call(msg) { calls.push(msg); return { type: "probe-result", fonts: [{ family: "Denim INK", style: "Regular" }], axes: {}, editorType: "slides" }; } };
  const res = await createClient({ base, bridge }).pollOnce();
  expect(res!.ok).toBe(true);
  // families come from the deck's own text runs (sorted), not a hard-coded list
  expect(calls[0]).toMatchObject({ type: "probe", families: ["Helvetica Neue", "Menlo"] });
  expect(JSON.parse(readFileSync(join(out, "probe.json"), "utf8")).fonts[0].family).toBe("Denim INK");
  const slide1 = join(out, "reports", "slide-001.json"); // an earlier build test may have written it
  if (existsSync(slide1)) expect(JSON.parse(readFileSync(slide1, "utf8")).fonts).toBeUndefined(); // probe never overwrites it
  expect(await (await fetch(base + "/status")).text()).toContain("queued jobs: 0");
});

// ---- remove jobs (calibration slides, indices >= 1000) ----
test("remove job: needs an explicit list, deck slides need force, calibration slides do not need an IR file", async () => {
  const post = (b: any) => fetch(base + "/enqueue", { method: "POST", body: JSON.stringify(b) });
  expect((await post({ kind: "remove", slides: [] })).status).toBe(400);
  expect((await post({ kind: "remove", slides: "all" })).status).toBe(400);
  const deck = await post({ kind: "remove", slides: [0, 1000] });
  expect(deck.status).toBe(400);
  expect((await deck.json()).error).toContain("force");
  expect((await post({ kind: "remove", slides: [-1] })).status).toBe(400);
  const ok = await post({ kind: "remove", slides: [1000, 1001] });
  expect(ok.status).toBe(200);
  const job = await ok.json();
  expect(job.kind).toBe("remove");
  expect(job.slides.map((s: any) => s.index)).toEqual([1000, 1001]);
  // force lets a deck slide through; drain both jobs so later tests see an empty queue
  const forced = await post({ kind: "remove", slides: [3], force: true });
  expect(forced.status).toBe(200);

  const calls: any[] = [];
  const bridge: CodeBridge = { async call(msg) { calls.push(msg); return { type: "removed", removed: msg.indices.filter((i: number) => i !== 1001), missing: msg.indices.filter((i: number) => i === 1001) }; } };
  const client = createClient({ base, bridge });
  const first = await client.pollOnce();
  expect(calls[0]).toEqual({ type: "remove", indices: [1000, 1001] });
  expect(first!.ok).toBe(false); // 1001 was not found: the missing index is an error, not silence
  expect(first!.errors[0]).toContain("1001");
  const second = await client.pollOnce();
  expect(calls[1]).toEqual({ type: "remove", indices: [3] });
  expect(second!.ok).toBe(true);
  expect(await client.pollOnce()).toBeNull();
});

test("slide indices of 1000 and over survive 'all' (4-digit file names) and build jobs", async () => {
  const ir = join(tmp, "ir-cal");
  mkdirSync(ir, { recursive: true });
  for (const n of [1, 1001, 1002]) writeFileSync(join(ir, `slide-${String(n).padStart(3, "0")}.json`), "{}");
  const s3 = startServer({ irDir: ir, outDir: join(tmp, "out-cal"), port: 0 });
  try {
    const job = s3.enqueue("build", "all");
    expect(job.slides.map((s) => s.index)).toEqual([0, 1000, 1001]);
    expect(job.slides.map((s) => s.file)).toEqual(["slide-001.json", "slide-1001.json", "slide-1002.json"]);
  } finally {
    s3.stop();
  }
});

test("--slides parses lists and ranges, refuses junk; the server refuses non-index slides", async () => {
  const { parseSlides } = await import("./serve");
  expect(parseSlides("0,16,26-28")).toEqual([0, 16, 26, 27, 28]);
  expect(parseSlides("0-3")).toEqual([0, 1, 2, 3]);
  expect(parseSlides("all")).toBe("all");
  expect(() => parseSlides("0-x")).toThrow();
  expect(() => parseSlides("5-2")).toThrow();
  const bad = await fetch(base + "/enqueue", { method: "POST", body: JSON.stringify({ kind: "build", slides: [null] }) });
  expect(bad.ok).toBe(false);
});
