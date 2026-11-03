// Builds dist/ from site/:
//   dist/site/        the multi-file site, ready for GitHub Pages (copy of site/ minus nothing)
//   dist/中考诊断台.html  one self-contained file (every script inlined) to send over WeChat
// Usage: node tools/build.mjs
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..", "site");
const dist = join(here, "..", "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(site, join(dist, "site"), { recursive: true });

const ctx = {}; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(site, "content", "subjects.js"), "utf8"), ctx);
const files = ctx.ZK.files.filter((f) => existsSync(join(site, "content", f + ".js")));
const skipped = ctx.ZK.files.filter((f) => !files.includes(f));

// Inline scripts must not contain a literal closing script tag.
const safe = (src) => src.replace(/<\/script/gi, "<\\/script");
const tag = (path) => `<script>/* ${path} */\n${safe(readFileSync(join(site, path), "utf8"))}\n</script>`;
let html = readFileSync(join(site, "index.html"), "utf8");
html = html
  .replace('<script src="config.js"></script>', tag("config.js"))
  .replace('<script src="content/subjects.js"></script>', tag("content/subjects.js"))
  .replace("<!--BANKS-->", files.map((f) => tag(`content/${f}.js`)).join("\n"))
  .replace('<script src="sync.js"></script>', tag("sync.js"))
  .replace('<script src="app.js"></script>', tag("app.js"));
const out = join(dist, "中考诊断台.html");
writeFileSync(out, html);
console.log(`dist/site/ copied; ${out} written (${(html.length / 1024).toFixed(0)} KB, ${files.length} banks${skipped.length ? `; missing: ${skipped.join(", ")}` : ""}).`);
