// Scoped ONLY to Supabase CLI's child environment, never installed globally.
// Docker Desktop may ignore bridge host_binding_ipv4, so make -p explicit.
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (["create", "run"].includes(args[0])) {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--publish") {
      const value = args[i + 1];
      if (/^\d+:\d+(?:\/(?:tcp|udp))?$/.test(value)) args[i + 1] = `127.0.0.1:${value}`;
      else if (!value?.startsWith("127.0.0.1:")) { console.error("[local-db] Refusing a non-loopback port publication."); process.exit(1); }
      i++;
    }
  }
}
const real = process.env.CAMPUSMATE_REAL_DOCKER;
if (!real) throw new Error("Missing scoped Docker executable");
const result = spawnSync(real, args, { stdio: "inherit", windowsHide: true,
  env: { ...process.env, PATH: process.env.CAMPUSMATE_ORIGINAL_PATH ?? process.env.PATH } });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
