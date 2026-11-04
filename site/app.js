// 中考诊断台 — 引擎。读取 content/subjects.js 的注册表与各题库，按模块做自适应诊断，
// 结果存在本机，生成成绩码；家长页导入成绩码（或从云端拉取）后给出估分与提分建议。
(function () {
"use strict";
const ZK = window.ZK;
const { Code, Cloud } = window.ZKSync;
const app = document.getElementById("app");
if (!ZK || !ZK.subjects) { app.textContent = "题库没有加载成功，请刷新页面重试。"; return; }

// ---------------------------------------------------------------- 工具
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const $ = (q) => document.querySelector(q);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// 文本标记：**粗体** __下划线__ ___填空 ^{上标} _{下标}，\n 换行。顺序很重要：先上下标，再填空，再下划线。
function inline(s) {
  return esc(s)
    .replace(/\^\{([^{}]{1,40})\}/g, "<sup>$1</sup>")
    .replace(/_\{([^{}]{1,40})\}/g, "<sub>$1</sub>")
    .replace(/_{3,}/g, '<span class="blank"></span>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
}
const md = (s) => String(s || "").split(/\n{2,}/).map((p) => `<p>${p.split("\n").map(inline).join("<br>")}</p>`).join("");
const plain = (s) => String(s || "").replace(/\*\*|__(?!_)/g, "").replace(/\^\{([^{}]*)\}/g, "^$1").replace(/_\{([^{}]*)\}/g, "$1").replace(/_{3,}/g, "____");
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function seedFor(str) { let h = 2166136261; for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
function shuffle(arr, r = Math.random) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const randomId = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const fmtDate = (t) => { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const fmtDateTime = (t) => { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const round1 = (x) => Math.round(x * 10) / 10;
const LETTERS = ["A", "B", "C", "D"];
const LV = ZK.levels, SHARE = ZK.levelShare;
// config.js 的 resetAt：这个时间之前的成绩一律作废。每台设备打开网站时清一次本机记录，家长拉取和导入也跳过旧记录。
const RESET = +((window.ZK_CONFIG || {}).resetAt) || 0;
const levelName = (n) => (n >= 1 ? `${LV[n - 1].name}（${n} 级）` : "未达基础");
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

// ---------------------------------------------------------------- 题库索引
// 用无原型对象做查找表，导入的数据里即使有 "__proto__" 之类的编号也查不到东西。
const dict = () => Object.create(null);
const C = { items: dict(), passages: dict(), byId: dict(), passageById: dict(), mod: dict(), subj: dict(), kp: dict() };
for (const s of ZK.subjects) { C.subj[s.id] = s; for (const m of s.modules) C.mod[m.id] = { ...m, subject: s.id }; }
function loadScript(src) { return new Promise((res) => { const s = document.createElement("script"); s.src = src; s.async = false; s.onload = () => res(true); s.onerror = () => res(false); document.head.appendChild(s); }); }
async function loadBanks() {
  const have = new Set((ZK.banks || []).map((b) => b.file));
  const missing = (ZK.files || []).filter((f) => !have.has(f));
  await Promise.all(missing.map((f) => loadScript(`content/${f}.js`)));
  for (const b of ZK.banks) {
    for (const p of b.passages || []) { C.passageById[p.id] = { ...p, qs: [] }; (C.passages[p.module] ||= []).push(C.passageById[p.id]); }
  }
  for (const b of ZK.banks) for (const it of b.items || []) {
    if (!C.mod[it.module]) continue;
    C.byId[it.id] = it;
    const kps = (C.kp[it.module] ||= []);
    if (it.kp && !kps.includes(it.kp)) kps.push(it.kp);
    if (it.passage && C.passageById[it.passage]) C.passageById[it.passage].qs.push(it);
    else ((C.items[it.module] ||= {})[it.level] ||= []).push(it);
  }
}
const modReady = (id) => (C.mod[id].kind === "passage" ? (C.passages[id] || []).some((p) => p.qs.length) : Object.keys(C.items[id] || {}).length > 0);
const modMinutes = (id) => (C.mod[id].kind === "passage" ? (C.mod[id].listen ? 10 : 14) : 9);

// ---------------------------------------------------------------- 学生数据（本机）
const SKEY = "zk.student.v1";
let L = null;
function freshStudent(name) { return { v: 1, sid: randomId(10), name, createdAt: Date.now(), results: {}, history: [], misses: [], seen: {}, settings: { rate: 0.9, voice: "" } }; }
function ensureStudent(l) {
  if (!l || typeof l !== "object" || !l.sid) return null;
  l.results = l.results && typeof l.results === "object" ? l.results : {};
  for (const k of Object.keys(l.results)) if (!C.mod[k]) delete l.results[k];
  l.history = Array.isArray(l.history) ? l.history.slice(0, 300) : [];
  l.misses = Array.isArray(l.misses) ? l.misses.slice(0, 400) : [];
  l.seen = l.seen && typeof l.seen === "object" ? l.seen : {};
  l.settings = Object.assign({ rate: 0.9, voice: "" }, l.settings || {});
  return l;
}
const saveStudent = () => writeJSON(SKEY, L);

// ---------------------------------------------------------------- 家长数据（本机）
const PKEY = "zk.parent.v1";
let P = readJSON(PKEY) || { students: {}, manual: {}, current: "" };
P.students ||= {}; P.manual ||= {};
const saveParent = () => writeJSON(PKEY, P);
// 把一条成绩记录（成绩码或云端拉取的 payload）并入家长数据。返回 true 新记录，false 已有，null 无法识别。
function mergeRecord(p) {
  if (!p || p.v !== 1 || typeof p.s !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(p.s) || ["__proto__", "constructor", "prototype"].includes(p.s) || !Array.isArray(p.r)) return null;
  const fresh = (at) => (+at || +p.t || 0) >= RESET;
  p = { ...p, r: p.r.filter((r) => Array.isArray(r) && fresh(r[4])), m: Array.isArray(p.m) ? p.m.filter((x) => Array.isArray(x) && fresh(x[2])) : [] };
  if (!p.r.length && !p.m.length && (+p.t || 0) < RESET) return false;
  const st = Object.prototype.hasOwnProperty.call(P.students, p.s) ? P.students[p.s] : (P.students[p.s] = { sid: p.s, name: p.n || "学生", results: {}, history: [], misses: [], keys: [] });
  st.name = p.n || st.name;
  const key = `${p.t}|${(p.r || []).map((r) => r[0]).join(",")}|${(p.m || []).length}`;
  if (st.keys.includes(key)) return false;
  st.keys.push(key); if (st.keys.length > 2000) st.keys = st.keys.slice(-2000);
  for (const r of p.r || []) {
    const [mod, level, right, n, at, sec] = r;
    if (!C.mod[mod]) continue;
    const res = { level: clamp(+level || 0, 0, 4), right: +right || 0, n: +n || 0, at: +at || p.t, sec: +sec || 0 };
    if (!st.results[mod] || st.results[mod].at <= res.at) st.results[mod] = res;
    if (!st.history.some((h) => h.mod === mod && h.at === res.at)) st.history.push({ mod, ...res });
  }
  for (const [id, g, at] of p.m || []) if (!st.misses.some((x) => x.id === id && x.at === at)) st.misses.push({ id, g, at });
  st.history.sort((a, b) => b.at - a.at); st.misses.sort((a, b) => b.at - a.at);
  st.misses = st.misses.slice(0, 600);
  st.updatedAt = Math.max(st.updatedAt || 0, p.t || 0);
  return true;
}

// 学生本机的完整成绩，做成一条“汇总成绩码”。
function summaryPayload(l) {
  return { v: 1, s: l.sid, n: l.name, t: Date.now(),
    r: Object.entries(l.results).map(([mod, r]) => [mod, r.level, r.right, r.n, r.at, r.sec || 0]),
    m: l.misses.slice(0, 80).map((x) => [x.id, x.g, x.at]) };
}

// ---------------------------------------------------------------- 朗读（英语听力）
const TTS = {
  ok: typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance !== "undefined",
  broken: false, voices: [], voice: null, speaking: false, token: 0,
  init() {
    if (!this.ok) return;
    const load = () => { try { this.voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)); } catch (e) { this.voices = []; } this.pick(); };
    load();
    try { speechSynthesis.addEventListener("voiceschanged", () => { load(); if (!RUN) route(); }); } catch (e) {}
  },
  pick() { const pref = L && L.settings.voice; this.voice = this.voices.find((v) => v.name === pref) || this.voices.find((v) => /en[-_]US/i.test(v.lang)) || this.voices.find((v) => /en[-_]GB/i.test(v.lang)) || this.voices[0] || null; },
  get usable() { return this.ok && !this.broken && !!this.voice; },
  speak(text, { onend, onfail } = {}) {
    if (!this.usable) { onfail ? onfail() : onend && onend(); return; }
    speechSynthesis.cancel();
    const flat = plain(text).replace(/\s*\n+\s*/g, " ");
    const parts = flat.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [flat];
    const chunks = []; let cur = "";
    for (const s of parts) { if ((cur + s).length > 180 && cur) { chunks.push(cur); cur = s; } else cur += s; }
    if (cur.trim()) chunks.push(cur);
    const token = ++this.token; let i = 0, started = false;
    this.speaking = true;
    const fail = () => { clearTimeout(watchdog); this.broken = true; this.speaking = false; onfail ? onfail() : onend && onend(); };
    const watchdog = setTimeout(() => { if (!started && token === this.token) { this.stop(); fail(); } }, 4000);
    const next = () => {
      if (token !== this.token) return;
      if (i >= chunks.length) { this.speaking = false; clearTimeout(watchdog); if (!started) fail(); else onend && onend(); return; }
      // 对话里的 "M:" "W:" 标签不读出来，换说话人时停顿一下。
      const u = new SpeechSynthesisUtterance(chunks[i++].replace(/\b[MW]:\s*/g, ". "));
      u.voice = this.voice; u.lang = this.voice.lang; u.rate = (L && L.settings.rate) || 0.9;
      u.onstart = () => { started = true; };
      u.onend = next;
      u.onerror = (ev) => { if (ev.error === "interrupted" || ev.error === "canceled" || token !== this.token) return; if (!started) fail(); else next(); };
      speechSynthesis.speak(u);
    };
    next();
  },
  stop() { this.token++; this.speaking = false; if (this.ok) try { speechSynthesis.cancel(); } catch (e) {} },
};

// ---------------------------------------------------------------- 自适应诊断
// 选择题模块：从中档（或上次的层级）开始，每级 3 题，答对 2 题及以上升一级，否则降一级，同一级不重测。
// 达到的层级 = 通过（≥2/3）的最高层级，且所有更低的已测层级至少对一半。
function levelReached(res) {
  const lv = Object.keys(res).map(Number).sort((a, b) => a - b);
  const acc = (x) => res[x].filter(Boolean).length / res[x].length;
  let H = 0;
  for (const x of lv) if (acc(x) >= 0.66 && lv.filter((y) => y < x).every((y) => acc(y) >= 0.5)) H = x;
  if (!H && lv.length && lv[0] > 1 && acc(lv[0]) >= 0.5) H = lv[0] - 1;
  return H;
}
function pickItems(mod, level, k, r) {
  const pool = (C.items[mod] || {})[level] || [];
  return shuffle(pool, r).sort((a, b) => (L.seen[a.id] || 0) - (L.seen[b.id] || 0)).slice(0, k);
}
function itemSection(mod, r) {
  const prev = L.results[mod];
  const PER = 3;
  const st = { L: clamp(prev && prev.level ? prev.level : 2, 1, 4), res: {}, steps: 0, queue: [] };
  st.queue = pickItems(mod, st.L, PER, r);
  return { kind: "items", mod, results: [],
    next() {
      while (!st.queue.length) {
        const lv = st.L, got = st.res[lv] || [], a = got.filter(Boolean).length, n = got.length;
        st.steps++;
        let done = n === 0 || st.steps >= 4;
        if (!done) {
          if (a / n >= 0.66) { if (lv === 4 || st.res[lv + 1]) done = true; else st.L = lv + 1; }
          else { if (lv === 1 || st.res[lv - 1]) done = true; else st.L = lv - 1; }
        }
        if (done) return null;
        st.queue = pickItems(mod, st.L, PER, r);
        if (!st.queue.length) return null;
      }
      return { item: st.queue.shift() };
    },
    onAnswer(it, ok) { (st.res[it.level] ||= []).push(ok); },
    result() { return levelReached(st.res); },
  };
}
// 阅读类模块：选两篇（优先没做过的），做完全部小题。每篇的小题本身有难度梯度。
// 层级 = 从 1 级往上，各级累计正确率不低于一半的最高层级。
function passageLevel(res) {
  // 某一级没有题（两篇都没出到这一级）时跳过，不挡也不算通过。
  let H = 0;
  for (let x = 1; x <= 4; x++) {
    const got = res[x];
    if (!got || !got.length) continue;
    if (got.filter(Boolean).length / got.length >= 0.5) H = x; else break;
  }
  return H;
}
function passageSection(mod, r) {
  const list = shuffle((C.passages[mod] || []).filter((p) => p.qs.length), r).sort((a, b) => (L.seen[a.id] || 0) - (L.seen[b.id] || 0));
  const chosen = list.slice(0, 2);
  const queue = [];
  for (const p of chosen) p.qs.slice().sort((a, b) => a.level - b.level).forEach((q, i) => queue.push({ item: q, passage: p, first: i === 0 }));
  const res = {};
  return { kind: "passage", mod, results: [], listen: !!C.mod[mod].listen, passages: chosen,
    next() { return queue.shift() || null; },
    onAnswer(it, ok) { (res[it.level] ||= []).push(ok); },
    result() { return passageLevel(res); },
  };
}

// ---------------------------------------------------------------- 作答流程
let RUN = null;
function startRun(modIds) {
  const queue = modIds.filter((id) => C.mod[id] && modReady(id));
  if (!queue.length) return;
  TTS.stop();
  RUN = { queue, qi: -1, r: rng(seedFor(randomId(8))), block: null, stage: null, cur: null, done: [], misses: [], startedAt: Date.now(), sync: "" };
  location.hash = "test";
  nextModule();
}
function nextModule() {
  RUN.qi++; RUN.cur = null; RUN.pending = null;
  if (RUN.qi >= RUN.queue.length) { RUN.stage = "rundone"; RUN.endedAt = Date.now(); render(); return; }
  const mod = RUN.queue[RUN.qi];
  RUN.block = C.mod[mod].kind === "passage" ? passageSection(mod, RUN.r) : itemSection(mod, RUN.r);
  RUN.block.startedAt = Date.now(); RUN.block.misses = [];
  RUN.stage = "intro";
  render();
}
function advance() {
  const b = RUN.block;
  const nx = b.next();
  if (!nx) { finishModule(); return; }
  if (b.listen && nx.first) { RUN.pending = nx; RUN.stage = "listen"; RUN.plays = 0; RUN.showText = false; return; }
  showItem(nx);
}
function showItem(nx) {
  const it = nx.item;
  const r = rng(seedFor(it.id + RUN.startedAt));
  const order = it.fixed ? [0, 1, 2, 3] : shuffle([0, 1, 2, 3], r);
  RUN.cur = { ...nx, order, chosen: null, answered: false, ok: null, shownAt: Date.now() };
  RUN.stage = "item";
}
function check() {
  const cur = RUN.cur;
  if (!cur || cur.answered || cur.chosen == null) return;
  const it = cur.item, b = RUN.block;
  const ok = cur.chosen === it.answer;
  TTS.stop();
  cur.answered = true; cur.ok = ok;
  b.onAnswer(it, ok); b.results.push(ok);
  L.seen[it.id] = (L.seen[it.id] || 0) + 1;
  if (cur.passage && cur.first) L.seen[cur.passage.id] = (L.seen[cur.passage.id] || 0) + 1;
  if (!ok) {
    const miss = { id: it.id, g: cur.chosen, at: Date.now() };
    L.misses.unshift(miss); L.misses.length = Math.min(L.misses.length, 400);
    b.misses.push(miss); RUN.misses.push(miss);
  }
  saveStudent();
  RUN.answeredAt = Date.now();
  render();
}
function finishModule() {
  const b = RUN.block;
  const level = b.result();
  const right = b.results.filter(Boolean).length, n = b.results.length;
  const sec = Math.round((Date.now() - b.startedAt) / 1000);
  const res = { level, right, n, at: Date.now(), sec, grownup: RUN.grownup || undefined };
  L.results[b.mod] = res;
  L.history.unshift({ mod: b.mod, ...res });
  saveStudent();
  RUN.done.push({ mod: b.mod, ...res, misses: b.misses.slice() });
  RUN.stage = "moddone";
  RUN.answeredAt = Date.now();
  // 有云同步时，每完成一个模块就上传一次。
  if (Cloud.enabled) {
    const payload = { v: 1, s: L.sid, n: L.name, t: res.at, r: [[b.mod, level, right, n, res.at, sec]], m: b.misses.map((x) => [x.id, x.g, x.at]) };
    RUN.sync = "正在上传……";
    Cloud.push(payload).then((ok) => { if (!RUN) return; RUN.sync = ok ? "已同步到家长" : "暂时没连上云端，下次打开网站会自动重发；着急的话把成绩码发给家长"; if (RUN.stage === "moddone" || RUN.stage === "rundone") render(); });
  }
}
function runPayload() {
  return { v: 1, s: L.sid, n: L.name, t: RUN.endedAt || Date.now(),
    r: RUN.done.map((d) => [d.mod, d.level, d.right, d.n, d.at, d.sec]),
    m: RUN.misses.map((x) => [x.id, x.g, x.at]) };
}
function exitRun() {
  TTS.stop();
  RUN = null; location.hash = "home"; route();
}

// ---------------------------------------------------------------- 估分与提分建议（学生本机和家长页共用）
function manualFor(sid) { return (P.manual[sid] ||= {}); }
// 没测的模块、没填的手填项一律按 0 分计，总分随测试和填写逐步增加。
const blank = (v) => v == null || v === "";
function predict(results, manual) {
  const subjects = ZK.subjects.map((s) => {
    let sum = 0, tested = 0, assumed = 0;
    const mods = s.modules.map((m) => {
      const r = results[m.id];
      const lvl = r ? r.level : null;
      const pts = r ? m.pts * SHARE[lvl] : 0;
      if (r) tested += m.pts; else assumed += m.pts;
      sum += pts;
      return { m, r, pts };
    });
    const man = s.manual.map((x) => {
      const v = manual[x.id];
      return { ...x, value: blank(v) ? null : +v };
    });
    for (const x of man) sum += clamp(+x.value || 0, 0, x.pts);
    return { s, mods, man, pred: sum, tested, assumed };
  });
  const extras = ZK.exam.extras.map((x) => {
    const v = manual[x.id];
    return { ...x, value: blank(v) ? null : +v };
  });
  const testedPts = subjects.reduce((a, x) => a + x.tested, 0);
  const allPts = subjects.reduce((a, x) => a + x.tested + x.assumed, 0);
  const unfilled = [...subjects.flatMap((x) => x.man.filter((m) => m.value == null).map((m) => x.s.name + m.name)), ...extras.filter((x) => x.value == null).map((x) => x.name)];
  const total = subjects.reduce((a, x) => a + x.pred, 0) + extras.reduce((a, x) => a + (x.value == null ? 0 : clamp(+x.value, 0, x.full)), 0);
  return { subjects, extras, total, coverage: allPts ? testedPts / allPts : 0, unfilled };
}
function priorities(results, misses) {
  const out = [];
  for (const [id, r] of Object.entries(results)) {
    const m = C.mod[id];
    if (!m || r.level >= 4) continue;
    const gain = m.pts * (SHARE[r.level + 1] - SHARE[r.level]);
    const kps = {};
    for (const x of misses) { const it = C.byId[x.id]; if (it && it.module === id) kps[it.kp] = (kps[it.kp] || 0) + 1; }
    out.push({ id, m, r, gain, kps: Object.entries(kps).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k) });
  }
  return out.sort((a, b) => b.gain - a.gain);
}
function weakKps(misses) {
  const k = {};
  for (const x of misses) { const it = C.byId[x.id]; if (!it) continue; const key = it.module + "|" + it.kp; (k[key] ||= { kp: it.kp, mod: it.module, n: 0 }).n++; }
  return Object.values(k).sort((a, b) => b.n - a.n);
}

// ---------------------------------------------------------------- 视图片段
function cellsHTML(level) {
  return `<span class="cells" aria-label="${level == null ? "未测" : levelName(level)}">${[1, 2, 3, 4].map((n) => `<i class="${level != null && n <= level ? "on" : ""}"></i>`).join("")}</span>`;
}
const cellsLegend = () => `<span class="cells-legend" aria-hidden="true">${LV.map((l) => `<span>${esc(l.name)}</span>`).join("")}</span>`;
function levelPill(level) {
  if (level == null) return `<span class="pill">未测</span>`;
  const cls = level >= 4 ? "good" : level >= 3 ? "good" : level >= 2 ? "warn" : "bad";
  return `<span class="pill ${cls}">${esc(levelName(level))}</span>`;
}
function codeBlock(code, id) {
  return `<div class="stack" style="gap:8px"><div class="code-box" id="${id}">${esc(code)}</div>
    <div class="row"><button class="btn primary" data-action="copy" data-target="${id}">复制成绩码</button><span class="muted small" id="${id}-msg">复制后在微信里发给家长。</span></div></div>`;
}
function itemReviewHTML(miss, opts = {}) {
  const it = C.byId[miss.id];
  if (!it) return "";
  const m = C.mod[it.module];
  const p = it.passage ? C.passageById[it.passage] : null;
  const given = miss.g != null && it.choices[miss.g] != null ? it.choices[miss.g] : "（未记录）";
  return `<li><span class="eyebrow">${esc(C.subj[m.subject].name)} · ${esc(m.name)} · ${esc(LV[it.level - 1].name)} · ${esc(it.kp)}${opts.date ? ` · ${fmtDate(miss.at)}` : ""}</span>
    ${p ? `<span class="muted small">出自《${esc(p.title)}》</span>` : ""}
    ${it.stem ? `<div class="q-stem small">${md(it.stem)}</div>` : ""}
    ${it.svg ? `<div class="q-fig" style="max-width:280px">${it.svg}</div>` : ""}
    <div><strong>${inline(it.prompt)}</strong></div>
    <div class="ans"><span class="muted">他的答案：</span><span style="color:var(--bad)">${inline(given)}</span>　<span class="muted">正确答案：</span><strong style="color:var(--good)">${inline(it.choices[it.answer])}</strong></div>
    <div class="why">${inline(it.explain)}</div></li>`;
}

// ---------------------------------------------------------------- 页面：首页（学生）
function renderLogin() {
  $("#view").innerHTML = `<section class="hello"><p class="eyebrow">赤峰中考 · 2027</p><h1>中考诊断台</h1>
    <p class="lede">按中考的模块逐一诊断：每个模块从中档题开始，答得好就升一级，答错就降一级，几分钟内定位到“基础 / 中档 / 较难 / 压轴”中的一级。做完把成绩码发给家长，家长就能看到估分和该补哪里。</p></section>
    <form class="sheet stack" id="login" style="max-width:520px">
      <h2>先写上名字</h2>
      <div class="field"><label for="login-name">姓名（只保存在这台设备上）</label><input id="login-name" maxlength="20" autocomplete="off" required></div>
      <div class="row"><button class="btn primary big" type="submit">开始</button></div>
      <p class="muted small">已经在别的设备上做过？没关系，家长页会把同一个名字的成绩合在一起看。</p>
    </form>`;
}
function renderHome() {
  if (!L) return renderLogin();
  const anyReady = ZK.subjects.some((s) => s.modules.some((m) => modReady(m.id)));
  const done = Object.keys(L.results).length;
  const totalMods = ZK.subjects.reduce((a, s) => a + s.modules.length, 0);
  $("#view").innerHTML = `<section class="hello"><p class="eyebrow">${esc(L.name)} · 已测 ${done} / ${totalMods} 个模块</p><h1>选一个模块开始</h1>
    <p class="lede">每个模块约 8–15 分钟。可以一次做一个模块，也可以点“整科诊断”把一科做完。遇到不会的题认真想，不要乱猜，这样诊断才准。</p>
    ${!anyReady ? `<p class="notice warn">题库还没有加载出来。请检查网络后刷新页面。</p>` : ""}</section>
    <div class="stack">${ZK.subjects.map((s) => {
      const ready = s.modules.filter((m) => modReady(m.id));
      const mins = ready.reduce((a, m) => a + modMinutes(m.id), 0);
      return `<article class="sheet subj" style="--subj:var(${s.color})"><div class="subj-head"><h2>${esc(s.name)}</h2>
        <div class="row">${ready.length ? `<button class="btn small" data-action="subject" data-subject="${s.id}">整科诊断 · 约 ${mins} 分钟</button>` : `<span class="muted small">题库准备中</span>`}</div></div>
        <ul class="mods">${s.modules.map((m) => {
          const r = L.results[m.id], rdy = modReady(m.id);
          return `<li class="mod"><div><div class="nm">${esc(m.name)}</div></div>${cellsHTML(r ? r.level : null)}
            <div class="act">${rdy ? `<button class="btn small ${r ? "quiet" : ""}" data-action="module" data-mod="${m.id}">${r ? "重测" : "开始"}</button>` : `<span class="muted small">准备中</span>`}</div>
            <div class="sub">${r ? `${esc(levelName(r.level))} · ${r.right}/${r.n} 题 · ${fmtDate(r.at)}` : esc(m.about)}</div></li>`;
        }).join("")}</ul>
        ${s.manual.length ? `<p class="muted small" style="margin-top:8px">网站测不了：${s.manual.map((x) => `${esc(x.name)}（${x.pts} 分）`).join("、")}，由家长在家长页填写。</p>` : ""}
      </article>`;
    }).join("")}</div>
    <p class="muted small" style="margin-top:18px">格子从左到右是：基础、中档、较难、压轴。涂满的格子越多，说明这个模块越扎实。</p>`;
}

// ---------------------------------------------------------------- 页面：作答
function headHTML() {
  const b = RUN.block, m = C.mod[b.mod];
  const steps = b.results.map((x) => `<i class="${x ? "ok" : "no"}"></i>`).join("");
  return `<div class="run-head"><div class="title"><span class="eyebrow">${esc(C.subj[m.subject].name)} · 第 ${RUN.qi + 1} / ${RUN.queue.length} 个模块</span><strong>${esc(m.name)}</strong></div>
    <div class="steps" aria-hidden="true">${steps}</div><button class="btn quiet small" data-action="exit-ask">退出</button></div>`;
}
function render() {
  if (!RUN) return route();
  const v = $("#view");
  if (RUN.confirmExit) {
    v.innerHTML = `<div class="sheet confirm stack" style="max-width:560px"><h2>现在退出？</h2><p>已经做完的模块都保存了。正在做的这个模块下次需要重新开始。</p>
      <div class="row"><button class="btn primary" data-action="exit-stay">继续做</button><button class="btn" data-action="exit-yes">退出</button></div></div>`;
    return;
  }
  if (RUN.stage === "rundone") return renderRunDone();
  const b = RUN.block, m = C.mod[b.mod];
  if (RUN.stage === "intro") {
    const listenNoVoice = b.listen && !TTS.usable;
    v.innerHTML = headHTML() + `<div class="sheet stack" style="max-width:660px"><h2>${esc(m.name)}</h2><p>${esc(m.about)}</p>
      <p class="muted">${b.kind === "passage" ? `共 ${b.passages.length} 篇${b.listen ? "听力材料" : "文章"}，每篇有几道小题，难度由浅入深。` : "题目会根据你的作答自动调整难度：答得好会变难，答错会变简单。"}约 ${modMinutes(b.mod)} 分钟。</p>
      ${listenNoVoice ? `<p class="notice warn">这台设备没有英文朗读语音。可以请家长照着屏幕上的原文读给你听，或者换一台设备（苹果手机、电脑一般都有）。</p>` : ""}
      <div class="row"><button class="btn primary big" data-action="begin" id="go">开始</button>${listenNoVoice ? `<button class="btn quiet" data-action="skip-module">跳过这个模块</button>` : ""}</div></div>`;
    return;
  }
  if (RUN.stage === "listen") {
    const p = RUN.pending.passage, can = TTS.usable;
    v.innerHTML = headHTML() + `<div class="sheet stack" style="max-width:680px"><p class="eyebrow">听力</p><h2>${esc(p.title)}</h2>
      ${can ? `<p>认真听，听完后回答问题（答题时看不到原文）。最多可以听两遍。</p><div class="wave ${TTS.speaking ? "on" : ""}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="row">${TTS.speaking ? `<button class="btn" data-action="stop-audio">停止</button>` : RUN.plays < 2 ? `<button class="btn primary big" data-action="play">${RUN.plays ? "再听一遍" : "播放"}</button>` : `<span class="muted">已经听过两遍</span>`}</div>`
      : `<div class="notice warn stack" style="gap:8px"><strong>请家长朗读</strong>${RUN.showText ? `<div class="passage en" lang="en">${md(p.text)}</div><div><button class="btn small" data-action="hide-text">收起原文</button></div>` : `<p>不要让学生看屏幕，用正常语速读一遍。</p><div><button class="btn small" data-action="show-text">显示原文</button></div>`}</div>`}
      <div class="row"><button class="btn ${RUN.plays || !can ? "primary" : ""}" data-action="to-questions" ${RUN.plays || !can ? "" : "disabled"}>开始答题</button></div></div>`;
    return;
  }
  if (RUN.stage === "moddone") return renderModDone();
  const cur = RUN.cur; if (!cur) return;
  const it = cur.item;
  const isEn = m.subject === "yy";
  const showPassage = cur.passage && !b.listen;
  let q = `<div class="qcard"><div class="q-meta"><span>第 ${b.results.length + (cur.answered ? 0 : 1)} 题</span>${cur.answered ? `<span>· ${esc(it.kp)}</span>` : ""}</div>`;
  if (it.stem) q += `<div class="q-stem"${isEn ? ' lang="en"' : ""}>${md(it.stem)}</div>`;
  if (it.svg) q += `<div class="q-fig">${it.svg}</div>`;
  q += `<p class="q-prompt"${isEn && /[a-z]{3}/i.test(it.prompt) ? ' lang="en"' : ""}>${inline(it.prompt)}</p>
    <div class="choices" role="group" aria-label="选项">${cur.order.map((ci, k) => {
      let cls = "";
      if (cur.answered) cls = ci === it.answer ? "right" : ci === cur.chosen ? "wrong" : "";
      return `<button class="choice ${cls}" data-action="choose" data-ci="${ci}" aria-pressed="${cur.chosen === ci}" ${cur.answered ? "disabled" : ""}><span class="bub">[${LETTERS[k]}]</span><span${isEn ? ' lang="en"' : ""}>${inline(it.choices[ci])}</span></button>`;
    }).join("")}</div>`;
  if (cur.answered) {
    q += `<div class="feedback ${cur.ok ? "ok" : "no"}" role="status"><span class="verdict">${cur.ok ? "✓ 正确" : "✗ 不对"}</span>
      ${!cur.ok ? `<p>正确答案：<strong>${inline(it.choices[it.answer])}</strong></p><p class="muted small">解析会在这个模块做完后统一显示。</p>` : ""}</div>`;
  }
  q += `<div class="q-actions"><span></span>${cur.answered ? `<button class="btn primary big" data-action="next" id="go">下一题</button>` : `<button class="btn primary big" data-action="check" id="go" ${cur.chosen == null ? "disabled" : ""}>确定</button>`}</div></div>`;
  let ptext = showPassage ? cur.passage.text : "";
  if (showPassage && cur.answered && it.evidence && ptext.includes(it.evidence)) ptext = ptext.replace(it.evidence, "\u0001" + it.evidence + "\u0002");
  const oldCol = $(".passage-col"), keep = oldCol && RUN.lastPassage === (cur.passage && cur.passage.id) ? oldCol.scrollTop : 0;
  RUN.lastPassage = cur.passage && cur.passage.id;
  v.innerHTML = headHTML() + (showPassage
    ? `<div class="run-body has-passage"><div class="passage-col sheet"><article class="passage${isEn ? " en" : ""}"${isEn ? ' lang="en"' : ""}><h3>${esc(cur.passage.title)}</h3>${md(ptext)}</article></div>${q}</div>`
    : `<div class="run-body">${q}</div>`);
  const col = $(".passage-col"); if (col && keep) col.scrollTop = keep;
  if (cur.answered) { const go = $("#go"); go && go.focus({ preventScroll: true }); }
}
function renderModDone() {
  const d = RUN.done[RUN.done.length - 1], m = C.mod[d.mod];
  const last = RUN.qi + 1 >= RUN.queue.length;
  $("#view").innerHTML = headHTML() + `<div class="grid2"><div class="sheet stack">
      <p class="eyebrow">模块完成</p><h2>${esc(m.name)}：${esc(levelName(d.level))}</h2>
      <div class="row">${cellsHTML(d.level)} <span class="muted">${d.right} / ${d.n} 题正确 · 用时 ${Math.max(1, Math.round(d.sec / 60))} 分钟</span></div>
      <p class="muted">${d.level >= 1 ? esc(LV[d.level - 1].can) : "这个模块的基础题还需要先补上。"}</p>
      ${RUN.sync ? `<p class="notice">${esc(RUN.sync)}</p>` : ""}
      <div class="row"><button class="btn primary big" data-action="next-module" id="go">${last ? "完成，查看成绩码" : "下一个模块"}</button></div>
    </div>
    <div class="sheet"><header><h3>本模块错题解析</h3><span class="muted small">${d.misses.length} 道</span></header>
      ${d.misses.length ? `<ul class="review">${d.misses.map((x) => itemReviewHTML(x)).join("")}</ul>` : `<p class="muted">全部答对。</p>`}</div></div>`;
  const go = $("#go"); go && go.focus({ preventScroll: true });
}
function renderRunDone() {
  const code = Code.make(runPayload());
  $("#view").innerHTML = `<section class="hello"><p class="eyebrow">本次诊断完成</p><h1>把成绩码发给家长</h1>
    <p class="lede">成绩已经保存在这台设备上。${Cloud.enabled ? "如果下面显示“已同步到家长”，家长那边已经能看到；否则请复制成绩码发过去。" : "复制下面这段成绩码，在微信里发给家长，家长打开“家长”页粘贴即可。"}</p></section>
    <div class="grid2"><div class="sheet stack"><h2>成绩码</h2>${codeBlock(code, "run-code")}
      ${RUN.sync ? `<p class="notice">${esc(RUN.sync)}</p>` : ""}</div>
    <div class="sheet"><header><h3>本次结果</h3></header><ul class="mods">${RUN.done.map((d) => `<li class="mod"><div class="nm">${esc(C.mod[d.mod].name)}</div>${cellsHTML(d.level)}<span class="act muted small">${d.right}/${d.n}</span></li>`).join("")}</ul>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-action="home">回到首页</button><a class="btn quiet" href="#me">我的结果</a></div></div></div>`;
}

// ---------------------------------------------------------------- 页面：报告（我的结果 / 家长）
// 知识树：科目 → 模块 → 知识点。模块按达到的层级着色并标出失分，知识点按错题标红。
// 最近一次诊断里做错的知识点为红色，更早做错、最近没再错的为黄色；没出现错题的为灰色（不代表已经掌握，可能还没考到）。
function treeHTML(st, pr) {
  const recentMiss = (r, x) => r && x.at <= r.at + 5000 && x.at >= r.at - ((r.sec || 0) + 5) * 1000;
  const subjects = pr.subjects.map((x) => {
    const mods = x.mods.map(({ m, r, pts }) => {
      const hits = dict();
      for (const ms of st.misses) {
        const it = C.byId[ms.id];
        if (!it || it.module !== m.id || !it.kp) continue;
        const h = (hits[it.kp] ||= { recent: 0, old: 0 });
        if (recentMiss(r, ms)) h.recent++; else h.old++;
      }
      const all = C.kp[m.id] || [];
      const missed = all.filter((k) => hits[k]).sort((a, b) => hits[b].recent - hits[a].recent || hits[b].old - hits[a].old);
      return { m, r, pts, lost: m.pts - pts, hits, missed, quiet: all.filter((k) => !hits[k]) };
    });
    const man = x.man.map((mm) => ({ ...mm, lost: mm.value == null ? null : mm.pts - clamp(+mm.value || 0, 0, mm.pts) }));
    // lost 只算已测、已填部分的失分；没测、没填的分值单独记为 open，图上用斜纹表示。
    const lost = mods.reduce((a, d) => a + (d.r ? d.lost : 0), 0) + man.reduce((a, d) => a + (d.lost || 0), 0);
    const open = mods.reduce((a, d) => a + (d.r ? 0 : d.m.pts), 0) + man.reduce((a, d) => a + (d.lost == null ? d.pts : 0), 0);
    return { ...x, mods, man, lost, open, anyTested: mods.some((d) => d.r) };
  });
  const open = new Set(subjects.filter((x) => x.anyTested).sort((a, b) => b.lost - a.lost).slice(0, 2).map((x) => x.s.id));
  const lvClass = (r) => (r == null ? "lv-n" : r.level >= 3 ? "lv-good" : r.level === 2 ? "lv-mid" : "lv-bad");
  const pct = (x, full) => Math.round(clamp(x / full, 0, 1) * 100);
  const bar = (lost, full, open = 0) => `<span class="lostbar" aria-hidden="true"><b style="width:${pct(lost, full)}%"></b>${open ? `<i style="width:${pct(open, full)}%"></i>` : ""}</span>`;
  const kpChip = (k, h) => `<span class="kp ${h.recent ? "hot" : "old"}">${esc(k)}${h.recent + h.old > 1 ? ` ×${h.recent + h.old}` : ""}</span>`;
  return `<article class="sheet stack"><header><h2>知识树</h2><span class="muted small">科目 → 模块 → 知识点，看清失分在哪里</span></header>
    <div class="tree-legend"><span><i class="sw lv-bad"></i>基础及以下</span><span><i class="sw lv-mid"></i>中档</span><span><i class="sw lv-good"></i>较难、压轴</span><span><i class="sw lv-n"></i>未测</span>
      <span><i class="sw kp-hot"></i>最近做错的知识点</span><span><i class="sw kp-old"></i>以前错过</span><span class="muted">红条越长，失分越多；灰色斜纹为还没测、没填的分值（按 0 分计）</span></div>
    ${subjects.map((x) => `<details class="ktree" style="--subj:var(${x.s.color})" ${open.has(x.s.id) ? "open" : ""}>
      <summary><span class="kname">${esc(x.s.name)}</span>${bar(x.lost, x.s.full, x.open)}<span class="num small">预估 ${Math.round(x.pred)} / ${x.s.full} · 失 ${Math.round(x.lost)}${x.open ? ` · 未测 ${Math.round(x.open)}` : ""}</span></summary>
      <ul class="tree">${x.mods.map((d) => `<li><div class="tnode ${lvClass(d.r)}">
          <div class="tn-name"><strong>${esc(d.m.name)}</strong> ${levelPill(d.r ? d.r.level : null)}</div>
          <span class="num small">${d.r ? `失 ${round1(d.lost)}` : "未测"} / ${d.m.pts}</span>
          ${d.r ? bar(d.lost, d.m.pts) : bar(0, d.m.pts, d.m.pts)}
          <div class="muted small">${d.r ? `${d.r.right}/${d.r.n} 题 · ${fmtDate(d.r.at)}` : "未测，暂按 0 分计"}</div>
        </div>
        ${d.missed.length || d.quiet.length ? `<div class="kpleaves">${d.missed.map((k) => kpChip(k, d.hits[k])).join("")}
          ${d.quiet.length ? `<details class="kp-more"><summary>${d.missed.length ? "其他" : "全部"} ${d.quiet.length} 个知识点${d.r ? "（暂未发现问题）" : ""}</summary><div class="kpleaves inner">${d.quiet.map((k) => `<span class="kp quiet">${esc(k)}</span>`).join("")}</div></details>` : ""}</div>` : ""}
      </li>`).join("")}
      ${x.man.map((mm) => `<li><div class="tnode lv-man"><div class="tn-name"><strong>${esc(mm.name)}</strong> <span class="pill">手填</span></div>
          <span class="num small">${mm.lost == null ? "未填" : `失 ${round1(mm.lost)}`} / ${mm.pts}</span>${mm.lost == null ? bar(0, mm.pts, mm.pts) : bar(mm.lost, mm.pts)}
          <div class="muted small">${mm.value == null ? "未填，暂按 0 分计，可在上面填写" : "家长填写"}</div></div></li>`).join("")}</ul>
    </details>`).join("")}
  </article>`;
}

function reportHTML(st, { parent }) {
  const manual = manualFor(st.sid);
  const pr = predict(st.results, manual);
  const pri = priorities(st.results, st.misses);
  const kps = weakKps(st.misses).slice(0, 14);
  const tested = Object.keys(st.results).length;
  const reach = ZK.exam.targets.map((t) => ({ ...t, gap: Math.round(pr.total - t.score) }));
  const filt = (VIEW.missSubject || "all");
  const misses = st.misses.filter((x) => { const it = C.byId[x.id]; return it && (filt === "all" || C.mod[it.module].subject === filt); }).slice(0, 60);
  return `<div class="stack">
    <div class="grid2">
      <article class="sheet stack"><p class="eyebrow">预估总分（满分 ${ZK.exam.total}）</p>
        <div class="row" style="align-items:baseline"><span class="score-big num">${Math.round(pr.total)}</span><span class="muted">已测 ${tested} 个模块，覆盖 ${Math.round(pr.coverage * 100)}% 的笔试分值</span></div>
        ${pr.coverage < 1 ? `<p class="notice warn">没测的模块按 0 分计，测得越多，总分越接近真实水平。</p>` : ""}
        ${pr.unfilled.length ? `<p class="notice warn">${esc(pr.unfilled.join("、"))}还没填，暂按 0 分计，请在下面填写实际成绩。</p>` : ""}
        <div class="ladder">${reach.map((t) => `<div class="rung ${t.gap >= 0 ? "reach" : ""}"><span>${esc(t.name)} <span class="muted small">${t.score} 分 · ${esc(t.note)}</span></span><span class="gap">${t.gap >= 0 ? `超出 ${t.gap}` : `差 ${-t.gap}`}</span></div>`).join("")}</div>
        <p class="muted small">估分方法：每个模块按达到的层级估计得分率（基础 55%、中档 75%、较难 90%、压轴 98%，未达基础 30%），再按中考分值加权；没测的模块和没填的部分按 0 分计。这是粗略估计，用来比较强弱和定目标，不等于考试分数。</p>
      </article>
      <article class="sheet stack"><h2>网站测不了的部分</h2>
        <p class="muted small">按实际情况填写；留空按 0 分计。</p>
        <div class="form-grid">${[...pr.subjects.flatMap((x) => x.man), ...pr.extras].map((x) => {
          const full = x.pts || x.full;
          return `<div class="field"><label for="man-${x.id}">${esc(x.name)}（满分 ${full}）</label>
            <input id="man-${x.id}" type="number" inputmode="decimal" min="0" max="${full}" step="0.5" data-change="manual" data-key="${x.id}" data-sid="${esc(st.sid)}"
              value="${manual[x.id] == null ? "" : esc(manual[x.id])}" placeholder="未填（按 0 分）"></div>`;
        }).join("")}</div>
        ${!parent ? `<p class="muted small">这些数字只保存在本机。</p>` : ""}
      </article>
    </div>

    <article class="sheet"><header><h2>先补这里</h2><span class="muted small">按“提升一个层级能多拿的分”排序</span></header>
      ${pri.length ? `<ol class="prio">${pri.slice(0, 8).map((x) => `<li><div><strong>${esc(C.subj[x.m.subject].name)} · ${esc(x.m.name)}</strong> ${levelPill(x.r.level)}
        <div class="muted small">${x.r.level < 4 ? `目标：${esc(LV[x.r.level].name)}。${esc(LV[x.r.level].can)}` : ""}</div>
        ${x.kps.length ? `<div class="kps" style="margin-top:6px">${x.kps.map((k) => `<span class="pill">${esc(k)}</span>`).join("")}</div>` : ""}</div>
        <span class="gain">+${round1(x.gain)} 分</span></li>`).join("")}</ol>` : `<p class="empty">做完几个模块后，这里会列出最值得先补的地方。</p>`}
    </article>

    ${treeHTML(st, pr)}

    <article class="sheet"><header><h2>薄弱知识点</h2><span class="muted small">按错题次数</span></header>
      ${kps.length ? `<div class="tablewrap"><table><thead><tr><th>知识点</th><th>科目 · 模块</th><th class="num">错题数</th></tr></thead><tbody>
        ${kps.map((k) => `<tr><td><strong>${esc(k.kp)}</strong></td><td>${esc(C.subj[C.mod[k.mod].subject].name)} · ${esc(C.mod[k.mod].name)}</td><td class="num num">${k.n}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="empty">还没有错题。</p>`}
    </article>

    <article class="sheet"><header><h2>错题与解析</h2>
      <div class="tabs" role="group" aria-label="按科目筛选"><button data-action="miss-filter" data-subject="all" aria-pressed="${filt === "all"}">全部</button>${ZK.subjects.map((s) => `<button data-action="miss-filter" data-subject="${s.id}" aria-pressed="${filt === s.id}">${esc(s.name)}</button>`).join("")}</div></header>
      ${misses.length ? `<ul class="review">${misses.map((x) => itemReviewHTML(x, { date: true })).join("")}</ul>` : `<p class="empty">这一科暂时没有错题。</p>`}
    </article>

    <article class="sheet"><header><h2>诊断记录</h2><span class="muted small">最近 40 次</span></header>
      ${st.history.length ? `<div class="tablewrap"><table><thead><tr><th>时间</th><th>科目</th><th>模块</th><th>层级</th><th class="num">正确</th><th class="num">用时</th></tr></thead><tbody>
        ${st.history.slice(0, 40).map((h) => { const m = C.mod[h.mod]; return m ? `<tr><td class="num">${fmtDateTime(h.at)}</td><td>${esc(C.subj[m.subject].name)}</td><td>${esc(m.name)}</td><td>${esc(levelName(h.level))}</td><td class="num">${h.right}/${h.n}</td><td class="num">${Math.max(1, Math.round((h.sec || 0) / 60))} 分</td></tr>` : ""; }).join("")}</tbody></table></div>`
      : `<p class="empty">还没有记录。</p>`}
    </article>
  </div>`;
}
const VIEW = { missSubject: "all", parentMsg: "", confirmDelete: "" };
function studentAsReport() { return { sid: L.sid, name: L.name, results: L.results, history: L.history, misses: L.misses }; }
function renderMe() {
  if (!L) return renderLogin();
  if (!Object.keys(L.results).length) { $("#view").innerHTML = `<section class="hello"><h1>我的结果</h1><p class="lede">还没有做过诊断。回到首页选一个模块开始吧。</p></section><a class="btn primary" href="#home">去首页</a>`; return; }
  const code = Code.make(summaryPayload(L));
  $("#view").innerHTML = `<section class="hello"><p class="eyebrow">${esc(L.name)}</p><h1>我的结果</h1></section>
    <article class="sheet stack" style="margin-bottom:18px"><header><h2>汇总成绩码</h2><span class="muted small">包含所有模块的最新结果和最近 80 道错题</span></header>${codeBlock(code, "sum-code")}</article>
    ${reportHTML(studentAsReport(), { parent: false })}`;
}
function renderParent() {
  const ids = Object.keys(P.students);
  if (L && !P.students[L.sid]) ids.unshift("local");
  if (!P.current || (P.current !== "local" && !P.students[P.current])) P.current = ids[0] || "";
  const st = P.current === "local" ? (L ? studentAsReport() : null) : P.students[P.current];
  $("#view").innerHTML = `<section class="hello"><p class="eyebrow">家长</p><h1>诊断报告</h1>
    <p class="lede">把孩子发来的成绩码粘贴到下面（一次可以粘贴多条，夹着别的文字也没关系）。数据保存在这台设备的浏览器里。</p></section>
    <div class="grid2" style="margin-bottom:18px">
      <article class="sheet stack"><h2>导入成绩码</h2>
        <textarea class="paste" id="paste" placeholder="ZK1-……" aria-label="粘贴成绩码"></textarea>
        <div class="row"><button class="btn primary" data-action="import">导入</button><span class="muted small" id="import-msg" role="status">${esc(VIEW.parentMsg)}</span></div>
      </article>
      <article class="sheet stack"><h2>${Cloud.enabled ? "云端同步" : "学生"}</h2>
        ${Cloud.enabled ? (P.cloudPass
          ? `<div class="row"><button class="btn primary" data-action="cloud-pull">拉取最新成绩</button><button class="btn quiet small" data-action="cloud-full">全部重新拉取</button><button class="btn quiet small" data-action="cloud-forget">忘记密码</button></div><span class="muted small" id="cloud-msg" role="status">${esc(VIEW.cloudMsg || "")}</span>`
          : `<form id="cloud-login" class="stack" style="gap:10px"><input type="text" autocomplete="username" value="家长" hidden aria-hidden="true"><div class="field"><label for="cl-pass">家长密码</label><input id="cl-pass" type="password" autocomplete="current-password"></div>
          <div class="row"><button class="btn" type="submit">拉取成绩</button><span class="muted small" id="cloud-msg" role="status"></span></div></form>`) : ""}
        ${ids.length ? `<div class="field"><label for="pick-student">查看</label><select id="pick-student" data-change="pick">${ids.map((id) => `<option value="${esc(id)}" ${P.current === id ? "selected" : ""}>${id === "local" ? `本机：${esc(L.name)}` : esc(P.students[id].name)}${id !== "local" && P.students[id].updatedAt ? `（更新于 ${fmtDate(P.students[id].updatedAt)}）` : ""}</option>`).join("")}</select></div>` : `<p class="muted">还没有导入任何成绩。</p>`}
        ${st && P.current !== "local" ? (VIEW.confirmDelete === P.current ? `<div class="notice stack" style="gap:8px"><span>删除 ${esc(st.name)} 在这台设备上的全部记录？此操作无法撤销。</span><div class="row"><button class="btn small" data-action="delete-yes">删除</button><button class="btn small primary" data-action="delete-no">保留</button></div></div>` : `<div><button class="btn quiet small" data-action="delete-ask">删除这个学生的记录…</button></div>`) : ""}
      </article>
    </div>
    ${st ? reportHTML(st, { parent: true }) : `<div class="empty">导入成绩码后，这里会显示估分、该先补的模块、薄弱知识点和全部错题解析。</div>`}`;
}
function renderSettings() {
  if (!L) return renderLogin();
  $("#view").innerHTML = `<section class="hello"><h1>设置</h1></section><div class="sheet stack" style="max-width:720px">
    <div class="form-grid">
      <div class="field"><label for="set-name">姓名</label><input id="set-name" data-change="name" value="${esc(L.name)}" maxlength="20"></div>
      ${TTS.voices.length ? `<div class="field"><label for="set-voice">英语朗读声音</label><select id="set-voice" data-change="voice"><option value="">自动</option>${TTS.voices.map((v) => `<option value="${esc(v.name)}" ${L.settings.voice === v.name ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("")}</select></div>` : ""}
      <div class="field"><label for="set-rate">朗读语速</label><select id="set-rate" data-change="rate">${[[0.8, "慢"], [0.9, "稍慢（接近中考）"], [1, "正常"]].map(([v, t]) => `<option value="${v}" ${L.settings.rate === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    </div>
    <div class="row"><button class="btn" data-action="test-voice">试听英语朗读</button>${!TTS.usable ? `<span class="muted small">这台设备没有英文语音，听力模块需要家长朗读。</span>` : ""}</div>
    <p class="muted small">学生编号：<span class="num">${esc(L.sid)}</span>（家长页用它区分不同设备上的记录）</p>
    ${VIEW.confirmReset ? `<div class="sheet confirm stack"><p>清除这台设备上的全部诊断记录？无法撤销。建议先在“我的结果”里把汇总成绩码发给家长。</p><div class="row"><button class="btn" data-action="reset-yes">清除</button><button class="btn primary" data-action="reset-no">保留</button></div></div>`
      : `<div><button class="btn quiet" data-action="reset-ask">清除本机记录…</button></div>`}
  </div>`;
}

// ---------------------------------------------------------------- 外壳与路由
app.innerHTML = `<header class="top"><div class="top-in"><a class="brand" href="#home">中考诊断台 <small>赤峰 · 2027</small></a>
  <nav class="nav" aria-label="主导航"><a href="#home" data-tab="home">诊断</a><a href="#me" data-tab="me">我的结果</a><a href="#parent" data-tab="parent">家长</a><a href="#settings" data-tab="settings">设置</a></nav></div></header>
  <main class="wrap" id="view"><p class="muted">正在加载题库……</p></main>`;
function route() {
  if (RUN) return render();
  const tab = (location.hash || "#home").slice(1) || "home";
  document.querySelectorAll(".nav a").forEach((a) => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (tab === "me") renderMe();
  else if (tab === "parent") renderParent();
  else if (tab === "settings") renderSettings();
  else renderHome();
}
window.addEventListener("hashchange", () => {
  if (RUN && RUN.stage === "rundone" && location.hash !== "#test") RUN = null;
  if (RUN && location.hash !== "#test") { RUN.confirmExit = true; location.hash = "test"; render(); return; } route(); window.scrollTo({ top: 0 }); });

async function copyFrom(id) {
  const el = document.getElementById(id), msg = document.getElementById(id + "-msg");
  if (!el) return;
  try { await navigator.clipboard.writeText(el.textContent); msg && (msg.textContent = "已复制，去微信粘贴发送。"); }
  catch (e) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); msg && (msg.textContent = "已选中，请长按或按 Ctrl+C 复制。"); }
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const act = a.dataset.action;
  if ((act === "next" || act === "next-module") && RUN && Date.now() - (RUN.answeredAt || 0) < 400) return;
  switch (act) {
    case "module": startRun([a.dataset.mod]); break;
    case "subject": startRun(C.subj[a.dataset.subject].modules.map((m) => m.id)); break;
    case "begin": RUN.grownup = RUN.block.listen && !TTS.usable; advance(); render(); window.scrollTo({ top: 0 }); break;
    case "skip-module": nextModule(); break;
    case "choose":
      if (RUN && RUN.cur && !RUN.cur.answered) {
        RUN.cur.chosen = +a.dataset.ci;
        document.querySelectorAll(".choice").forEach((el) => el.setAttribute("aria-pressed", String(+el.dataset.ci === RUN.cur.chosen)));
        const go = $("#go"); if (go) go.disabled = false;
      }
      break;
    case "check": check(); break;
    case "next": RUN.showText = false; advance(); render(); window.scrollTo({ top: 0 }); break;
    case "next-module": nextModule(); window.scrollTo({ top: 0 }); break;
    case "play": RUN.plays++; TTS.speak(RUN.pending.passage.text, { onend: () => render(), onfail: () => { RUN.grownup = true; render(); } }); render(); break;
    case "stop-audio": TTS.stop(); render(); break;
    case "to-questions": TTS.stop(); RUN.showText = false; showItem(RUN.pending); RUN.pending = null; render(); window.scrollTo({ top: 0 }); break;
    case "show-text": RUN.showText = true; render(); break;
    case "hide-text": RUN.showText = false; render(); break;
    case "exit-ask": RUN.confirmExit = true; render(); break;
    case "exit-stay": RUN.confirmExit = false; render(); break;
    case "exit-yes": exitRun(); break;
    case "home": RUN = null; location.hash = "home"; route(); break;
    case "copy": copyFrom(a.dataset.target); break;
    case "miss-filter": VIEW.missSubject = a.dataset.subject; route(); break;
    case "import": {
      const txt = ($("#paste") || {}).value || "";
      const res = Code.parseAll(txt);
      let added = 0, dup = 0, old = 0;
      for (const p of res.ok) { if ((+p.t || 0) < RESET) { old++; continue; } let r = null; try { r = mergeRecord(p); } catch (e) {} if (r) added++; else if (r === false) dup++; else res.bad++; }
      const lastSid = res.ok.length && res.ok[res.ok.length - 1].s;
      if (lastSid && Object.prototype.hasOwnProperty.call(P.students, lastSid)) P.current = lastSid;
      if (res.ok.length) saveParent();
      VIEW.parentMsg = !res.ok.length && !res.bad ? "没有找到成绩码（以 ZK1- 开头）。" : `导入 ${added} 条${dup ? `，${dup} 条已导入过` : ""}${old ? `，${old} 条是清空前的旧成绩码，已跳过` : ""}${res.bad ? `，${res.bad} 条不完整（可能复制时漏了字）` : ""}。`;
      route(); break;
    }
    case "delete-ask": VIEW.confirmDelete = P.current; route(); break;
    case "delete-no": VIEW.confirmDelete = ""; route(); break;
    case "cloud-pull": cloudPull(P.cloudPass, P.cloudAfter || ""); break;
    case "cloud-full": cloudPull(P.cloudPass, ""); break;
    case "cloud-forget": delete P.cloudPass; delete P.cloudAfter; VIEW.cloudMsg = ""; saveParent(); route(); break;
    case "delete-yes": delete P.students[P.current]; delete P.manual[P.current]; P.current = ""; VIEW.confirmDelete = ""; saveParent(); route(); break;
    case "test-voice": TTS.speak("Hello! This is how the listening section will sound. Good luck with your exam."); break;
    case "reset-ask": VIEW.confirmReset = true; route(); break;
    case "reset-no": VIEW.confirmReset = false; route(); break;
    case "reset-yes": { const name = L.name; L = freshStudent(name); saveStudent(); VIEW.confirmReset = false; location.hash = "home"; route(); break; }
  }
});
document.addEventListener("change", (e) => {
  const t = e.target.closest("[data-change]");
  if (!t) return;
  const k = t.dataset.change;
  if (k === "name") { L.name = t.value.trim().slice(0, 20) || L.name; saveStudent(); }
  else if (k === "voice") { L.settings.voice = t.value; saveStudent(); TTS.pick(); }
  else if (k === "rate") { L.settings.rate = +t.value; saveStudent(); }
  else if (k === "pick") { P.current = t.value; saveParent(); route(); }
  else if (k === "manual") {
    const sid = t.dataset.sid, key = t.dataset.key;
    const v = t.value.trim();
    manualFor(sid)[key] = v === "" ? null : +v;
    saveParent(); route();
    const again = document.getElementById("man-" + key); again && again.focus();
  }
});
document.addEventListener("submit", async (e) => {
  if (e.target.id === "login") {
    e.preventDefault();
    const name = ($("#login-name").value || "").trim().slice(0, 20);
    if (!name) return;
    L = freshStudent(name); saveStudent(); TTS.pick(); route();
  } else if (e.target.id === "cloud-login") {
    e.preventDefault();
    const msg = $("#cloud-msg");
    const pass = $("#cl-pass").value;
    if (pass) cloudPull(pass, Object.keys(P.students).length ? P.cloudAfter || "" : "", msg);
  }
});

// 家长从云端拉取成绩。密码正确后记在这台设备上，下次一键拉取；after 是上次拉到的位置，只取新增的。
async function cloudPull(pass, after, msg = $("#cloud-msg")) {
  if (msg) msg.textContent = "正在拉取成绩……";
  try {
    // 云端对象按服务器时间命名（r/<13 位毫秒>-…），从 resetAt 开始拉，旧记录不再下载。
    const floor = RESET ? "r/" + String(RESET).padStart(13, "0") : "";
    const { rows, last, partial } = await Cloud.pull(pass, after > floor ? after : floor);
    let added = 0;
    for (const p of rows) { try { if (mergeRecord(p)) added++; } catch (e) {} } // 一条坏记录不能卡住后面的拉取
    if (added && !P.students[P.current]) P.current = Object.keys(P.students)[0] || "";
    P.cloudPass = pass; P.cloudAfter = last;
    saveParent();
    VIEW.cloudMsg = `${fmtDate(Date.now())} 拉取 ${rows.length} 条，新增 ${added} 条。${partial ? "还有部分成绩暂时没读到，稍后再点一次“拉取最新成绩”。" : ""}`;
    route();
  } catch (err) {
    if (msg) msg.textContent = "拉取失败：" + String((err && err.message) || err).slice(0, 120);
  }
}

// 清空 resetAt 之前的记录：学生保留名字和编号（家长那边还是同一个人），成绩、错题、待上传的旧成绩全部清掉；
// 家长清掉导入的成绩和手填分数，保留记住的家长密码。每台设备只做一次。
function resetIfNeeded() {
  const RKEY = "zk.reset.v1";
  if (!RESET || (+readJSON(RKEY) || 0) >= RESET) return;
  if (L) { L.results = {}; L.history = []; L.misses = []; saveStudent(); }
  P = { students: {}, manual: {}, current: "", ...(P.cloudPass ? { cloudPass: P.cloudPass } : {}) };
  saveParent();
  Cloud.clearQueue();
  writeJSON(RKEY, RESET);
}

// ---------------------------------------------------------------- 启动
(async () => {
  await loadBanks();
  L = ensureStudent(readJSON(SKEY));
  resetIfNeeded();
  TTS.init();
  if (location.hash === "#test") location.hash = "home";
  route();
  if (Cloud.enabled && Cloud.pending()) Cloud.flush();
})();
})();
