// 成绩同步：成绩码（默认，离线可用）+ 云函数自动同步（可选，config.js 里开启）。
(function () {
"use strict";

// ---------------------------------------------------------------- 成绩码：ZK1-<base64url(JSON)>-<校验>
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function check(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36).slice(-4).padStart(4, "0"); }

const Code = {
  // payload: { v:1, s:学生编号, n:姓名, t:时间, r:[[模块,层级,对,总,时间,用时秒]], m:[[题号,所选原始下标,时间]] }
  make(payload) {
    const body = b64urlEncode(JSON.stringify(payload));
    return `ZK1-${body}-${check(body)}`;
  },
  // 从一段粘贴文本里找出所有成绩码（微信里可能夹着别的话）。返回 {ok:[payload], bad:n}
  parseAll(text) {
    const out = { ok: [], bad: 0 };
    const re = /ZK1-([A-Za-z0-9_-]+)-([a-z0-9]{4})/g;
    let m;
    while ((m = re.exec(String(text || "")))) {
      if (check(m[1]) !== m[2]) { out.bad++; continue; }
      try {
        const p = JSON.parse(b64urlDecode(m[1]));
        if (p && p.v === 1 && p.s && Array.isArray(p.r)) out.ok.push(p); else out.bad++;
      } catch (e) { out.bad++; }
    }
    return out;
  },
};

// ---------------------------------------------------------------- 云同步（可选）：腾讯云国际站香港 SCF 云函数，见 cloud/scf/index.mjs
const cfg = (window.ZK_CONFIG && window.ZK_CONFIG.cloud) || null;
const QKEY = "zk.queue.v1"; // 上传失败的成绩先排队，下次打开网站或做完下一个模块时重发
const readQueue = () => { try { const q = JSON.parse(localStorage.getItem(QKEY) || "[]"); return Array.isArray(q) ? q : []; } catch (e) { return []; } };
const writeQueue = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-200))); } catch (e) {} };

async function call(body, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    // text/plain 是“简单请求”，浏览器不必先发 OPTIONS 预检。
    const res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error === "pass" ? "密码不对" : data.error === "key" ? "上传口令不对" : `服务器返回 ${res.status}`);
    return data;
  } catch (e) {
    throw e && e.name === "AbortError" ? new Error("连接超时") : e;
  } finally { clearTimeout(timer); }
}

const Cloud = {
  enabled: !!(cfg && cfg.url),
  error: "",
  pending() { return readQueue().length; },
  // 上传一条成绩（与成绩码同样的 payload），顺带重发排队的。失败时返回 false，由页面退回成绩码。
  async push(payload) {
    if (!this.enabled) return false;
    writeQueue([...readQueue(), payload]);
    return (await this.flush()) === 0;
  },
  // 重发队列，返回仍未发出的条数。多次调用按顺序排队执行，同一条不会并发重复上传。
  flush() {
    if (!this.enabled) return Promise.resolve(readQueue().length);
    this.chain = (this.chain || Promise.resolve()).then(() => this.drain());
    return this.chain;
  },
  async drain() {
    let q = readQueue();
    while (q.length) {
      try { await call({ op: "push", key: cfg.key || "", rec: q[0] }, 12000); }
      catch (e) { this.error = String((e && e.message) || e); break; }
      q = readQueue().slice(1); writeQueue(q);
    }
    return q.length;
  },
  // 家长拉取 after 之后的全部成绩。返回 {rows, last}。
  async pull(pass, after) {
    const rows = [];
    let last = after || "", partial = false;
    for (let i = 0; i < 50; i++) {
      const data = await call({ op: "pull", pass, after: last }, 30000);
      rows.push(...(data.rows || []));
      last = data.last || last;
      if (data.partial) partial = true;
      if (!data.more) break;
    }
    return { rows, last, partial };
  },
};

window.ZKSync = { Code, Cloud };
})();
