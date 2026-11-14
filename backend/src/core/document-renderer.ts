import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, Footer, HeadingLevel, AlignmentType, WidthType, TableLayoutType, PageNumber } from "docx";
import JSZip from "jszip";
import subsetFont from "subset-font";
import { blockText, documentErrors, documentMarkdown, type DocumentAst, type DocumentBlock } from "../../../shared/document.ts";

export type DocumentFormat = "md" | "docx" | "pdf";
export const RENDERER_VERSION = "campusmate-doc-3-docx9.6.1-chromium1254-subset2.9";
export const MIME: Record<DocumentFormat, string> = { md: "text/markdown; charset=utf-8", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf" };
const FONT_FILE = new URL("../../assets/fonts/NotoSansCJKsc-Regular.otf", import.meta.url);
const FONT_HASH = "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";
const FONT_NAME = "Noto Sans CJK SC";
export class DocumentRenderUnavailable extends Error {}
export function availableDocumentFormats(pdfEnabled = true): DocumentFormat[] { return ["md", "docx", ...(pdfEnabled && existsSync(chromium.executablePath()) && existsSync(FONT_FILE) ? ["pdf" as const] : [])]; }
function validate(ast: DocumentAst) { const errors = documentErrors(ast); if (errors.length) throw new Error(errors[0]); if (JSON.stringify(ast).length > 4000000) throw new Error("文档超过4MB结构上限，请分卷"); }
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function tag(b: DocumentBlock): string { return "claimType" in b && b.claimType ? ({ fact: "[外部事实] ", proposal: "[建议方案] ", estimate: "[估算] ", unverified: "[待核实] " })[b.claimType] : ""; }
function refs(b: DocumentBlock): string { return "sourceIds" in b && b.sourceIds?.length ? " [" + b.sourceIds.join(", ") + "]" : ""; }
function chartHtml(b: Extract<DocumentBlock, { type: "chart" }>): string {
  const max = Math.max(1, ...b.values.map(Math.abs));
  return `<figure class="chart"><figcaption>${esc(b.title)}</figcaption>${b.labels.map((label, i) => `<div class="bar-row"><span>${esc(label)}</span><div><i style="width:${Math.abs(b.values[i]) / max * 100}%"></i></div><span>${b.values[i]}</span></div>`).join("")}</figure>`;
}
function columnFractions(headers: string[], rows: string[][]): number[] {
  const weights = headers.map((header, i) => Math.sqrt(Math.min(80, Math.max(4, header.length, rows.slice(0, 100).reduce((n, row) => n + row[i].length, 0) / Math.max(1, Math.min(rows.length, 100))))));
  const total = weights.reduce((a, b) => a + b, 0); return weights.map((w) => w / total);
}
function tableHtml(headers: string[], rows: string[][]): string { return `<table><colgroup>${columnFractions(headers, rows).map((f) => `<col style="width:${f * 100}%">`).join("")}</colgroup><thead><tr>${headers.map((s) => `<th>${esc(s)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((s) => `<td>${esc(s)}</td>`).join("")}</tr>`).join("")}</tbody></table>`; }
async function fontData(content: string): Promise<string> {
  const bytes = await fs.readFile(FONT_FILE);
  if (createHash("sha256").update(bytes).digest("hex") !== FONT_HASH) throw new DocumentRenderUnavailable("中文字体校验失败，请检查文档运行资源");
  // Drop unused cmap aliases before Chromium embeds the font; otherwise identical CJK
  // glyphs can be copied as compatibility radicals instead of the original characters.
  const characters = content.replace(/<[^>]*>/g, "") + Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join("");
  return (await subsetFont(bytes, characters, { targetFormat: "sfnt", keepFeatures: [], noLayoutClosure: true })).toString("base64");
}
async function trustedHtml(content: string): Promise<string> {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'"><style>@font-face{font-family:CampusDocument;src:url(data:font/otf;base64,${await fontData(content)})}*{box-sizing:border-box}body{margin:0;color:#111;font-family:CampusDocument,sans-serif;font-size:11pt;line-height:1.65;overflow-wrap:anywhere}h1,h2,h3{color:#000;break-after:avoid;font-weight:700}h1{font-size:22pt;line-height:1.4;margin:0 0 14pt}h2{font-size:15pt;margin:18pt 0 8pt}h3{font-size:12pt;margin:12pt 0 6pt}p{margin:0 0 9pt;orphans:3;widows:3;white-space:pre-wrap}ul,ol{padding-left:20pt;margin:0 0 10pt}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:10pt;line-height:1.5;margin:10pt 0 14pt}thead{display:table-header-group}th,td{border:0.5pt solid #b9bec5;padding:7pt 8pt;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#f1f2f4;color:#000;text-align:left;font-weight:700}tr{break-inside:avoid}figure{margin:12pt 0;break-inside:avoid}img{display:block;max-width:100%;max-height:6in;object-fit:contain;margin:auto}figcaption{font-size:10pt;margin-bottom:8pt;color:#222}.note,.reference{font-size:9pt;color:#555}.note.keep-next{break-after:avoid}li{break-inside:avoid}.reference{line-height:1.6;word-break:break-word}.bar-row{display:grid;grid-template-columns:130px 1fr 65px;gap:12px;align-items:center;font-size:10pt;margin:7px 0}.bar-row>div{height:16px;background:#f0f1f3}.bar-row i{display:block;height:16px;background:#727787}.chart{padding:12px;width:620px;max-width:100%}</style></head><body>${content}</body></html>`;
}
function bodyHtml(ast: DocumentAst): string {
  return `<h1>${esc(ast.title)}</h1><p class="note">AI生成内容，建议、估算及待核实事项请结合来源核对。</p>` + ast.blocks.map((b) => {
    const prefix = esc(tag(b)), suffix = esc(refs(b));
    switch (b.type) {
      case "heading": return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
      case "paragraph": return `<p>${prefix}${esc(b.text)}${suffix}</p>`;
      case "list": { const t = b.ordered ? "ol" : "ul"; return `<${t}>${b.items.map((s) => `<li>${prefix}${esc(s)}${suffix}</li>`).join("")}</${t}>`; }
      case "table": return `<p class="note keep-next">${prefix}${suffix}</p>` + tableHtml(b.headers, b.rows);
      case "image": return `<figure><img src="${b.src}" alt="${esc(b.alt)}"><figcaption>${esc(b.alt)}${b.caption ? " - " + esc(b.caption) : ""}</figcaption></figure>`;
      case "chart": return chartHtml(b) + tableHtml(["项目", "数值"], b.labels.map((s, i) => [s, String(b.values[i])]));
      case "reference": return `<p class="reference">参见来源 [${esc(b.sourceId)}]</p>`;
    }
  }).join("") + (ast.sources.length ? `<h2>参考来源</h2>${ast.sources.map((s) => `<p class="reference">[${esc(s.id)}] ${esc(s.title)}\n${esc(s.url)}\n取得于 ${new Date(s.retrievedAt).toISOString()}，网页已取得，事实需核对。</p>`).join("")}` : "");
}
async function withPrintPage<T>(content: string, work: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  let browser: Browser | undefined;
  const timeout = setTimeout(() => { void browser?.close().catch(() => {}); }, 30000);
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 15000 });
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport: { width: 816, height: 1056 } });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.setContent(await trustedHtml(content), { waitUntil: "load", timeout: 15000 });
    await page.evaluate("document.fonts.ready");
    if (!await page.evaluate("Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)")) throw new DocumentRenderUnavailable("图片数据无法解码，请使用有效的PNG/JPEG");
    return await work(page);
  } catch (e) { if (e instanceof DocumentRenderUnavailable) throw e; throw new DocumentRenderUnavailable("打印环境不可用或超过30秒，请检查固定Chromium及中文字体资源", { cause: e }); }
  finally { clearTimeout(timeout); await browser?.close().catch(() => {}); }
}
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 255 && bytes[1] === 216) { for (let offset = 2; offset + 8 < bytes.length;) { if (bytes[offset] !== 255) break; const marker = bytes[offset + 1], size = bytes.readUInt16BE(offset + 2); if ([192, 193, 194].includes(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }; if (size < 2) break; offset += size + 2; } }
  throw new Error("图片数据不是支持的PNG/JPEG");
}
function image(bytes: Buffer, type: "png" | "jpg", alt: string): Paragraph {
  const d = pngDimensions(bytes); if (d.width < 1 || d.height < 1 || d.width * d.height > 20000000) throw new Error("图片像素超出限制");
  const ratio = Math.min(1, 600 / d.width, 550 / d.height);
  return new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type, data: bytes, transformation: { width: Math.round(d.width * ratio), height: Math.round(d.height * ratio) }, altText: { name: alt.slice(0, 100), description: alt.slice(0, 500), title: alt.slice(0, 100) } })] });
}
async function wordBytes(ast: DocumentAst): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  const runs = (text: string, bold = false, size?: number) => text.split(/\r?\n/).map((s, i) => new TextRun({ text: s, ...(i ? { break: 1 } : {}), bold, ...(size ? { size } : {}) }));
  const paragraph = (text: string, extra: Partial<ConstructorParameters<typeof Paragraph>[0] & object> = {}) => new Paragraph({ children: runs(text), spacing: { after: 140, line: 320 }, ...extra });
  children.push(paragraph(ast.title, { heading: HeadingLevel.TITLE }), paragraph("AI生成内容，建议、估算及待核实事项请结合来源核对。"));
  const table = (headers: string[], rows: string[][]) => {
    const fractions = columnFractions(headers, rows);
    return new Table({ layout: TableLayoutType.FIXED, columnWidths: fractions.map((f) => Math.round(f * 10080)), width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headers, ...rows].map((row, index) => new TableRow({
      tableHeader: index === 0,
      // Keep ordinary rows together; exceptionally tall cells may continue onto another page.
      cantSplit: row.every((s, i) => s.length / Math.max(1, fractions[i] * 50) < 35),
      children: row.map((s, i) => new TableCell({ width: { size: fractions[i] * 100, type: WidthType.PERCENTAGE }, margins: { top: 100, bottom: 100, left: 120, right: 120 }, ...(index === 0 ? { shading: { fill: "F1F2F4" } } : {}), children: [new Paragraph({ spacing: { after: 60, line: 280 }, keepNext: false, children: runs(s, index === 0, 20) })] })),
    })) });
  };
  for (const b of ast.blocks) {
    switch (b.type) {
      case "heading": children.push(paragraph(b.text, { heading: b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, keepNext: true })); break;
      case "paragraph": children.push(paragraph(tag(b) + b.text + refs(b))); break;
      case "list": b.items.forEach((s, i) => children.push(paragraph(`${b.ordered ? `${i + 1}.` : "•"} ${tag(b)}${s}${refs(b)}`))); break;
      case "table": if (tag(b) || refs(b)) children.push(paragraph(tag(b) + refs(b), { keepNext: true })); children.push(table(b.headers, b.rows), paragraph("")); break;
      case "image": { const bytes = Buffer.from(b.src.split(",")[1], "base64"); children.push(image(bytes, b.src.startsWith("data:image/png") ? "png" : "jpg", b.alt), paragraph(b.alt + (b.caption ? " - " + b.caption : ""))); break; }
      case "chart": { const png = await withPrintPage(chartHtml(b), async (page) => Buffer.from(await page.locator(".chart").screenshot({ type: "png" }))); children.push(image(png, "png", b.title), paragraph(b.title), table(["项目", "数值"], b.labels.map((s, i) => [s, String(b.values[i])]))); break; }
      case "reference": children.push(paragraph(`参见来源 [${b.sourceId}]`)); break;
    }
  }
  if (ast.sources.length) { children.push(paragraph("参考来源", { heading: HeadingLevel.HEADING_2, keepNext: true })); ast.sources.forEach((s) => children.push(paragraph(`[${s.id}] ${s.title}\n${s.url}\n取得于 ${new Date(s.retrievedAt).toISOString()}，网页已取得，事实需核对。`))); }
  const blackHeading = { run: { color: "000000", font: FONT_NAME }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } };
  const doc = new Document({ creator: "CampusMate", title: ast.title, description: "Controlled document AST export", styles: { default: { document: { run: { font: { ascii: FONT_NAME, eastAsia: FONT_NAME }, size: 22, color: "111111" }, paragraph: { spacing: { after: 140, line: 320 } } }, title: { ...blackHeading, run: { ...blackHeading.run, size: 44, bold: true } }, heading1: { ...blackHeading, run: { ...blackHeading.run, size: 34, bold: true } }, heading2: { ...blackHeading, run: { ...blackHeading.run, size: 28, bold: true } }, heading3: { ...blackHeading, run: { ...blackHeading.run, size: 24, bold: true } } } }, sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: 18 })] })] }) }, children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
export async function renderDocument(ast: DocumentAst, format: DocumentFormat): Promise<Buffer> {
  validate(ast);
  const bytes = format === "md" ? Buffer.from(documentMarkdown(ast), "utf8") : format === "docx" ? await wordBytes(ast) : await withPrintPage(bodyHtml(ast), async (page) => Buffer.from(await page.pdf({ format: "Letter", margin: { top: "0.75in", bottom: "0.75in", left: "0.75in", right: "0.75in" }, printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:9px;color:#555;text-align:center;width:100%"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' })));
  if (bytes.length > 32000000) throw new Error("导出超过32MB限制，请分卷"); return bytes;
}
const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const normalize = (s: string) => s.normalize("NFKC").replace(/[\s\u200B-\u200D\uFEFF]/g, "");
export async function inspectExport(ast: DocumentAst, bytes: Buffer, format: DocumentFormat) {
  let text = "", pages: number | null = null;
  if (format === "md") text = decodeXml(bytes.toString("utf8").replace(/\\([\\`*_\[\]|])/g, "$1"));
  else if (format === "docx") { const zip = await JSZip.loadAsync(bytes), xml = await zip.file("word/document.xml")?.async("string"); if (!xml || !zip.file("[Content_Types].xml")) throw new Error("DOCX容器结构无效"); text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1])).join(" "); }
  else { const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise; try { pages = pdf.numPages; if (pages > 150) throw new Error("PDF超过150页限制"); for (let i = 1; i <= pages; i++) { const page = await pdf.getPage(i), content = await page.getTextContent(); text += content.items.map((item) => "str" in item ? item.str : "").join(" ") + "\n"; } } finally { await pdf.destroy(); } }
  const actual = normalize(text), expected = [ast.title, ...ast.blocks.flatMap((b) => b.type === "table" ? [...b.headers, ...b.rows.flat()] : b.type === "list" ? b.items : b.type === "chart" ? [b.title, ...b.labels, ...b.values.map(String)] : b.type === "image" ? [b.alt, b.caption ?? ""] : [blockText(b)]), ...ast.sources.flatMap((s) => [s.title, s.url])].filter(Boolean);
  const missing = expected.filter((s) => !actual.includes(normalize(s))).slice(0, 20);
  return { passed: !missing.length, format, pages, bytes: bytes.length, contentChars: text.length, missing: missing.map((s) => s.slice(0, 100)), sha256: createHash("sha256").update(bytes).digest("hex") };
}
