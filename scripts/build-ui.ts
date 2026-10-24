// Bundles plugin/src/ui-entry.ts (-> plugin/ui-client.ts) into plugin/ui.html. Run: bun run build-ui.ts
import { join, dirname } from "node:path";
const plugin = join(dirname(import.meta.dir), "plugin");
const out = await Bun.build({ entrypoints: [join(plugin, "src/ui-entry.ts")], target: "browser", format: "iife", minify: false });
if (!out.success) { console.error(out.logs.join("\n")); process.exit(1); }
let js = await out.outputs[0]!.text();
js = js.replace(/<\/script/gi, "<\\/script");
const tpl = await Bun.file(join(plugin, "ui.template.html")).text();
await Bun.write(join(plugin, "ui.html"), tpl.replace("/*__CLIENT__*/", () => js));
console.log("wrote plugin/ui.html", js.length, "bytes of js");
