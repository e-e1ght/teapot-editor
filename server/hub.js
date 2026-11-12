#!/usr/bin/env node
// teapot-agent 허브: 하나만 떠 있는 로컬 서버.
//  - 티팟 탭(유저스크립트)과 WebSocket 연결
//  - 편집기 화면(editor/) 제공
//  - MCP 서버와 편집기가 쓰는 HTTP API (/api/*)
// 실행: node server/hub.js [--open]
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Bridge, TEAPOT_ORIGINS } from "./bridge.js";
import { backup } from "./files.js";
import { createNai } from "./nai.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.TEAPOT_BRIDGE_PORT ?? 18765);
const HOST = "127.0.0.1";
const BACKUPS = path.resolve(process.env.TEAPOT_BACKUPS ?? path.join(ROOT, "backups"));
const EDITOR_DIR = path.join(ROOT, "editor");
const USERSCRIPT = path.join(ROOT, "userscript", "teapot-agent.user.js");
const SELF_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const SELF_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const WRITE_FNS = new Set(["createCheckpoint", "updateCheckpoint"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const bridge = new Bridge();
const nai = createNai(ROOT);
// 편집기 실시간 채널 (WebSocket). 예전 SSE 방식은 브라우저의 "서버당 동시 연결 6개" 제한에 걸려,
// 편집기 창이 여러 개 열려 있으면 새 창이 아예 열리지 않는 문제가 있었다.
const liveWss = new WebSocketServer({ noServer: true });
const liveClients = new Set();
liveWss.on("connection", (ws) => {
  liveClients.add(ws);
  ws.send(JSON.stringify({ type: "tabs", ...status() }));
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
  ws.on("error", () => {});
  ws.on("close", () => {
    clearInterval(ping);
    liveClients.delete(ws);
  });
});

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const ws of liveClients) if (ws.readyState === 1) ws.send(msg);
}

function status() {
  return {
    hub: true,
    pid: process.pid,
    port: PORT,
    root: ROOT,
    editors: liveClients.size,
    backups: BACKUPS,
    tabs: bridge.tabs.map((c) => ({ ...c.info })),
  };
}
bridge.onTabsChanged = () => broadcast({ type: "tabs", ...status() });

// 업데이트 확인: GitHub 저장소의 package.json 버전과 비교한다 (6시간마다 한 번만 요청).
// 보내는 정보는 없다(파일 하나를 읽기만 함). TEAPOT_NO_UPDATE_CHECK=1이면 확인하지 않는다.
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const REPO = String(PKG.repository?.url ?? PKG.repository ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
let updateCache = null;
function newerVersion(a, b) {
  const p = (v) => String(v).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
async function checkUpdate() {
  const base = { current: PKG.version, repo: REPO || null };
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(REPO);
  if (process.env.TEAPOT_NO_UPDATE_CHECK === "1" || !m) return { ...base, latest: null, newer: false };
  if (updateCache && Date.now() - updateCache.at < 6 * 3600_000) return { ...base, ...updateCache.data };
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${m[1]}/main/package.json`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const latest = (await r.json()).version ?? null;
    const data = { latest, newer: !!latest && newerVersion(latest, PKG.version) };
    updateCache = { at: Date.now(), data };
    return { ...base, ...data };
  } catch (e) {
    return { ...base, latest: null, newer: false, error: String(e.message ?? e) };
  }
}

// 쓰기 전에 서버의 현재 저장본을 백업하고, 끝나면 편집기들에 알린다.
async function handleRequest(body) {
  const { type, ...payload } = body;
  if (type === "call" && WRITE_FNS.has(payload.fn)) {
    const d = payload.data ?? {};
    let backupFile = null;
    if (payload.fn === "updateCheckpoint" && d.cpId) {
      const cur = await bridge.request("call", {
        fn: "getCheckpoint",
        data: { characterId: d.characterId, checkpointId: d.cpId },
      });
      if (cur?.checkpoint) backupFile = await backup(BACKUPS, d.characterId, d.cpId, cur.checkpoint);
    }
    const result = await bridge.request(type, payload);
    broadcast({
      type: "saved",
      fn: payload.fn,
      characterId: d.characterId,
      checkpointId: d.cpId ?? result?.checkpoint?.id ?? null,
      source: body.source ?? "unknown",
      at: Date.now(),
    });
    return { ...result, _backup: backupFile };
  }
  return bridge.request(type, payload);
}

// ---------- 외부 이미지 중계 (메모리 캐시) ----------
const proxyCache = new Map(); // url -> { type, buf }
let proxyBytes = 0;
const PROXY_MAX_FILE = 25 * 1024 * 1024;
const PROXY_MAX_CACHE = 200 * 1024 * 1024;
async function proxyImage(target, res) {
  let u;
  try {
    u = new URL(target ?? "");
  } catch {
    return res.writeHead(400).end("bad url");
  }
  if (!/^https?:$/.test(u.protocol)) return res.writeHead(400).end("bad url");
  // 로컬·사설 주소로는 중계하지 않는다
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i.test(u.hostname)) return res.writeHead(403).end();
  const key = u.href;
  let hit = proxyCache.get(key);
  if (!hit) {
    try {
      const r = await fetch(key, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", Accept: "image/avif,image/webp,image/*,font/*,*/*;q=0.8" },
        signal: AbortSignal.timeout(20_000),
      });
      const type = r.headers.get("content-type") || "";
      if (!r.ok) return res.writeHead(r.status).end();
      if (!/^(image\/|font\/|application\/(font|x-font|vnd\.ms-fontobject|octet-stream))/i.test(type)) return res.writeHead(415).end();
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > PROXY_MAX_FILE) return res.writeHead(413).end();
      hit = { type, buf };
      proxyCache.set(key, hit);
      proxyBytes += buf.length;
      while (proxyBytes > PROXY_MAX_CACHE && proxyCache.size) {
        const [k, v] = proxyCache.entries().next().value;
        proxyCache.delete(k);
        proxyBytes -= v.buf.length;
      }
    } catch {
      return res.writeHead(502).end();
    }
  }
  res.writeHead(200, { "Content-Type": hit.type, "Cache-Control": "private, max-age=86400", "Access-Control-Allow-Origin": "*" });
  res.end(hit.buf);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// 브라우저가 매번 확인은 하되(no-cache), 파일이 그대로면 304로 답해 내용을 다시 보내지 않는다.
// 파일을 고치면 크기·수정 시각이 달라져 바로 새 내용이 나간다.
async function serveFile(req, res, file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error("not a file");
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache", ETag: etag };
    if (req.headers["if-none-match"] === etag) return res.writeHead(304, headers).end();
    const buf = await fsp.readFile(file);
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  // DNS 리바인딩 방지: Host 헤더는 로컬 주소만
  if (!SELF_HOSTS.has(req.headers.host)) return res.writeHead(403).end("forbidden host");
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = req.headers.origin;

  if (url.pathname === "/teapot-agent.user.js") {
    try {
      const buf = await fsp.readFile(USERSCRIPT);
      const headers = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" };
      if (TEAPOT_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
      res.writeHead(200, headers).end(buf);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    // 다른 사이트에서의 호출 차단: Origin은 자기 자신만, 쓰기 요청엔 커스텀 헤더 필수(프리플라이트 유발)
    if (origin && !SELF_ORIGINS.has(origin)) return sendJson(res, 403, { error: "forbidden origin" });
    if (url.pathname === "/api/status" && req.method === "GET") return sendJson(res, 200, status());
    if (url.pathname === "/api/update" && req.method === "GET") return sendJson(res, 200, await checkUpdate());
    if (req.method !== "POST" || req.headers["x-teapot-agent"] !== "1") return sendJson(res, 403, { error: "forbidden" });
    try {
      const body = await readBody(req);
      if (url.pathname === "/api/request") return sendJson(res, 200, { ok: true, result: await handleRequest(body) });
      // ----- 에셋 스튜디오 -----
      if (url.pathname === "/api/nai/generate") return nai.generate(body, res);
      const studio = {
        "/api/nai/settings": () => (Object.keys(body).length ? nai.saveSettings(body) : nai.publicSettings()),
        "/api/nai/cancel": () => nai.cancel(),
        "/api/nai/save": () => nai.save(String(body.id ?? ""), typeof body.folder === "string" ? body.folder : undefined),
        "/api/nai/anlas": () => nai.anlas(),
        "/api/assets/list": () => nai.listAssets(body.limit),
        "/api/assets/meta": () => nai.assetMeta(String(body.file ?? "")),
        "/api/assets/open": () => nai.openFolder(body.file ? String(body.file) : ""),
        "/api/prompts/load": () => nai.loadPrompts(),
        "/api/prompts/save": () => nai.savePrompts(body),
      }[url.pathname];
      if (studio) return sendJson(res, 200, { ok: true, result: await studio() });
      if (url.pathname === "/api/shutdown") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 100);
        return;
      }
      return sendJson(res, 404, { error: "unknown api" });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message ?? String(e) });
    }
  }

  // 미리보기용 외부 이미지 중계: imgur 등은 로컬 주소에서 온 요청을 막으므로 허브가 대신 받아 준다.
  // 이미지·폰트만, 편집기(같은 출처)에서 온 요청만 허용한다.
  if (url.pathname === "/img-proxy") {
    if (!["same-origin", undefined].includes(req.headers["sec-fetch-site"])) return res.writeHead(403).end();
    return proxyImage(url.searchParams.get("u"), res);
  }

  // 에셋 스튜디오 결과 이미지 (다른 사이트에서 끌어다 쓰지 못하게 막는다)
  if (url.pathname.startsWith("/assets/")) {
    if (req.headers["sec-fetch-site"] === "cross-site") return res.writeHead(403).end();
    const p = await nai.resolveAsset(decodeURIComponent(url.pathname.slice("/assets/".length)));
    if (!p || !/\.(png|json)$/i.test(p)) return res.writeHead(404).end();
    return serveFile(req, res, p);
  }

  // 편집기 정적 파일
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(EDITOR_DIR, rel));
  if (!file.startsWith(EDITOR_DIR)) return res.writeHead(403).end();
  return serveFile(req, res, file);
});

bridge.attach();
// WebSocket 업그레이드: /api/live는 편집기, 그 밖은 티팟 탭(유저스크립트)
server.on("upgrade", (req, socket, head) => {
  if (!SELF_HOSTS.has(req.headers.host)) return socket.destroy();
  if (new URL(req.url, "http://x").pathname === "/api/live") {
    if (!SELF_ORIGINS.has(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    return liveWss.handleUpgrade(req, socket, head, (ws) => liveWss.emit("connection", ws, req));
  }
  bridge.handleUpgrade(req, socket, head);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // 이미 떠 있는 허브가 같은 폴더의 것이면 편집기만 열고, 다른 폴더(또는 다른 프로그램)면 안내 후 종료
    fetch(`http://${HOST}:${PORT}/api/status`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .catch(() => null)
      .then((st) => {
        if (st?.hub && st.root && path.resolve(st.root) !== ROOT) {
          console.error(`[teapot-hub] 다른 폴더의 허브가 이미 실행 중입니다.
  실행 중: ${st.root}
  이 폴더: ${ROOT}
먼저 실행 중인 허브를 종료하세요 (stop-hub.bat 또는 npm run hub:stop).`);
          process.exit(2);
        }
        if (!st?.hub) {
          console.error(`[teapot-hub] 포트 ${PORT}를 다른 프로그램이 사용 중입니다. TEAPOT_BRIDGE_PORT 환경 변수로 포트를 바꿀 수 있습니다.`);
          process.exit(3);
        }
        console.error(`[teapot-hub] 허브가 이미 실행 중입니다. 편집기만 엽니다.`);
        if (process.argv.includes("--open")) openEditor();
        setTimeout(() => process.exit(0), 300);
      });
  } else {
    console.error(`[teapot-hub] 오류: ${err.message}`);
    process.exit(1);
  }
});

function openEditor() {
  const url = `http://${HOST}:${PORT}/`;
  // Chrome 앱 모드(주소창 없는 창)로 열고, 실패하면 기본 브라우저로
  const p = spawn("cmd", ["/c", "start", "", "chrome", `--app=${url}`], { detached: true, stdio: "ignore", windowsHide: true });
  p.on("exit", (code) => {
    if (code) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  });
  p.unref();
}

server.listen(PORT, HOST, () => {
  console.error(`[teapot-hub] 실행됨: http://${HOST}:${PORT}/  (pid ${process.pid})`);
  if (process.argv.includes("--open")) openEditor();
});

fs.mkdirSync(BACKUPS, { recursive: true });
