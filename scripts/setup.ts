// Run at the start of every conversion: bun scripts/setup.ts (from anywhere).
// 1. Installs the script dependencies if missing.
// 2. Copies the Figma plugin to a fixed folder, ~/.design-figma/figma-plugin (or $DESIGN_FIGMA_HOME/figma-plugin).
//    Claude Code keeps an installed plugin under a path that changes with every version, and Figma remembers the
//    manifest path it imported, so Figma must import from a folder that never moves.
// Prints one JSON line: {manifest, firstRun, pluginChanged}. firstRun = the user still has to import the manifest;
// pluginChanged = code.js or ui.html differ from the copy Figma last loaded, so the user must restart the plugin.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const scripts = import.meta.dir;
const src = join(scripts, "..", "plugin");
const home = process.env.DESIGN_FIGMA_HOME || join(homedir(), ".design-figma");
const dst = join(home, "figma-plugin");

if (!existsSync(join(scripts, "node_modules", "playwright"))) {
  const r = Bun.spawnSync(["bun", "install"], { cwd: scripts, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) { console.error("bun install failed: " + r.stderr.toString()); process.exit(1); }
}

const firstRun = !existsSync(join(dst, "manifest.json"));
mkdirSync(dst, { recursive: true });
let pluginChanged = false;
for (const f of ["manifest.json", "code.js", "ui.html"]) {
  const body = readFileSync(join(src, f));
  const target = join(dst, f);
  if (existsSync(target) && Buffer.compare(readFileSync(target), body) === 0) continue;
  if (!firstRun && f !== "manifest.json") pluginChanged = true;
  writeFileSync(target, body);
}
console.log(JSON.stringify({ manifest: join(dst, "manifest.json"), firstRun, pluginChanged }));
