import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PgPool } from "./sql.ts";
import { DatabaseProxyStream } from "./db-proxy.ts";
import { once } from "node:events";

test("C1 PgPool honors explicit CONNECT proxy and fails closed on rejection", async (t) => {
  let requested = "";
  const proxy = http.createServer();
  proxy.on("connect", (req, socket) => {
    requested = req.url ?? "";
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => proxy.close(() => resolve())));
  const port = (proxy.address() as { port: number }).port;
  const options = Object.assign({ connectionTimeoutMillis: 800 }, { proxyUrl: `http://127.0.0.1:${port}` });
  const pool = new PgPool("postgresql://fixture:never-sent@postgres.proxy.invalid:5432/postgres", options);
  t.after(() => pool.end());
  await assert.rejects(pool.query("select 1"), /代理.*403|proxy.*403/i);
  assert.equal(requested, "postgres.proxy.invalid:5432");
});

test("C1 CONNECT stream preserves coalesced response bytes and subsequent duplex traffic", async (t) => {
  const sockets = new Set<import("node:stream").Duplex>();
  const proxy = http.createServer();
  proxy.on("connect", (_req, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\nfirst");
    socket.on("data", data => socket.write(data));
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const stream = new DatabaseProxyStream(`http://127.0.0.1:${(proxy.address() as {port:number}).port}`);
  t.after(() => stream.destroy());
  const initial = once(stream, "data");
  stream.connect(5432, "database.fixture");
  assert.equal((await initial)[0].toString(), "first");
  const echoed = once(stream, "data");
  stream.write("duplex");
  assert.equal((await echoed)[0].toString(), "duplex");
});

test("C1 hanging CONNECT has a bounded timeout without direct fallback", async (t) => {
  const sockets = new Set<import("node:stream").Duplex>();
  const proxy = http.createServer();
  proxy.on("connect", (_req, socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const stream = new DatabaseProxyStream(`http://127.0.0.1:${(proxy.address() as {port:number}).port}`, 80);
  const error = once(stream, "error");
  stream.connect(5432, "database.fixture");
  assert.match(String((await error)[0]), /代理连接超时/);
});

test("C2 explicit CA cannot be silently replaced by URI SSL parameters", () => {
  assert.throws(() => new PgPool("postgresql://fixture@localhost/postgres?sslmode=require", {ssl:{ca:"fixture"}}), /SSL 参数不能/);
});
