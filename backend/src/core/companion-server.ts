// Companion 出站 WSS 服务端：Companion 从用户本机出站连接（NAT 友好），认证后注册能力，
// Backend 经 RPC 向 Companion 分派本机工具调用并 await 结果。云端默认无本机能力。
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { CompanionRegistry, CompanionCapability, GrantedScopes } from "./companion.ts";

export interface CompanionServerDeps {
  registry: CompanionRegistry;
  // 校验设备令牌 → 返回该用户授权的能力与范围（由部署方提供；默认拒绝）。
  authenticate: (token: string) => Promise<{ userId: string; capabilities: CompanionCapability[]; grantedScopes: GrantedScopes } | null>;
  rpcTimeoutMs?: number;
  path?: string;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class CompanionServer {
  private wss: WebSocketServer;
  private registry: CompanionRegistry;
  private authenticate: CompanionServerDeps["authenticate"];
  private rpcTimeoutMs: number;
  private sockets = new Map<string, WebSocket>(); // userId → socket
  private pending = new Map<string, Pending>();   // rpcId → pending

  constructor(server: HttpServer, deps: CompanionServerDeps) {
    this.registry = deps.registry;
    this.authenticate = deps.authenticate;
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? 60000;
    this.wss = new WebSocketServer({ server, path: deps.path ?? "/companion" });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    let userId: string | null = null;
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "register") {
        void this.authenticate(String(msg.token ?? "")).then((auth) => {
          if (!auth) { ws.send(JSON.stringify({ type: "register_ack", ok: false, error: "认证失败" })); ws.close(); return; }
          userId = auth.userId;
          this.registry.register({ userId: auth.userId, capabilities: auth.capabilities, grantedScopes: auth.grantedScopes });
          this.sockets.set(auth.userId, ws);
          ws.send(JSON.stringify({ type: "register_ack", ok: true, userId: auth.userId, capabilities: auth.capabilities }));
        });
        return;
      }
      if (!userId) return; // 未注册不处理
      if (msg.type === "heartbeat") { this.registry.heartbeat(userId, String(msg.token ?? "")); ws.send(JSON.stringify({ type: "heartbeat_ack" })); return; }
      if (msg.type === "rpc_result") {
        const p = this.pending.get(String(msg.rpcId));
        if (p) { clearTimeout(p.timer); this.pending.delete(String(msg.rpcId)); if (msg.error) p.reject(new Error(String(msg.error))); else p.resolve(msg.result); }
        return;
      }
    });
    ws.on("close", () => { if (userId) { this.sockets.delete(userId); this.registry.unregister(userId); } });
  }

  isConnected(userId: string): boolean { return this.sockets.has(userId); }

  // 向该用户的 Companion 分派本机工具调用，await 结果（超时拒绝）。
  invoke(userId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const ws = this.sockets.get(userId);
    if (!ws) return Promise.reject(new Error(`Companion 未连接：${userId}（本机能力不可用）`));
    const rpcId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rpcId); reject(new Error(`Companion RPC 超时：${tool}`)); }, this.rpcTimeoutMs);
      this.pending.set(rpcId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "rpc_request", rpcId, tool, args }));
    });
  }

  close(): void { for (const p of this.pending.values()) clearTimeout(p.timer); this.pending.clear(); this.wss.close(); }
}