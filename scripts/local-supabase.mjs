// Reproducible local Docker DB + Auth + REST. Never targets a linked/cloud DB.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workdir = path.join(root, ".local", "dev");
const cli = path.join(root, "node_modules", "supabase", "dist", "supabase.js");
const project = "campusmate-local";
const network = "campusmate-local-loopback";
const excluded = "realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
const migrations = [
  ["20261113000100_init.sql", "supabase/migrations/0001_init.sql"],
  ["20261113000200_profiles.sql", "supabase/migrations/0002_profiles_and_provenance.sql"],
  ["20261114000100_runtime.sql", "backend/migrations/0002_agent_runtime.sql"],
  ["20261114000200_personal.sql", "backend/migrations/0003_personal_context.sql"],
  ["20261114000300_verification.sql", "supabase/migrations/0003_atomic_verification_reports.sql"],
];
let scopedEnv = process.env;
const redact = s => s.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database URL redacted]")
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT redacted]")
  .replace(/sb_secret_[A-Za-z0-9_-]+/g, "[secret key redacted]");
async function run(exe, args, progress = false, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: root, env: scopedEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const accept = (buffer, stderr) => {
      const text = buffer.toString();
      if (stderr) err = (err + text).slice(-200_000); else out = (out + text).slice(-2_000_000);
      if (progress) for (const line of text.split(/[\r\n]+/)) {
        if (/starting|pulling|applying|waiting|health|finished|started|stopping|error|failed|warning/i.test(line)
          && !/key|secret|password|eyJ|sb_secret/i.test(line)) console.log(redact(line).slice(0, 300));
      }
    };
    child.stdout.on("data", b => accept(b, false));
    child.stderr.on("data", b => accept(b, true));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(redact(err || out).slice(-1500))));
    child.stdin.end(input);
  });
}
const supabase = (args, progress = false) => run(process.execPath, [cli, "--workdir", workdir, ...args], progress);
async function scopeDocker() {
  const bin = path.join(workdir, "bin");
  await fs.mkdir(bin, { recursive: true });
  const real = (await run(process.platform === "win32" ? "where.exe" : "which", ["docker"]))
    .trim().split(/\r?\n/).find(p => process.platform !== "win32" || p.toLowerCase().endsWith(".exe"));
  if (!real || path.dirname(real) === bin) throw new Error("Cannot resolve the real Docker CLI.");
  const proxy = path.join(root, "scripts", "docker-loopback-proxy.cjs");
  if (process.platform === "win32") {
    const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const source = path.join(bin, "docker-proxy.cs");
    await fs.writeFile(source, `using System; using System.Diagnostics; using System.Text;
class DockerProxy {
  static string Q(string value) {
    var s = new StringBuilder("\\\""); int slashes = 0;
    foreach (char c in value) { if (c == '\\\\') { slashes++; continue; }
      if (c == '\\"') { s.Append('\\\\', slashes * 2 + 1); s.Append(c); slashes = 0; continue; }
      s.Append('\\\\', slashes); slashes = 0; s.Append(c);
    } s.Append('\\\\', slashes * 2); s.Append('\\"'); return s.ToString();
  }
  static int Main(string[] args) {
    var p = new ProcessStartInfo(); p.FileName = Environment.GetEnvironmentVariable("CAMPUSMATE_NODE");
    p.Arguments = Q(Environment.GetEnvironmentVariable("CAMPUSMATE_DOCKER_PROXY"));
    foreach (var arg in args) p.Arguments += " " + Q(arg);
    p.UseShellExecute = false; p.CreateNoWindow = true;
    p.RedirectStandardInput = true; p.RedirectStandardOutput = true; p.RedirectStandardError = true;
    using(var child = Process.Start(p)) {
      var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      System.Threading.Tasks.Task.Run(() => { try {
        Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream); child.StandardInput.Close();
      } catch {} });
      child.WaitForExit(); System.Threading.Tasks.Task.WaitAll(output, error); return child.ExitCode;
    }
  }
}`);
    await run(csc, ["/nologo", "/target:exe", `/out:${path.join(bin, "docker.exe")}`, source]);
  } else {
    await fs.writeFile(path.join(bin, "docker"), `#!/usr/bin/env node\nrequire(${JSON.stringify(proxy)});\n`, { mode: 0o700 });
  }
  scopedEnv = { ...process.env, CAMPUSMATE_REAL_DOCKER: real, CAMPUSMATE_NODE: process.execPath,
    CAMPUSMATE_DOCKER_PROXY: proxy, CAMPUSMATE_ORIGINAL_PATH: process.env.PATH,
    PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
async function prepare() {
  await fs.mkdir(path.join(workdir, "supabase", "migrations"), { recursive: true });
  await fs.copyFile(path.join(root, "supabase", "config.toml"), path.join(workdir, "supabase", "config.toml"));
  let old = {};
  try { old = JSON.parse(await fs.readFile(path.join(workdir, "migration-hashes.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const hashes = {};
  for (const [target, source] of migrations) {
    const text = await fs.readFile(path.join(root, source), "utf8");
    const hash = createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
    if (old[target] && old[target] !== hash) throw new Error(`Migration changed: ${source}. Add a new migration; do not reset existing data.`);
    hashes[target] = hash;
    await fs.writeFile(path.join(workdir, "supabase", "migrations", target), text);
  }
  await fs.writeFile(path.join(workdir, "migration-hashes.json"), JSON.stringify(hashes, null, 2));
}
async function status() {
  const raw = await supabase(["status", "-o", "json"]);
  try { return JSON.parse(raw); } catch { throw new Error("Could not parse local status JSON (credentials not displayed)."); }
}
async function checkBindings() {
  const list = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  const names = list.trim().split(/\r?\n/).filter(n => n.endsWith(`_${project}`));
  if (!names.length) throw new Error("No CampusMate containers found; refusing to report the DB ready.");
  const containers = JSON.parse(await run("docker", ["inspect", ...names]));
  const unsafe = containers.flatMap(c => Object.values(c.HostConfig.PortBindings ?? {}).flatMap(v => v ?? [])).filter(p => !["127.0.0.1", "::1"].includes(p.HostIp));
  if (unsafe.length) {
    await supabase(["stop"]);
    throw new Error("Docker did not honor loopback port bindings; CampusMate was stopped without deleting data.");
  }
}
function localUrl(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Refusing non-loopback configuration.");
  return url;
}
async function writeEnv(data) {
  const api = localUrl(data.API_URL ?? data.api_url).href.replace(/\/$/, "");
  const anon = data.ANON_KEY ?? data.anon_key ?? data.PUBLISHABLE_KEY ?? data.publishable_key;
  if (!anon) throw new Error("Local Supabase status did not provide a browser key.");
  const filename = path.join(root, "web", ".env.development.local");
  const marker = "# CampusMate managed local Docker environment";
  let old = "";
  try { old = await fs.readFile(filename, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (old && !old.startsWith(marker)) throw new Error("Existing frontend env is not managed by this script; leaving it unchanged.");
  // Keep browser execution until every Runtime store is durable. No pretend full rollout.
  await fs.writeFile(filename, `${marker}\nVITE_SUPABASE_URL=${api}\nVITE_SUPABASE_ANON_KEY=${anon}\nVITE_BACKEND_URL=\n`);
  const db = localUrl(data.DB_URL ?? data.db_url);
  db.searchParams.set("sslmode", "disable");
  await fs.writeFile(path.join(workdir, "runtime.env"), `DATABASE_URL=${db.href}\nSUPABASE_URL=${api}\n`);
  console.log("[local-db] Wrote gitignored local config; no model key changed. Restart Vite to enable local sign-in.");
}

try {
  const action = process.argv[2] ?? "status";
  if (!["start", "stop", "status", "env"].includes(action)) throw new Error("Use start, stop, status or env (no automatic reset/delete command).");
  if (action === "start") {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    await prepare();
    await scopeDocker();
    let exists = true;
    try { await run("docker", ["network", "inspect", network]); } catch { exists = false; }
    if (!exists) await run("docker", ["network", "create", "--label", `com.campusmate.project=${project}`, "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network]);
    const [net] = JSON.parse(await run("docker", ["network", "inspect", network]));
    if (net.Labels?.["com.campusmate.project"] !== project || net.Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1") {
      throw new Error("Existing network is not the expected CampusMate loopback network; leaving it unchanged.");
    }
    console.log("[local-db] Starting isolated Docker DB + Auth + REST; the first run downloads images.");
    await supabase(["start", "--network-id", network, "--exclude", excluded], true);
    await checkBindings();
    // Explicit local-only migration command; no cloud link/push and no db reset.
    await supabase(["migration", "up", "--local"], true);
    console.log("[local-db] Ready (loopback only). Run npm run db:env, then restart the web dev server.");
  } else if (action === "stop") {
    await supabase(["stop"], true);
    console.log("[local-db] Stopped this project only; database volumes retained.");
  } else {
    await checkBindings();
    const data = await status();
    if (action === "env") await writeEnv(data);
    else console.log(JSON.stringify({ ready: true, api: data.API_URL ?? data.api_url, database: "127.0.0.1:56422", credentials: "not displayed" }, null, 2));
  }
} catch (error) { console.error("[local-db]", redact(error.message)); process.exitCode = 1; }
