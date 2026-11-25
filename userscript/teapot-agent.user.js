// ==UserScript==
// @name         teapot-agent bridge
// @namespace    teapot-agent
// @version      0.3.0
// @description  티팟 제작창을 로컬 teapot-agent(MCP 서버)와 연결합니다.
// @match        https://teapotchat.com/*
// @match        https://www.teapotchat.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  if (window.__teapotAgent) return;
  window.__teapotAgent = true;

  const PORT = 18765;
  // 2026-11 티팟 업데이트로 기존 클라우드 함수(cloudfunctions.net)가 꺼지고 api.teapotchat.com으로 옮겨졌다.
  const API = "https://api.teapotchat.com";
  // 저장 관련 함수만 허용. 등록(submitCharacter)과 삭제는 막아둔다.
  const ROUTES = {
    listCheckpoints: "/v1/characters/list-checkpoints",
    getCheckpoint: "/v1/characters/get-checkpoint",
    createCheckpoint: "/v1/characters/create-checkpoint",
    updateCheckpoint: "/v1/characters/update-checkpoint",
    renameCheckpoint: "/v1/characters/rename-checkpoint",
  };

  let ws = null;
  let lastUrl = "";

  // ---- 상태 표시 점 ----
  const dot = document.createElement("div");
  dot.title = "teapot-agent";
  Object.assign(dot.style, {
    position: "fixed", left: "8px", bottom: "8px", width: "10px", height: "10px",
    borderRadius: "50%", background: "#999", zIndex: 2147483647, pointerEvents: "none",
    boxShadow: "0 0 0 2px rgba(255,255,255,.8)",
  });
  const setDot = (c, t) => { dot.style.background = c; dot.title = "teapot-agent: " + t; };
  const mountDot = () => document.body && !dot.isConnected && document.body.appendChild(dot);

  function context() {
    const p = new URLSearchParams(location.search);
    return {
      url: location.pathname + location.search,
      cid: p.get("cid"),
      cpid: p.get("cpid"),
      step: p.get("step"),
      title: document.title,
    };
  }

  async function idToken() {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open("firebaseLocalStorageDb");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    try {
      const rows = await new Promise((res, rej) => {
        const q = db.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const user = rows.map((r) => r.value).find((v) => v && v.stsTokenManager);
      if (!user) throw new Error("로그인 정보가 없습니다. 티팟에 로그인하세요.");
      const t = user.stsTokenManager;
      if (t.expirationTime && t.expirationTime < Date.now() + 30_000) {
        throw new Error("로그인 토큰이 만료됐습니다. 티팟 탭을 새로고침하세요.");
      }
      return t.accessToken;
    } finally {
      db.close();
    }
  }

  async function callFunction(fn, data) {
    if (!Object.hasOwn(ROUTES, fn)) throw new Error(`허용되지 않은 함수: ${fn}`);
    let payload = data ?? {};
    // 티팟 제작창과 같게: 저장할 때 snapshot의 characters는 빼고 보낸다
    if (payload.snapshot && typeof payload.snapshot === "object") {
      const { characters, ...snapshot } = payload.snapshot;
      payload = { ...payload, snapshot };
    }
    let res;
    try {
      res = await fetch(API + ROUTES[fn], {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + (await idToken()),
          "X-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error(`${fn} 네트워크 오류 (${API}): ${e?.message || e}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.error || body?.success === false) {
      const e = body?.error;
      const msg = typeof e === "string" ? e : e?.message || e?.code || e?.status;
      throw new Error(`${fn} 실패 (${res.status})${msg ? ": " + msg : ""}`);
    }
    if (fn === "listCheckpoints" && body && typeof body.summaryOnly !== "boolean") {
      body.summaryOnly = body.summary_only === true;
    }
    return body;
  }

  // 티팟 제작창과 같은 토큰 계산 API (Gemini 기준)
  async function countTokens(text) {
    const res = await fetch("/api/prompt-token-count", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (await idToken()) },
      body: JSON.stringify({ text: String(text ?? "") }),
    });
    const body = await res.json().catch(() => ({}));
    if (typeof body.tokens !== "number") throw new Error("토큰 계산 실패: " + (body.reason || res.status));
    return body.tokens;
  }

  // 프롬프트 템플릿 목록 (기본 프롬프트 글자 수 계산용, 읽기 전용)
  async function templates() {
    const url = "https://firestore.googleapis.com/v1/projects/chat-ai-7a275/databases/(default)/documents/main_system_prompt_template?pageSize=100";
    const res = await fetch(url, { headers: { Authorization: "Bearer " + (await idToken()) } });
    const body = await res.json();
    if (!res.ok) throw new Error("템플릿 목록 실패: " + (body?.error?.message || res.status));
    const val = (f) => (f == null ? null : f.stringValue ?? (f.integerValue != null ? Number(f.integerValue) : f.doubleValue ?? f.booleanValue ?? null));
    return (body.documents ?? []).map((d) => {
      const f = d.fields ?? {};
      return { name: val(f.name), num_chars: val(f.num_chars), prompt_mode: val(f.prompt_mode), version: val(f.version) };
    }).filter((x) => x.name);
  }

  async function handle(msg) {
    if (msg.type === "call") return callFunction(msg.fn, msg.data);
    if (msg.type === "countTokens") return countTokens(msg.text);
    if (msg.type === "templates") return templates();
    if (msg.type === "context") return context();
    if (msg.type === "reload") {
      const u = new URL(location.href);
      if (msg.cpid) u.searchParams.set("cpid", msg.cpid);
      setTimeout(() => location.assign(u.toString()), 50);
      return { reloading: u.pathname + u.search };
    }
    throw new Error("알 수 없는 요청: " + msg.type);
  }

  function send(o) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  }

  function connect() {
    mountDot();
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    } catch (e) {
      setDot("#d33", "연결 실패");
      return setTimeout(connect, 5000);
    }
    ws.onopen = () => {
      setDot("#2bb673", "연결됨");
      lastUrl = location.href;
      send({ type: "hello", info: context() });
    };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try {
        send({ id: msg.id, ok: true, result: await handle(msg) });
      } catch (e) {
        send({ id: msg.id, ok: false, error: String(e && e.message || e) });
      }
    };
    ws.onclose = () => {
      setDot("#999", "서버 대기 중");
      setTimeout(connect, 3000);
    };
    ws.onerror = () => {};
  }

  // SPA 라우팅: URL이 바뀌면 서버에 알림
  setInterval(() => {
    mountDot();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      send({ type: "context", info: context() });
    }
  }, 1000);
  // 여러 탭 중 마지막으로 포커스된 탭을 기본 대상으로
  window.addEventListener("focus", () => send({ type: "context", info: context() }));

  connect();
})();
