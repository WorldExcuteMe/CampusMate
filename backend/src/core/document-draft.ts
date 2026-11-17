import type { ChatMessage, ToolDef } from "./types.ts";
import type { DocumentBlock } from "../../../shared/document.ts";
import { sha256 } from "../runtime/idempotency.ts";
import { looksLikeToolCall } from "./tool-protocol.ts";

export interface DraftReference { blocks: DocumentBlock[]; sourceSha256: string; }
const inline = (text: string) => text.replace(/\$([^$\n]+)\$/g, (original, formula: string) => {
  if (!/\\(?:text|rightarrow|to|times|le|ge)\b/.test(formula)) return original;
  const plain = formula.replace(/\\text\{([^{}]*)\}/g, "$1").replace(/\\(?:rightarrow|to)\b/g, "→").replace(/\\times\b/g, "×").replace(/\\le\b/g, "≤").replace(/\\ge\b/g, "≥");
  if (/\\[a-z]+/i.test(plain)) return original;
  return plain.replace(/_\{([^{}]+)\}/g, "_$1").replace(/\^\{([^{}]+)\}/g, "^$1");
}).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(s => inline(s.replace(/\\\|/g, "|")));

// Deliberately a bounded subset, not a CommonMark renderer. Unsupported rich
// material keeps the existing creation route instead of silently losing data.
function draftBlocks(source: string): DocumentBlock[] | undefined {
  if (source.length < 200 || source.length > 80000 || /```|~~~|!\[[^\]]*\]\(/.test(source) || looksLikeToolCall(source) || /^\s*(?:\[未完成草稿\]|任务未通过|模型连接失败|工具指令尚未|模型输出未完成|数据库连接|等待人工)/.test(source)) return;
  const lines = source.split(/\r?\n/), blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => { const text = inline(paragraph.join("\n")); if (text) blocks.push({ type: "paragraph", text }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { flush(); blocks.push({ type: "heading", level: Math.min(3, heading[1].length) as 1 | 2 | 3, text: inline(heading[2]) }); continue; }
    if (/^\*\*\d+(?:\.\d+){1,2}\s+[^*]{1,100}\*\*$/.test(line)) { flush(); blocks.push({ type: "heading", level: 3, text: inline(line) }); continue; }
    if (/^[-*_]{3,}$/.test(line)) { flush(); continue; }
    if (line.includes("|") && i + 1 < lines.length && cells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
      flush(); const headers = cells(line), rows: string[][] = []; i++;
      while (i + 1 < lines.length && lines[i + 1].trim().includes("|")) {
        const row = cells(lines[++i]); if (row.length !== headers.length) return; rows.push(row);
      }
      if (!headers.length || headers.length > 30 || rows.length > 100) return;
      blocks.push({ type: "table", headers, rows }); continue;
    }
    const list = /^([-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (list) {
      flush(); const ordered = /^\d/.test(list[1]), items = [inline(list[2])];
      while (i + 1 < lines.length) {
        const next = /^([-*+]\s+|\d+[.)]\s+)(.+)$/.exec(lines[i + 1].trim());
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        i++; items.push(inline(next[2]));
      }
      blocks.push({ type: "list", items, ordered }); continue;
    }
    paragraph.push(line);
  }
  flush();
  if (!blocks.length || blocks.length > 500 || blocks.some(block => JSON.stringify(block).length > 25000)) return;
  return blocks;
}

export function draftReference(intent: string, history: ChatMessage[] | undefined): DraftReference | undefined {
  const provided = /【文稿开始】\s*([\s\S]*?)\s*【文稿结束】/.exec(intent);
  const control = provided ? intent.slice(0, provided.index) : intent;
  if (!/(?:生成|创建|保存|导出|转换|转成).{0,30}(?:文档|Word|PDF|DOCX|document_create)|(?:文档|Word|PDF|DOCX).{0,12}(?:生成|创建|保存|导出|转换)/i.test(control)) return;
  if (/只.{0,8}(?:预览|提纲)|(?:等我|待我)确认|(?:不要|暂不|先不|勿)(?:保存|写入|创建|生成|导出)(?:任何|[，。；！？\s]|$)/.test(control)) return;
  const actions = control.replace(/(?:不要|无需|不用|不必|勿)(?:重新)?(?:改写|重写|补写|核验|检索|查证)/g, "");
  if (/重新(?:核验|检索|查证|改写)|补写|重写/.test(actions)) return;
  if (!provided && !/(?:刚才|上[一轮步条]+|前面|上述).{0,12}(?:正文|原稿|草稿|内容)/.test(control)) return;
  const latest = history?.findLast(message => message.role === "assistant");
  const source = provided?.[1] ?? (latest && !latest.tool_calls?.length && typeof latest.content === "string" ? latest.content : "");
  const blocks = draftBlocks(source); if (!blocks) return;
  return { blocks, sourceSha256: sha256(source) };
}

export function draftReferenceTools(tools: ToolDef[]): ToolDef[] {
  return tools.map(tool => tool.function.name !== "document_create" ? tool : ({ ...tool, function: { ...tool.function,
    description: "用户已明确要求将给出的完整原稿转换为文档。原稿在当前会话内已保存，不要重写正文或blocks；调用时只传title和fromDraft=true。服务端从原稿创建真实文档，不代表重新核实事实。成功后按用户要求调用检查和导出工具。",
    parameters: { type: "object", properties: { title: { type: "string" }, fromDraft: { type: "boolean", const: true } }, required: ["title", "fromDraft"], additionalProperties: false },
  } }));
}

export function resolveDraftArguments(name: string, args: Record<string, unknown>, draft: DraftReference | undefined): Record<string, unknown> {
  if (name !== "document_create" || !draft || args.fromDraft !== true) return args;
  let blocks = structuredClone(draft.blocks);
  if (typeof args.title === "string" && blocks[0]?.type === "heading" && blocks.filter(b => b.type === "heading").length > 1 && (blocks[0].text.includes(args.title) || args.title.includes(blocks[0].text))) blocks = blocks.slice(1);
  const headings = blocks.filter(block => block.type === "heading");
  const subsection = (text: string) => /^\d+(?:\.\d+){1,2}\s+/.test(text);
  const minLevel = Math.min(...headings.filter(block => !subsection(block.text)).map(block => block.level));
  for (const block of headings) block.level = subsection(block.text) ? 3 : Math.min(3, 2 + block.level - minLevel) as 2 | 3;
  return { title: args.title, blocks };
}
