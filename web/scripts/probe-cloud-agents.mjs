// 手动技术探针：默认只读检查；--run 才创建云资源并消耗额度，不是 Sites 验收或模型评测。
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createCloudAgentsClient, CloudAgentError } from "../functions/cloud-agents.ts";
import { readCloudEvents, CloudStreamError } from "../functions/cloud-events.ts";

const args = process.argv.slice(2);
const mode = args[0] ?? "--check";
if (mode === "--help") {
  console.log("用法：node scripts/probe-cloud-agents.mjs [--check | --run [--notice 文件路径]]");
  console.log("--check：使用服务端 QODER_ACCESS_TOKEN 或 QODER_PAT，只读检查 Environment 列表。");
  console.log("--run：创建独立 Environment、Agent、Session，执行真实通知到 Markdown 黄金流（消耗额度）。");
  console.log("密钥不得放入命令参数、VITE_*、提交或日志。仅支持已核实的 https://api.qoder.com 区域端点。");
  process.exit(0);
}
if (!["--check", "--run"].includes(mode) ||
    !(args.length <= 1 || mode === "--run" && args.length === 3 && args[1] === "--notice")) {
  console.error(JSON.stringify({ status: "blocked", error: "invalid_arguments" }));
  process.exit(2);
}

const evidence = { kind: "cloud-agents-direct-probe", mode, sitesVerified: false, liveAttempted: false, startedAt: new Date().toISOString() };
let client;
let sessionId;
let completed = false;
try {
  client = createCloudAgentsClient({
    accessToken: process.env.QODER_ACCESS_TOKEN || process.env.QODER_PAT || "",
    baseUrl: process.env.QODER_API_BASE_URL || undefined,
  });
  if (mode === "--check") {
    evidence.liveAttempted = true;
    const page = await client.listEnvironments();
    console.log(JSON.stringify({ ...evidence, status: "connected", environmentsOnFirstPage: page.data.length, hasNextPage: page.next_page !== null }));
  } else {
    let notice = "【技术验证用虚构通知】2026-11-23 18:30，学生活动中心201室举行校园志愿服务培训；请于2026-11-22 20:00前完成报名。主办方未提供报名链接，请标注待确认。请整理为可下载的 Markdown 文档。";
    if (args[1] === "--notice") {
      if ((await stat(args[2])).size > 64 * 1024) throw new CloudAgentError("notice_too_large", 400);
      notice = await readFile(args[2], "utf8");
    }
    if (!notice.trim() || Buffer.byteLength(notice) > 64 * 1024) throw new CloudAgentError("invalid_notice", 400);
    evidence.liveAttempted = true;
    const environment = await client.createEnvironment();
    evidence.environmentId = environment.id;
    console.log(JSON.stringify({ stage: "environment_created", id: environment.id }));
    const agent = await client.createNoticeAgent();
    evidence.agentId = agent.id;
    evidence.agentVersion = agent.version;
    console.log(JSON.stringify({ stage: "agent_created", ...agent }));
    const session = await client.createSession(agent, environment.id);
    sessionId = session.id;
    evidence.sessionId = sessionId;
    console.log(JSON.stringify({ stage: "session_created", id: sessionId }));
    // 发送只有一次。响应丢失时保留 Session ID 供人工核查，不自动再次发送。
    const sent = await client.sendMessage(sessionId, notice);
    let lastEventId = sent.at(-1)?.id;
    const seen = new Set(sent.map(event => event.id));
    const calls = new Map();
    const succeeded = new Set();
    const artifacts = new Map();
    const deadline = Date.now() + 360_000;
    let ended = false;
    let connections = 0;
    let heartbeats = 0;
    let stopReason;
    while (!ended && Date.now() < deadline && connections < 24) {
      connections++;
      try {
        const response = await client.streamEvents(sessionId, lastEventId, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        for await (const event of readCloudEvents(response.body)) {
          if (event.type === "heartbeat") { heartbeats++; continue; }
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          lastEventId = event.id;
          if (event.type === "agent.tool_use") calls.set(event.id, event.name);
          if (event.type === "agent.tool_result" && event.is_error === false) succeeded.add(calls.get(event.tool_use_id));
          if (event.type === "agent.artifact_delivered" && typeof event.file_id === "string") artifacts.set(event.file_id, event);
          if (event.type === "session.status_terminated") throw new CloudAgentError("cloud_session_terminated");
          if (event.type === "session.status_idle") { stopReason = event.stop_reason?.type; ended = true; break; }
        }
      } catch (error) {
        const reconnectable = error instanceof CloudStreamError && error.message === "cloud_stream_interrupted" ||
          error instanceof CloudAgentError && ["cloud_request_timeout", "cloud_request_aborted", "cloud_unavailable"].includes(error.message);
        if (!reconnectable) throw error;
      }
      if (!ended && Date.now() < deadline) await delay(Math.min(1000, deadline - Date.now()));
    }
    evidence.connections = connections;
    evidence.heartbeats = heartbeats;
    evidence.eventCount = seen.size;
    evidence.lastEventId = lastEventId;
    evidence.stopReason = stopReason;
    if (!ended) throw new CloudAgentError("cloud_probe_deadline", 504);
    if (stopReason !== "end_turn") throw new CloudAgentError("cloud_turn_not_completed");
    if (!["Write", "Read", "DeliverArtifacts"].every(name => succeeded.has(name))) throw new CloudAgentError("cloud_tool_evidence_incomplete");
    const artifact = [...artifacts.values()].find(item => item.original_filename === "campusmate-notice.md" && item.size > 0);
    if (!artifact) throw new CloudAgentError("cloud_artifact_missing");
    const link = await client.getDownloadLink(artifact.file_id);
    // 只向平台产物域下载，不跟随重定向，不附带 PAT，也不打印签名 URL。
    const url = new URL(link.url);
    if (!(url.hostname === "storage.qoder.com" || url.hostname.endsWith(".qoder.com")) || url.port) {
      throw new CloudAgentError("cloud_artifact_host_unverified");
    }
    if (Date.parse(link.expires_at) <= Date.now()) throw new CloudAgentError("cloud_artifact_link_expired");
    const download = await fetch(link.url, { redirect: "error", signal: AbortSignal.timeout(25_000) });
    if (!download.ok || !download.body) { await download.body?.cancel(); throw new CloudAgentError("cloud_artifact_download_failed"); }
    const chunks = [];
    let size = 0;
    const reader = download.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) throw new CloudAgentError("cloud_artifact_too_large");
        chunks.push(value);
      }
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    const bytes = Buffer.concat(chunks);
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!markdown.trim() || size !== artifact.size || !/^#{1,6}\s+\S/m.test(markdown)) throw new CloudAgentError("cloud_artifact_invalid");
    // 仅证明工具、交付和文件传输闭环，内容质量需另行人工验收；不是外部测评得分。
    completed = true;
    console.log(JSON.stringify({ ...evidence, status: "artifact_verified", fileId: artifact.file_id, bytes: size,
      sha256: createHash("sha256").update(bytes).digest("hex"), durationMs: Date.now() - Date.parse(evidence.startedAt),
      contentQualityVerified: false }));
  }
} catch (error) {
  const code = error instanceof CloudAgentError || error instanceof CloudStreamError ? error.message : "probe_failed";
  console.error(JSON.stringify({ ...evidence, status: "blocked", error: code }));
  process.exitCode = 2;
} finally {
  // 仅取消本次新建且未成功验收的 Session；保留资源供核查，不自动删除。
  if (client && sessionId && !completed) {
    try { await client.cancelSession(sessionId); console.log(JSON.stringify({ stage: "cancel_requested", sessionId })); }
    catch { console.error(JSON.stringify({ stage: "cancel_failed", sessionId, action: "请在 Cloud Agents 控制台检查并停止本次会话" })); }
  }
}
