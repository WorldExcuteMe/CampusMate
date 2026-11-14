import { deflateSync } from "node:zlib";
import type { DocumentAst } from "../../../shared/document.ts";
function samplePng(): string {
  const crc = (data: Buffer) => { let c = 0xffffffff; for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (tag: string, bytes: Buffer) => { const data = Buffer.concat([Buffer.from(tag), bytes]), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(data)); return Buffer.concat([size, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(160, 0); header.writeUInt32BE(80, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(80 * (160 * 3 + 1)); for (let y = 0; y < 80; y++) for (let x = 0; x < 160; x++) { const i = y * 481 + 1 + x * 3; raw[i] = 75; raw[i + 1] = 95 + y; raw[i + 2] = 170 + Math.floor(x / 3); }
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
export function richDocument(): DocumentAst {
  return { schemaVersion: 1, title: "校园信息助手竞赛项目策划书", kind: "document", sources: [{ id: "Sdemo", url: "https://school.example/competition", title: "竞赛主办方项目要求", excerpt: "测试用合成资料，不代表真实竞赛要求。", retrievedAt: Date.parse("2026-11-15T00:00:00Z"), status: "retrieved" }], blocks: [
    { type: "heading", level: 2, text: "项目背景与目标" },
    ...Array.from({ length: 4 }, (_, i) => ({ type: "paragraph" as const, claimType: "proposal" as const, sourceIds: ["Sdemo"], text: `第${i + 1}部分。` + "我们计划把课程安排、通知与竞赛机会组织到统一的工作台中。项目先收集匿名需求，再搭建最小可用原型，最后用明确的验收场景检验信息准确性和操作成本。所有投入金额为待讨论的预算，不表示已经获得经费支持。".repeat(2) })),
    { type: "list", ordered: true, items: ["完成需求访谈并记录可核对的问题", "明确课程导入与文档交付验收", "组织一次校内用户体验测试"], claimType: "proposal" },
    { type: "heading", level: 2, text: "团队进度与资源预算" },
    { type: "table", headers: ["阶段", "交付内容", "预算元"], rows: Array.from({ length: 42 }, (_, i) => [`阶段${i + 1}`, `完成第${i + 1}项需求核对和实现验证，记录发现的问题、修复结果及负责人。`, String(100 + i * 10)]), claimType: "estimate" },
    { type: "heading", level: 2, text: "预期成果与评估" }, { type: "image", src: samplePng(), alt: "校园信息示意图", caption: "测试用程序生成的示意图" },
    { type: "chart", title: "计划投入分布", labels: ["需求整理", "系统开发", "验收测试"], values: [20, 50, 30] },
    { type: "paragraph", text: '特殊字符核对：<script>alert("x")</script>、A & B、人民币 ¥、比较 a < b。', claimType: "unverified" }, { type: "reference", sourceId: "Sdemo" },
  ] };
}
