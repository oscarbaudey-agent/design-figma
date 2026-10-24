// End-to-end without Figma: real serve.ts + real ui-client.ts + real bundled plugin/code.js on the strict mock.
//   bun e2e-mock.ts            runs a clean pass (must be all green) then a corrupted pass (must go red)
// Stand-in for the render: the mock's exportAsync returns the matching reference PNG, so the pixel diff is
// expected to be 0; what this proves is the wiring (HTTP, messages, reports, shots, check.ts), not Figma's output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./serve";
import { createClient } from "../plugin/ui-client";
import { makeFigma } from "./lib/mock-figma";

const here = import.meta.dir;
const SAMPLE = join(here, "fixtures", "sample"); // neutral sample deck, built by fixtures/make-sample.ts
const IR = join(SAMPLE, "ir");
const REF = join(SAMPLE, "ref");
const SLIDES = [0, 1, 2, 3, 4];
const CORRUPT_INDEX = 1; // must be one of SLIDES and hold text, or the corrupted pass proves nothing
let corrupted = 0;
const WORK = mkdtempSync(join(tmpdir(), "design-figma-e2e-"));
const pad = (i: number) => String(i + 1).padStart(3, "0");

async function runPass(outDir: string, corrupt: boolean) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const code = readFileSync(join(here, "..", "plugin", "code.js"), "utf8");
  const m = makeFigma(undefined, {
    exportBytes: (node) => new Uint8Array(readFileSync(join(REF, `slide-${pad(Number(node.getSharedPluginData("designfigma", "index")))}.png`))),
  });
  new Function("figma", "__html__", code)(m.figma, "<html></html>");
  if (typeof m.figma.ui.onmessage !== "function") throw new Error("plugin registered no onmessage");

  const srv = startServer({ irDir: IR, outDir, port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const bridge = {
    async call(msg: any, replyType: string) {
      if (corrupt && msg.type === "build" && msg.ir.index === CORRUPT_INDEX) {
        // fault: the last text node never reaches the plugin
        corrupted++;
        const last = msg.ir.nodes.map((n: any) => n.type).lastIndexOf("text");
        msg = { ...msg, ir: { ...msg.ir, nodes: msg.ir.nodes.filter((_: any, i: number) => i !== last) } };
      }
      const before = m.posted.length;
      await m.figma.ui.onmessage(msg);
      const reply = m.posted.slice(before).find((p: any) => p.type === replyType || p.type === "error");
      if (!reply) throw new Error(`no ${replyType} reply to ${msg.type}`);
      if (reply.type === "error") throw new Error(reply.msg);
      return reply;
    },
  };
  const client = createClient({ base, bridge, sleep: async () => {} });
  const enqueue = async (body: any) => {
    const r = await fetch(base + "/enqueue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("enqueue failed " + (await r.text()));
  };
  const drain = async () => {
    const done: any[] = [];
    for (let r; (r = await client.pollOnce()); ) done.push(r);
    return done;
  };

  await enqueue({ kind: "probe", slides: [] });
  const probe = await drain();
  const probeRep = JSON.parse(readFileSync(join(outDir, "probe.json"), "utf8"));
  await enqueue({ kind: "build", slides: SLIDES, exportScale: 1 });
  const build = await drain();
  srv.stop();
  console.log(`[${corrupt ? "corrupt" : "clean"}] probe jobs=${probe.length} ok=${probe.map((j) => j.ok)} fonts=${probeRep.fonts?.length} axes=${JSON.stringify(probeRep.axes)}`);
  console.log(`[${corrupt ? "corrupt" : "clean"}] build jobs=${build.length} ok=${build.map((j) => j.ok)} errors=${JSON.stringify(build.flatMap((j) => j.errors))}`);
  console.log(`[${corrupt ? "corrupt" : "clean"}] mock violations=${m.violations.length} slides in grid=${m.grid.flat().length} exports=${m.exports.length}`);
  if (m.violations.length) throw new Error("mock violations: " + m.violations.slice(0, 3).join("; "));
  if (build.length !== 1) throw new Error("expected 1 build job, got " + build.length);
  if (corrupt && corrupted === 0) throw new Error(`corruption never applied: slide index ${CORRUPT_INDEX} was not built`);
}

async function check(outDir: string) {
  const p = Bun.spawn(["bun", join(here, "check.ts"), "--ir", IR, "--ref", REF, "--out", outDir, "--slides", SLIDES.join(",")], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

const clean = join(WORK, "e2e-out");
const bad = join(WORK, "e2e-out-corrupt");
await runPass(clean, false);
const c1 = await check(clean);
console.log(c1.out);
await runPass(bad, true);
const c2 = await check(bad);
console.log(c2.out);
const ok = c1.code === 0 && c2.code !== 0;
console.log(ok ? "E2E OK: clean pass green, corrupted pass red" : `E2E FAIL: clean exit=${c1.code} (want 0), corrupt exit=${c2.code} (want non-zero)`);
process.exit(ok ? 0 : 1);
