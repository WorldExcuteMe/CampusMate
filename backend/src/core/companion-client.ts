// Companion 参考客户端（用户本机运行，出站 WSS 连接 Backend）。
// 认证→注册能力→处理 Backend 的本机工具 RPC→心跳→断线重连。本机能力授权范围由服务端强制。
import { WebSocket } from "ws";

export interface CompanionClientDeps {
  url: string;                       // wss://backend/companion
  token: string;                     // 设备令牌（服务端 authenticate 校验）
  handleTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>; // 本机工具实现
  heartbeatMs?: number;
  reconnectMs?: number;
  WebSocketImpl?: typeof WebSocket;  // 便于测试注入
}

export class CompanionClient {
  private url: string;
  private token: string;
  private handleTool: CompanionClientDeps["handleTool"];
  private heartbeatMs: number;
  private reconnectMs: number;
  private WS: typeof WebSocket;
  private ws: WebSocket | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  registered = false;

  constructor(deps: CompanionClientDeps) {
    this.url = deps.url;
    this.token = deps.token;
    this.handleTool = deps.handleTool;
    this.heartbeatMs = deps.heartbeatMs ?? 15000;
    this.reconnectMs = deps.reconnectMs ?? 2000;
    this.WS = deps.WebSocketImpl ?? WebSocket;
  }

  connect(): void {
    if (this.stopped) return;
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", token: this.token })));
    ws.on("message", (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "register_ack") {
        this.registered = Boolean(msg.ok);
        if (this.registered && !this.hb) this.hb = setInterval(() => ws.send(JSON.stringify({ type: "heartbeat", token: this.token })), this.heartbeatMs);
        return;
      }
      if (msg.type === "rpc_request") {
        void this.handleTool(String(msg.tool), msg.args ?? {})
          .then((result) => ws.send(JSON.stringify({ type: "rpc_result", rpcId: msg.rpcId, result })))
          .catch((e) => ws.send(JSON.stringify({ type: "rpc_result", rpcId: msg.rpcId, error: e instanceof Error ? e.message : String(e) })));
        return;
      }
    });
    ws.on("close", () => {
      this.registered = false;
      if (this.hb) { clearInterval(this.hb); this.hb = null; }
      if (!this.stopped) this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectMs);
    });
    ws.on("error", () => { /* close 触发重连 */ });
  }

  stop(): void {
    this.stopped = true;
    this.registered = false;
    if (this.hb) { clearInterval(this.hb); this.hb = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
  }
}
