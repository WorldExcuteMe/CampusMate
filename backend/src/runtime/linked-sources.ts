import { validDate } from "../../../shared/calendar.ts";
import { createSchedulePreview } from "../core/schedule-import.ts";
import type { AppContext } from "../app-context.ts";
import { text, tool, type WorkspaceTool } from "./workspace-tools.ts";
import { canonicalArgs, sha256 } from "./idempotency.ts";

export type SourceDataset = "messages" | "timetable" | "reference";
export type SourceFormat = "json-cursor" | "csv" | "ics" | "html";
export interface SourceGrant { id: string; label: string; dataset: SourceDataset; url: string; format: SourceFormat; bearer?: string; expectedMarker?: string; }
export interface SourceArtifact {
  title: string; sourceId: string; dataset: SourceDataset; format: SourceFormat;
  records: number; pages: number; verifiedTotal: number | null; complete: true; text: string;
  from?: string; to?: string;
}
export type StoredSourceArtifact = SourceArtifact & { contentSha256: string };
const formats = new Set(["json-cursor", "csv", "ics", "html"]);
const datasets = new Set(["messages", "timetable", "reference"]);
const mime: Record<SourceFormat, string> = {
  "json-cursor": "application/json", csv: "text/csv", ics: "text/calendar", html: "text/html",
};
const LIMIT_BYTES = 1_000_000;
const LIMIT_PAGES = 32;

export function validateSourceGrants(input: unknown, allowLoopback = false): SourceGrant[] {
  if (!Array.isArray(input) || input.length > 20) throw new Error("授权数据源必须为不超过 20 项的数组");
  const ids = new Set<string>(), proven: SourceGrant[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object") throw new Error("授权数据源配置无效");
    const spec = value as SourceGrant;
    if (typeof spec.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(spec.id) || ids.has(spec.id) ||
      typeof spec.label !== "string" || !spec.label.trim() || spec.label.length > 120 ||
      !datasets.has(spec.dataset) || !formats.has(spec.format) || typeof spec.url !== "string" ||
      (spec.format === "html" && (typeof spec.expectedMarker !== "string" || !spec.expectedMarker.trim() || spec.expectedMarker.length > 120)) ||
      (spec.bearer !== undefined && (typeof spec.bearer !== "string" || !/^[!-~]{1,4096}$/.test(spec.bearer)))) throw new Error("授权数据源配置无效");
    let url: URL;
    try { url = new URL(spec.url); } catch { throw new Error("授权数据源 URL 无效"); }
    const localFixture = allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1";
    if ((!localFixture && url.protocol !== "https:") || url.username || url.password || url.hash ||
      ["cursor", "from", "to"].some(key => url.searchParams.has(key))) throw new Error("授权源须为专用 HTTPS URL，游标和日期参数由工具管理");
    ids.add(spec.id);
    proven.push({ id: spec.id, label: spec.label, dataset: spec.dataset, format: spec.format, url: url.href, bearer: spec.bearer, expectedMarker: spec.expectedMarker });
  }
  return proven;
}

async function readBounded(response: Response, budget: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) throw new Error("源响应没有内容");
  const reader = response.body.getReader();
  const blocks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > budget) throw new Error("源超过本次读取上限，调整所选范围后再试");
      blocks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(blocks)), bytes };
}

export async function collectSource(grant: SourceGrant, range: { from?: string; to?: string }, fetchImpl: typeof fetch = fetch): Promise<SourceArtifact> {
  if ((range.from !== undefined && !validDate(range.from)) || (range.to !== undefined && !validDate(range.to)) ||
      (range.from && range.to && range.to < range.from)) throw new Error("日期应为 YYYY-MM-DD 且结束日期不早于开始日期");
  const base = new URL(grant.url);
  if (range.from) base.searchParams.set("from", range.from);
  if (range.to) base.searchParams.set("to", range.to);
  const headers = { Accept: mime[grant.format], ...(grant.bearer ? { Authorization: "Bearer " + grant.bearer } : {}) };
  const signal = AbortSignal.timeout(22000);
  const records = new Map<string, unknown>(), cursors = new Set<string>();
  let cursor: string | null = null, remaining = LIMIT_BYTES, declaredTotal: number | null = null, pages = 0;
  for (; pages < LIMIT_PAGES; pages++) {
    const url = new URL(base);
    if (cursor) url.searchParams.set("cursor", cursor);
    let response: Response;
    try { response = await fetchImpl(url, { headers, redirect: "error", signal }); }
    catch { throw new Error("连接授权源失败或来源跳转，请检查该数据源的工作状态"); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new Error("源拒绝访问，请在来源服务更新授权");
      throw new Error(`来源返回 HTTP ${response.status}`);
    }
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== mime[grant.format]) {
      await response.body?.cancel();
      throw new Error("响应格式与授权源配置不符，可能已跳到登录页");
    }
    const data = await readBounded(response, remaining);
    remaining -= data.bytes;
    if (!data.text.trim() || (grant.format === "html" && (!grant.expectedMarker || !data.text.includes(grant.expectedMarker)))) throw new Error("未验证到已登录目标页面的预期内容");
    if (grant.format !== "json-cursor") return {
      title: grant.label, sourceId: grant.id, dataset: grant.dataset, format: grant.format, pages: 1,
      text: data.text, complete: true, records: 0, verifiedTotal: null, ...range,
    };
    let payload: { records?: unknown; nextCursor?: unknown; total?: unknown };
    try { payload = JSON.parse(data.text); } catch { throw new Error("授权数据源返回无效 JSON"); }
    if (!payload || !Array.isArray(payload.records) ||
      !(payload.nextCursor === null || (typeof payload.nextCursor === "string" && payload.nextCursor.length <= 512 && payload.nextCursor.length > 0))) {
      throw new Error("分页响应必须提供记录及明确的下一页游标");
    }
    if (payload.total !== undefined) {
      if (typeof payload.total !== "number" || !Number.isSafeInteger(payload.total) || payload.total < 0 ||
        (declaredTotal !== null && declaredTotal !== payload.total)) throw new Error("分页来源的总记录数变化");
      declaredTotal = payload.total;
    }
    for (const row of payload.records) {
      const key = row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
      if (typeof key !== "string" || key.length < 1 || key.length > 200) throw new Error("源记录缺少稳定 ID");
      if (records.has(key) && JSON.stringify(records.get(key)) !== JSON.stringify(row)) throw new Error("分页来源的同一记录发生变化");
      records.set(key, row);
      if (records.size > 10000) throw new Error("记录数超过单次读取上限");
    }
    cursor = payload.nextCursor;
    if (cursor === null) {
      if (declaredTotal !== null && records.size !== declaredTotal) throw new Error("去重后的记录数与来源声明的总数不符");
      return { title: grant.label, sourceId: grant.id, dataset: grant.dataset, format: grant.format,
        pages: pages + 1, text: [...records.values()].map(row => JSON.stringify(row)).join("\n"),
        complete: true, records: records.size, verifiedTotal: declaredTotal, ...range };
    }
    if (cursors.has(cursor)) throw new Error("来源分页游标重复，不能确认读完");
    cursors.add(cursor);
  }
  throw new Error("已达分页上限，不能确认范围完整");
}

export function linkedSourceTools(ctx: AppContext, grantsFor: (owner: string) => SourceGrant[]): WorkspaceTool[] {
  const scoped = (item: Omit<WorkspaceTool, "capability" | "execute">): WorkspaceTool => ({
    ...item, capability: "data.source", execute: () => { throw new Error("数据源需要真实任务上下文"); },
  });
  return [
    scoped({
      definition: tool("source_catalog", "列出当前账户已配置的授权数据源，包含用途和格式。", {}, []),
      runForTask: async (task) => grantsFor(task.userId).map(({ id, label, dataset, format }) => ({ id, label, dataset, format })),
    }),
    scoped({
      definition: tool("source_collect", "从已授权来源按可选日期范围读取并保存完整原档。返回实际下载路径、条数和分页范围。只要求归档或覆盖统计时可直接交付这份原档和统计；需要内容推断时，再分页读取相关片段。", { sourceId: text, from: text, to: text }, ["sourceId"]),
      privateSource: true,
      approval: (args) => `读取已授权来源 ${args.sourceId} ${args.from ?? ""} 至 ${args.to ?? ""}`,
      runForTask: async (task, args) => {
        const grant = grantsFor(task.userId).find(item => item.id === args.sourceId);
        if (!grant) throw new Error("当前账户没有该数据源授权");
        const collected = await collectSource(grant, {
          ...(typeof args.from === "string" ? { from: args.from } : {}),
          ...(typeof args.to === "string" ? { to: args.to } : {}),
        });
        const { text: raw, ...facts } = collected;
        const contentSha256 = sha256(raw);
        const inline: StoredSourceArtifact = { ...collected, contentSha256 };
        const saved = await ctx.artifactStore.create({ taskId: task.id, userId: task.userId, kind: "linked-source", sha256: sha256(canonicalArgs(inline)), inline });
        return { artifactId: saved.id, downloadPath: `/v1/artifacts/${saved.id}/download`, contentSha256, bytes: Buffer.byteLength(raw), ...facts };
      },
    }),
    scoped({
      definition: tool("source_timetable_preview", "为本人已采集的 CSV 或 ICS 课表产物创建课表导入预览。返回链接供用户确认，预览不写入课表。", { artifactId: text, termId: text }, ["artifactId", "termId"]),
      privateSource: true,
      approval: (args) => `为学期 ${args.termId} 创建课表导入预览`,
      runForTask: async (task, args) => {
        const artifact = await ctx.artifactStore.get(task.userId, String(args.artifactId));
        const source = artifact?.inline as SourceArtifact | undefined;
        if (!artifact || artifact.kind !== "linked-source" || !source?.complete || source.dataset !== "timetable" || (source.format !== "csv" && source.format !== "ics")) {
          throw new Error("请选择本人已完整读取的 CSV 或 ICS 课表产物");
        }
        const term = (await ctx.personalContext.listTerms(task.userId)).find(item => item.id === args.termId);
        if (!term) throw new Error("未找到匹配的本人学期，请提供实际的学期标识");
        const preview = await createSchedulePreview(ctx.personalContext, task.userId, term, { format: source.format, data: source.text, sourceName: source.title });
        const metadata = { jobId: preview.jobId, termId: term.id, sourceArtifactId: artifact.id, title: source.title };
        await ctx.artifactStore.create({ userId: task.userId, taskId: task.id, kind: "linked-timetable-preview", sha256: sha256(canonicalArgs(metadata)), inline: metadata });
        return { previewUrl: "/calendar?import=" + preview.jobId, rows: preview.preview.schedules.length,
          errors: preview.preview.errors.slice(0, 10), errorCount: preview.preview.errors.length, confirmed: false };
      },
    }),
    scoped({
      definition: tool("source_terms", "列出本人课表可用的学期及起止日期。", {}, []),
      runForTask: async (task) => (await ctx.personalContext.listTerms(task.userId)).map(({ id, name, startDate, endDate, totalWeeks }) => ({ id, name, startDate, endDate, totalWeeks })).slice(0, 20),
    }),
  ];
}
