// 티팟 탭(유저스크립트)과 WebSocket으로 연결되는 브리지.
// 허브는 요청만 보내고, 실제 Cloud Function 호출은 로그인된 브라우저 탭이 수행한다.
import { WebSocketServer } from "ws";

export const TEAPOT_ORIGINS = new Set(["https://teapotchat.com", "https://www.teapotchat.com"]);

export class Bridge {
  constructor({ timeoutMs = 60_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.clients = []; // 최근 활동한 탭이 뒤쪽
    this.pending = new Map();
    this.seq = 0;
    this.onTabsChanged = () => {};
  }

  // 업그레이드 요청은 허브가 경로별로 나눠 넘겨준다 (편집기 실시간 채널과 같은 포트를 쓰기 때문)
  attach() {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("error", () => {});
    this.wss.on("connection", (ws) => {
      const client = { ws, info: {}, connectedAt: Date.now() };
      this.clients.push(client);
      ws.on("message", (raw) => this.#onMessage(client, raw));
      ws.on("close", () => {
        this.clients = this.clients.filter((c) => c !== client);
        this.onTabsChanged();
      });
    });
  }

  handleUpgrade(req, socket, head) {
    if (!TEAPOT_ORIGINS.has(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  #onMessage(client, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "hello" || msg.type === "context") {
      client.info = { ...client.info, ...msg.info, updatedAt: Date.now() };
      this.clients = [...this.clients.filter((c) => c !== client), client];
      this.onTabsChanged();
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error || "브라우저 쪽 오류"));
    }
  }

  get tabs() {
    return this.clients.filter((c) => c.ws.readyState === 1 && c.info.url);
  }

  get active() {
    const t = this.tabs;
    return t[t.length - 1] ?? null;
  }

  request(type, payload = {}) {
    const client = this.active;
    if (!client) {
      return Promise.reject(
        new Error("연결된 티팟 탭이 없습니다. 유저스크립트가 설치된 상태로 teapotchat.com 제작창을 열어주세요.")
      );
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`브라우저 응답 시간 초과 (${type})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      client.ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }
}
