// 中考诊断台 · 成绩同步云函数（腾讯云 SCF，香港地域，Node.js 18 或更高）。
// 单文件、无依赖（ES 模块）：在 SCF 控制台的在线编辑器里替换 index.mjs 的内容即可。成绩存在一个私有 COS 存储桶里，每条一个 JSON 文件。
//
// 环境变量（SCF 控制台 → 函数配置 → 环境变量）：
//   BUCKET        存储桶名称，含 APPID，例如 zhongkao-results-1300000000
//   REGION        存储桶地域，例如 ap-hongkong
//   WRITE_KEY     学生上传口令（写在网站 config.js 里，只用来挡掉随手乱发的请求）
//   PARENT_PASS   家长密码（只有家长知道，用来拉取成绩）
//   ALLOW_ORIGIN  可选，允许的网站来源，例如 https://yqcao.github.io；不填则允许任何来源
// 运行角色需要对该存储桶有读写权限；SCF 会通过 TENCENTCLOUD_SECRETID / SECRETKEY / SESSIONTOKEN 注入临时密钥。
//
// 接口（POST，正文为 JSON 文本）：
//   {op:"push", key, rec}      保存一条成绩（rec 与成绩码 payload 相同）→ {ok:true}
//   {op:"pull", pass, after?}  拉取 after 之后的成绩，每次最多 200 条 → {ok:true, rows, last, more}
//   {op:"ping"}                连通测试 → {ok:true}
import crypto from "node:crypto";

const ENV = process.env;
const PREFIX = "r/";
const MAX_BODY = 64 * 1024;
const MAX_RECORD = 24 * 1024; // 正常一条成绩只有几 KB
const PULL_LIMIT = 200;
const PULL_BYTES = 3 * 1024 * 1024; // SCF 同步调用的返回体上限是 6 MB，留足余量

// ---------------------------------------------------------------- COS 签名（XML API，q-sign-algorithm=sha1）
const hmac = (key, s) => crypto.createHmac("sha1", key).update(s).digest("hex");
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function authorization({ secretId, secretKey, method, path, query = {}, headers = {}, now = Math.floor(Date.now() / 1000) }) {
  const keyTime = `${now - 60};${now + 600}`;
  const pairs = (obj) => Object.keys(obj).map((k) => [enc(k).toLowerCase(), enc(String(obj[k]))]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const q = pairs(query), h = pairs(headers);
  const httpString = [method.toLowerCase(), path, q.map((p) => p.join("=")).join("&"), h.map((p) => p.join("=")).join("&"), ""].join("\n");
  const stringToSign = ["sha1", keyTime, sha1(httpString), ""].join("\n");
  const signature = hmac(hmac(secretKey, keyTime), stringToSign);
  return [
    "q-sign-algorithm=sha1", `q-ak=${secretId}`, `q-sign-time=${keyTime}`, `q-key-time=${keyTime}`,
    `q-header-list=${h.map((p) => p[0]).join(";")}`, `q-url-param-list=${q.map((p) => p[0]).join(";")}`, `q-signature=${signature}`,
  ].join("&");
}

async function cos(method, key, { query = {}, body } = {}) {
  const host = `${ENV.BUCKET}.cos.${ENV.REGION}.myqcloud.com`;
  const path = "/" + key;
  // 只签 host（与官方 SDK 一致）；fetch 会自己带上同样的 Host 头。
  const headers = {
    Authorization: authorization({ secretId: ENV.TENCENTCLOUD_SECRETID, secretKey: ENV.TENCENTCLOUD_SECRETKEY, method, path, query, headers: { host } }),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (ENV.TENCENTCLOUD_SESSIONTOKEN) headers["x-cos-security-token"] = ENV.TENCENTCLOUD_SESSIONTOKEN;
  const qs = Object.keys(query).map((k) => `${enc(k)}=${enc(String(query[k]))}`).join("&");
  const res = await fetch(`https://${host}${path}${qs ? "?" + qs : ""}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`COS ${method} ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

// 列出 after 之后的对象键（按字典序，也就是按上传时间）。
async function listKeys(after, max) {
  const query = { prefix: PREFIX, "max-keys": String(max) };
  if (after) query.marker = after;
  const xml = await cos("GET", "", { query });
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  return { keys, truncated };
}

// ---------------------------------------------------------------- 校验
// 逐项检查并重建记录，只保存认识的字段：一条坏记录不能让家长页拉取或显示出错。
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const okId = (x) => typeof x === "string" && ID.test(x) && !BAD_KEYS.has(x);
const num = (x) => typeof x === "number" && Number.isFinite(x);
function cleanRecord(p) {
  if (!p || typeof p !== "object" || p.v !== 1) return null;
  if (!okId(p.s) || !/^[A-Za-z0-9_-]{1,40}$/.test(p.s)) return null;
  if (p.n !== undefined && (typeof p.n !== "string" || p.n.length > 40)) return null;
  if (!num(p.t)) return null;
  if (!Array.isArray(p.r) || p.r.length < 1 || p.r.length > 80) return null;
  if (!p.r.every((r) => Array.isArray(r) && r.length === 6 && okId(r[0]) && r.slice(1).every(num))) return null;
  const m = p.m === undefined ? [] : p.m;
  if (!Array.isArray(m) || m.length > 400) return null;
  if (!m.every((x) => Array.isArray(x) && x.length === 3 && okId(x[0]) && (x[1] === null || Number.isInteger(x[1])) && num(x[2]))) return null;
  const rec = { v: 1, s: p.s, n: p.n, t: p.t, r: p.r, m };
  return JSON.stringify(rec).length <= MAX_RECORD ? rec : null;
}
function sameSecret(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- 入口
function reply(statusCode, obj) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ENV.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
    body: JSON.stringify(obj),
  };
}

async function handle(req) {
  if (req.op === "ping") return reply(200, { ok: true });
  if (req.op === "push") {
    if (!sameSecret(req.key, ENV.WRITE_KEY)) return reply(403, { ok: false, error: "key" });
    const rec = cleanRecord(req.rec);
    if (!rec) return reply(400, { ok: false, error: "record" });
    // 用服务器时间命名，家长按 after 增量拉取时不受学生设备时钟影响。
    const key = `${PREFIX}${String(Date.now()).padStart(13, "0")}-${rec.s}-${crypto.randomBytes(3).toString("hex")}.json`;
    await cos("PUT", key, { body: JSON.stringify(rec) });
    return reply(200, { ok: true });
  }
  if (req.op === "pull") {
    if (!sameSecret(req.pass, ENV.PARENT_PASS)) return reply(403, { ok: false, error: "pass" });
    const after = typeof req.after === "string" && req.after.startsWith(PREFIX) ? req.after : "";
    const { keys, truncated } = await listKeys(after, PULL_LIMIT);
    // 读取失败（网络抖动等）时重试一次；仍失败则游标停在它前面，下次拉取会再试，不会悄悄漏掉。
    const texts = new Array(keys.length), failed = new Array(keys.length).fill(false);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, keys.length) }, async () => {
      while (next < keys.length) {
        const i = next++;
        try { texts[i] = await cos("GET", keys[i]); }
        catch (e) { try { texts[i] = await cos("GET", keys[i]); } catch (e2) { failed[i] = true; console.error(e2); } }
      }
    }));
    const rows = [];
    let last = after, bytes = 0, more = truncated, partial = false;
    for (let i = 0; i < keys.length; i++) {
      // 读取失败：停在它前面并且不再翻页（免得客户端连续重试同一页）。体积到顶：停下，下一页接着拉。
      if (failed[i]) { more = false; partial = true; break; }
      if (i > 0 && bytes + texts[i].length > PULL_BYTES) { more = true; break; }
      bytes += texts[i].length;
      try { const rec = cleanRecord(JSON.parse(texts[i])); if (rec) rows.push(rec); } catch (e) { console.error("bad record", keys[i]); }
      last = keys[i];
    }
    return reply(200, { ok: true, rows, last, more, partial });
  }
  return reply(400, { ok: false, error: "op" });
}

export const main_handler = async (event) => {
  const method = String(event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method) || "POST").toUpperCase();
  if (method === "OPTIONS") return reply(200, { ok: true });
  if (method !== "POST") return reply(405, { ok: false, error: "method" });
  let body = event.body || "";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");
  if (body.length > MAX_BODY) return reply(413, { ok: false, error: "size" });
  let req;
  try { req = JSON.parse(body); } catch (e) { return reply(400, { ok: false, error: "json" }); }
  try { return await handle(req || {}); }
  catch (e) { console.error(e); return reply(500, { ok: false, error: "server" }); }
};

export const _test = { authorization, cleanRecord };
