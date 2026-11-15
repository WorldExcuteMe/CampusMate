import http from "node:http";
import https from "node:https";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";

// pg's public stream factory expects a synchronous Duplex with connect(),
// setNoDelay() and setKeepAlive(). TLS remains between pg and the original DB
// hostname; this stream only transports bytes through an explicit CONNECT proxy.
export class DatabaseProxyStream extends Duplex {
  private proxy: URL;
  private request?: http.ClientRequest;
  private socket?: Socket;
  private timeoutMs: number;
  private noDelay = true;
  private keepAlive = false;
  private keepAliveDelay = 0;

  constructor(proxyUrl: string, timeoutMs = 8000) {
    super();
    this.proxy = new URL(proxyUrl);
    if (!["http:", "https:"].includes(this.proxy.protocol) || this.proxy.search || this.proxy.hash || !["", "/"].includes(this.proxy.pathname)) throw new Error("数据库代理地址必须为 HTTP(S) 代理入口");
    this.timeoutMs = timeoutMs;
  }
  connect(port: number, host: string) {
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 || /[\r\n]/.test(host)) throw new Error("数据库代理目标无效");
    const target = `${host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host}:${port}`;
    const headers: Record<string, string> = { Host: target };
    if (this.proxy.username || this.proxy.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString("base64")}`;
    const request = (this.proxy.protocol === "https:" ? https : http).request({
      hostname: this.proxy.hostname, port: this.proxy.port || (this.proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT", path: target, headers, agent: false,
    });
    this.request = request;
    request.setTimeout(this.timeoutMs, () => this.destroy(new Error("数据库代理连接超时")));
    request.once("error", () => { if (!this.destroyed) this.destroy(new Error("数据库代理连接失败")); });
    request.once("response", response => { response.resume(); this.destroy(new Error(`数据库代理拒绝连接 HTTP ${response.statusCode}`)); });
    request.once("connect", (response, connected, head) => {
      if (this.destroyed) { connected.destroy(); return; }
      if (response.statusCode !== 200) { connected.destroy(); this.destroy(new Error(`数据库代理拒绝连接 HTTP ${response.statusCode}`)); return; }
      this.socket = connected as Socket;
      this.socket.setTimeout(0);
      this.socket.setNoDelay(this.noDelay);
      this.socket.setKeepAlive(this.keepAlive, this.keepAliveDelay);
      this.socket.on("data", chunk => { if (!this.push(chunk)) this.socket?.pause(); });
      this.socket.once("end", () => this.push(null));
      this.socket.once("error", error => this.destroy(error));
      this.socket.once("close", () => { if (!this.destroyed) this.destroy(); });
      this.emit("connect");
      if (head.length) this.push(head);
    });
    request.end();
    return this;
  }
  setNoDelay(value = true) { this.noDelay = value; this.socket?.setNoDelay(value); return this; }
  setKeepAlive(value = false, delay = 0) { this.keepAlive = value; this.keepAliveDelay = delay; this.socket?.setKeepAlive(value, delay); return this; }
  override _read() { this.socket?.resume(); }
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!this.socket) { callback(new Error("数据库代理尚未连接")); return; }
    this.socket.write(chunk, encoding, callback);
  }
  override _final(callback: (error?: Error | null) => void) { if (this.socket) this.socket.end(callback); else callback(); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) { this.request?.destroy(); this.socket?.destroy(); callback(error); }
}
