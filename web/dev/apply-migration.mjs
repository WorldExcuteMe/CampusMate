// 直连 Supabase Postgres 应用 Migration（绕开不稳定的管理 MCP）。
// 凭据来自 .env.local（gitignored）。仅本地运维使用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SocksClient } from "socks";

const PROXY = { host: "127.0.0.1", port: 7890, type: 5 };
async function tunnel(host, port) {
  const { socket } = await SocksClient.createConnection({
    proxy: PROXY,
    command: "connect",
    destination: { host, port },
  });
  return socket;
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = {};
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  if (line.trim().startsWith("#")) continue;
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const ref = env.SUPABASE_PROJECT_REF;
const password = env.SUPABASE_DB_PASSWORD;
const sql = fs.readFileSync(path.join(root, "..", "supabase", "migrations", "0001_init.sql"), "utf8");

const regions = ["ap-southeast-1","ap-northeast-1","ap-northeast-2","ap-south-1","ap-southeast-2","us-east-1","us-east-2","us-west-1","ca-central-1","eu-west-1","eu-west-2","eu-west-3","eu-central-1","eu-central-2","eu-north-1","sa-east-1"];
const hosts = regions.map((r) => ({ host: `aws-0-${r}.pooler.supabase.com`, port: 6543, user: `postgres.${ref}` }));

for (const h of hosts) {
  try {
    const socket = await tunnel(h.host, h.port);
    const client = new pg.Client({ stream: socket, user: h.user, password, database: "postgres", ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query(sql);
    const tables = await client.query("select table_name from information_schema.tables where table_schema='public' order by table_name");
    console.log(`[migration] OK via ${h.host}`);
    console.log("[tables]", tables.rows.map((r) => r.table_name).join(", "));
    await client.end();
    process.exit(0);
  } catch (err) {
    console.log(`[migration] fail ${h.host}: ${err.message}`);
  }
}
process.exit(1);