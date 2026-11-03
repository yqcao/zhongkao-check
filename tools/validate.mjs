// Checks content/*.js banks against the registry. Usage:
//   node tools/validate.mjs            (all files listed in ZK.files)
//   node tools/validate.mjs sx wl      (only these bank files)
// Exits 1 on any error; prints per-module counts.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "content");
const ctx = {}; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, "subjects.js"), "utf8"), ctx);
const ZK = ctx.ZK;
const files = process.argv.slice(2).length ? process.argv.slice(2) : ZK.files;

const errors = [];
const err = (f, m) => errors.push(`[${f}] ${m}`);
const modules = new Map();
for (const s of ZK.subjects) for (const m of s.modules) modules.set(m.id, { ...m, subject: s.id });

for (const f of files) {
  const p = join(root, f + ".js");
  if (!existsSync(p)) { err(f, "file missing"); continue; }
  const before = ZK.banks.length;
  try { vm.runInContext(readFileSync(p, "utf8"), ctx, { filename: p }); }
  catch (e) { err(f, "does not run: " + e.message); continue; }
  const added = ZK.banks.slice(before);
  if (!added.length) err(f, "pushes nothing to ZK.banks");
  for (const b of added) b._file = f;
}

const ids = new Set();
const count = {}; // module -> level -> n
const passCount = {}; // module -> {passages, qs}
const passages = new Map();
const MARK_OK = /^[^<>]*$/; // no raw HTML in text fields (svg goes in its own field)

for (const b of ZK.banks) {
  const f = b._file;
  for (const p of b.passages || []) {
    if (!p.id || passages.has(p.id) || ids.has(p.id)) err(f, `passage id missing/duplicate: ${p.id}`);
    if (!modules.has(p.module)) err(f, `passage ${p.id}: unknown module ${p.module}`);
    else if (modules.get(p.module).kind !== "passage") err(f, `passage ${p.id}: module ${p.module} is not a passage module`);
    if (!p.title || !p.text || p.text.length < 60) err(f, `passage ${p.id}: title/text missing or too short`);
    if (p.text && !MARK_OK.test(p.text)) err(f, `passage ${p.id}: raw < or > in text`);
    passages.set(p.id, { ...p, qs: 0, levels: new Set() });
    ids.add(p.id);
  }
}
for (const b of ZK.banks) {
  const f = b._file;
  for (const it of b.items || []) {
    const where = it.id || "(no id)";
    if (!it.id || ids.has(it.id)) err(f, `item id missing/duplicate: ${where}`);
    ids.add(it.id);
    const m = modules.get(it.module);
    if (!m) { err(f, `${where}: unknown module ${it.module}`); continue; }
    if (![1, 2, 3, 4].includes(it.level)) err(f, `${where}: level must be 1-4`);
    if (!Array.isArray(it.choices) || it.choices.length !== 4) err(f, `${where}: needs exactly 4 choices`);
    else {
      if (new Set(it.choices.map(String)).size !== 4) err(f, `${where}: duplicate choices`);
      if (it.choices.some((c) => typeof c !== "string" || !c.trim())) err(f, `${where}: empty choice`);
    }
    if (!Number.isInteger(it.answer) || it.answer < 0 || it.answer > 3) err(f, `${where}: answer must be index 0-3`);
    if (!it.prompt) err(f, `${where}: prompt missing`);
    if (!it.explain || it.explain.length < 8) err(f, `${where}: explain missing/too short`);
    if (!it.kp) err(f, `${where}: kp (知识点) missing`);
    for (const k of ["stem", "prompt", "explain", "audio", "kp"]) if (it[k] && !MARK_OK.test(it[k])) err(f, `${where}: raw < or > in ${k} (use ＜ ＞ or ≤ ≥)`);
    if ((it.choices || []).some((c) => !MARK_OK.test(c))) err(f, `${where}: raw < or > in a choice`);
    if (it.svg && !/^<svg[\s\S]*<\/svg>$/.test(it.svg.trim())) err(f, `${where}: svg must be one <svg>…</svg>`);
    if (it.svg && /<script|on\w+=|href=/i.test(it.svg)) err(f, `${where}: svg has script/handlers/links`);
    if (m.kind === "passage") {
      const p = passages.get(it.passage);
      if (!p) err(f, `${where}: passage module item needs a valid passage id`);
      else { if (p.module !== it.module) err(f, `${where}: passage belongs to ${p.module}`); p.qs++; p.levels.add(it.level); }
    } else if (it.passage) err(f, `${where}: item module must not reference a passage`);
    ((count[it.module] ||= {})[it.level] = ((count[it.module] || {})[it.level] || 0) + 1);
  }
}
for (const p of passages.values()) {
  if (p.qs < 3 || p.qs > 6) err("passages", `${p.id}: has ${p.qs} questions (need 3-6)`);
  if (p.levels.size < 2) err("passages", `${p.id}: questions should span at least 2 levels`);
  (passCount[p.module] ||= { passages: 0, qs: 0 }).passages++;
  passCount[p.module].qs += p.qs;
}

// Coverage: item modules need ≥4 per level; passage modules need ≥3 passages.
const loadedSubjects = new Set();
for (const b of ZK.banks) for (const it of b.items || []) { const m = modules.get(it.module); if (m) loadedSubjects.add(it.module); }
const report = [];
for (const [id, m] of modules) {
  if (!loadedSubjects.has(id)) continue;
  if (m.kind === "items") {
    const c = count[id] || {};
    const row = [1, 2, 3, 4].map((l) => c[l] || 0);
    report.push(`${id.padEnd(14)} L1-4: ${row.join(" / ")}`);
    row.forEach((n, i) => { if (n < 4) err("coverage", `${id} level ${i + 1}: ${n} items (need ≥4)`); });
  } else {
    const c = passCount[id] || { passages: 0, qs: 0 };
    report.push(`${id.padEnd(14)} passages: ${c.passages}, questions: ${c.qs}`);
    if (c.passages < 3) err("coverage", `${id}: ${c.passages} passages (need ≥3)`);
  }
}
// Answer-position balance per file (engine shuffles, but a skewed key hints at lazy authoring).
for (const f of new Set(ZK.banks.map((b) => b._file))) {
  const pos = [0, 0, 0, 0];
  for (const b of ZK.banks.filter((x) => x._file === f)) for (const it of b.items || []) if (Number.isInteger(it.answer)) pos[it.answer]++;
  const n = pos.reduce((a, b) => a + b, 0);
  if (n >= 20 && Math.max(...pos) / n > 0.45) err(f, `answer positions skewed: ${pos.join("/")}`);
}

console.log(report.join("\n"));
console.log(`\n${ids.size} ids checked across ${files.length} file(s).`);
if (errors.length) { console.log(`\n${errors.length} error(s):\n` + errors.join("\n")); process.exit(1); }
console.log("OK");
