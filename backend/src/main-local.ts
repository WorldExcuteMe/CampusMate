import "./load-env.ts";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import { startLocalApp } from "./runtime/local-app.ts";
import { validateSourceGrants } from "./runtime/linked-sources.ts";
import { includesPath } from "./runtime/workspace-files.ts";

const { values } = parseArgs({ options: {
  workspace: { type: "string" }, port: { type: "string", default: "8790" },
  "campus-origin": { type: "string", multiple: true },
  "qq-group": { type: "string", multiple: true },
  "wechat-group": { type: "string", multiple: true },
  "allow-remote-workspace-data": { type: "boolean" },
  "source-config": { type: "string" },
} });
if (!values.workspace) throw new Error("使用 npm run local -- --workspace <现有目录> [--port 8790]");
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口应在 1024–65535 之间");
let sourceGrants;
if (values["source-config"]) {
  const config = await fs.realpath(values["source-config"]);
  if (includesPath(await fs.realpath(values.workspace), config)) throw new Error("数据源授权配置须保存在工作区之外");
  sourceGrants = validateSourceGrants(JSON.parse(await fs.readFile(config, "utf8")));
}
const app = await startLocalApp({ directory: values.workspace, port,
  sourceGrants,
  campusOrigins: values["campus-origin"], qqGroups: values["qq-group"], wechatGroups: values["wechat-group"],
  allowRemoteWorkspaceData: values["allow-remote-workspace-data"],
  webRoot: fileURLToPath(new URL("../../web/dist/", import.meta.url)), env: process.env });
console.log(`CampusMate 本地工作区 · ${app.baseUrl}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => { await app.close(); });
}
