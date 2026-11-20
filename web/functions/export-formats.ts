// 云端富产物导出：从单一 Markdown/结构化源生成 DOCX/XLSX/PPTX/CSV/HTML/SVG/Mermaid/JSON。
// OOXML 使用 stored(method 0) ZIP，无需压缩库；Edge 可直接运行。PDF 由 HTML 报告经浏览器打印生成。
export type ExportFormat = "md" | "html" | "docx" | "xlsx" | "pptx" | "csv" | "svg" | "mermaid" | "json";
export interface ExportSource {
  title: string;
  markdown: string;
  table?: { headers: string[]; rows: string[][] };
  slides?: Array<{ title: string; bullets: string[] }>;
  chart?: { type: "bar" | "line"; title: string; labels: string[]; values: number[] };
  mermaid?: string;
  json?: unknown;
}
export interface ExportResult { bytes: Uint8Array; contentType: string; filename: string; }

const enc = new TextEncoder();
const u8 = (s: string) => enc.encode(s);
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function u16le(v: number) { return new Uint8Array([v & 255, (v >> 8) & 255]); }
function u32le(v: number) { return new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]); }
export function zipStore(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = []; const centrals: Uint8Array[] = []; let offset = 0;
  for (const e of entries) {
    const name = u8(e.name); const crc = crc32(e.data); const size = e.data.length;
    const local = concat([u32le(0x04034b50), u16le(20), u16le(0), u16le(0), u16le(0), u16le(0), u32le(crc), u32le(size), u32le(size), u16le(name.length), u16le(0), name, e.data]);
    locals.push(local);
    centrals.push(concat([u32le(0x02014b50), u16le(20), u16le(20), u16le(0), u16le(0), u16le(0), u16le(0), u32le(crc), u32le(size), u32le(size), u16le(name.length), u16le(0), u16le(0), u16le(0), u16le(0), u32le(0), u32le(offset), name]));
    offset += local.length;
  }
  const central = concat(centrals);
  const eocd = concat([u32le(0x06054b50), u16le(0), u16le(0), u16le(entries.length), u16le(entries.length), u32le(central.length), u32le(offset), u16le(0)]);
  return concat([...locals, central, eocd]);
}
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function mdLines(md: string): string[] { return md.replace(/\r/g, "").split("\n").map(l => l.replace(/^#{1,6}\s*/, "").replace(/^\s*[-*]\s*/, "• ").replace(/\*\*([^*]+)\*\*/g, "$1").trim()).filter(Boolean); }

function docx(source: ExportSource): Uint8Array {
  const lines = mdLines(source.markdown);
  const paras = lines.map((l, i) => i === 0 ? `<w:p><w:pPr><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1F3864"/></w:rPr><w:t xml:space="preserve">${xmlEscape(l)}</w:t></w:r></w:p>` : `<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${xmlEscape(l)}</w:t></w:r></w:p>`).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr/></w:body></w:document>`;
  return zipStore([
    { name: "[Content_Types].xml", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
    { name: "_rels/.rels", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", data: u8(document) },
  ]);
}
function xlsx(source: ExportSource): Uint8Array {
  const t = source.table ?? { headers: ["内容"], rows: mdLines(source.markdown).map(l => [l]) };
  const cell = (v: string, r: number, c: number) => `<c r="${String.fromCharCode(65 + c)}${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
  const rows = [t.headers, ...t.rows].map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cell(String(v), ri + 1, ci)).join("")}</row>`).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  return zipStore([
    { name: "[Content_Types].xml", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
    { name: "_rels/.rels", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: u8(sheet) },
  ]);
}
function pptx(source: ExportSource): Uint8Array {
  const slides = source.slides?.length ? source.slides : [{ title: source.title, bullets: mdLines(source.markdown).slice(0, 8) }];
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const slideIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  const slideRels = slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("");
  const overrides = slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  entries.push({ name: "[Content_Types].xml", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>${overrides}</Types>`) });
  entries.push({ name: "_rels/.rels", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`) });
  entries.push({ name: "ppt/presentation.xml", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`) });
  entries.push({ name: "ppt/_rels/presentation.xml.rels", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRels}</Relationships>`) });
  entries.push({ name: "ppt/slideMasters/slideMaster1.xml", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`) });
  entries.push({ name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`) });
  entries.push({ name: "ppt/slideLayouts/slideLayout1.xml", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`) });
  entries.push({ name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`) });
  slides.forEach((slide, i) => {
    const bullets = slide.bullets.map(b => `<a:p><a:r><a:t>${xmlEscape(b)}</a:t></a:r></a:p>`).join("");
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2800" b="1"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr><a:t>${xmlEscape(slide.title)}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${bullets}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`) });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: u8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`) });
  });
  return zipStore(entries);
}
function csv(source: ExportSource): Uint8Array {
  const t = source.table ?? { headers: ["内容"], rows: mdLines(source.markdown).map(l => [l]) };
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return u8("\uFEFF" + [t.headers, ...t.rows].map(r => r.map(esc).join(",")).join("\n"));
}
function svgChart(source: ExportSource): Uint8Array {
  const c = source.chart ?? { type: "bar" as const, title: source.title, labels: mdLines(source.markdown).slice(0, 6), values: mdLines(source.markdown).slice(0, 6).map((_, i) => i + 1) };
  const max = Math.max(1, ...c.values); const w = 640; const h = 360; const bw = (w - 80) / Math.max(1, c.values.length);
  const bars = c.values.map((v, i) => { const bh = (v / max) * (h - 90); const x = 50 + i * bw; return `<rect x="${x + 6}" y="${h - 50 - bh}" width="${bw - 12}" height="${bh}" fill="#4f7cff" rx="3"/><text x="${x + bw / 2}" y="${h - 34}" font-size="11" text-anchor="middle" fill="#666">${xmlEscape(String(c.labels[i] ?? i + 1)).slice(0, 12)}</text><text x="${x + bw / 2}" y="${h - 56 - bh}" font-size="11" text-anchor="middle" fill="#333">${v}</text>`; }).join("");
  return u8(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/><text x="${w / 2}" y="26" font-size="16" text-anchor="middle" fill="#111">${xmlEscape(c.title)}</text>${bars}</svg>`);
}
function htmlReport(source: ExportSource): Uint8Array {
  const lines = mdLines(source.markdown);
  const body = lines.map((l, i) => i === 0 ? `<h1>${xmlEscape(l)}</h1>` : `<p>${xmlEscape(l)}</p>`).join("");
  const table = source.table ? `<table><thead><tr>${source.table.headers.map(h => `<th>${xmlEscape(h)}</th>`).join("")}</tr></thead><tbody>${source.table.rows.map(r => `<tr>${r.map(c => `<td>${xmlEscape(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const chart = source.chart ? new TextDecoder().decode(svgChart(source)) : "";
  const mermaid = source.mermaid ? `<pre class="mermaid">${xmlEscape(source.mermaid)}</pre><script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script><script>mermaid.initialize({startOnLoad:true,theme:"neutral"});</script>` : "";
  return u8(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xmlEscape(source.title)}</title><style>body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:860px;margin:40px auto;padding:0 24px;line-height:1.75;color:#1a202c}h1{font-size:26px;color:#1f3864;border-bottom:3px solid #4f7cff;padding-bottom:10px}p{margin:8px 0}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #d8dfeb;padding:8px 10px;text-align:left}th{background:#eef2ff;color:#1f3864}svg{max-width:100%;height:auto;margin:16px 0}.mermaid{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px}@media print{body{margin:0;max-width:none}}</style></head><body>${body}${table}${chart}${mermaid}<p style="color:#888;font-size:12px">CampusMate 生成 · 浏览器“打印/另存为 PDF”可导出 PDF</p></body></html>`);
}
export function availableFormats(source: ExportSource): ExportFormat[] {
  const formats: ExportFormat[] = ["md", "html", "docx", "csv"];
  if (source.table) formats.push("xlsx");
  if (source.slides || source.markdown) formats.push("pptx"); // 列出 pptx；实际下载由客户端 pptxgenjs 生成以保证 PowerPoint 兼容。
  if (source.chart) formats.push("svg");
  if (source.mermaid) formats.push("mermaid");
  if (source.json !== undefined) formats.push("json");
  return formats;
}
export function exportArtifact(source: ExportSource, format: ExportFormat): ExportResult {
  const base = source.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "campusmate";
  switch (format) {
    case "docx": return { bytes: docx(source), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: `${base}.docx` };
    case "xlsx": return { bytes: xlsx(source), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${base}.xlsx` };
    case "pptx": return { bytes: pptx(source), contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", filename: `${base}.pptx` };
    case "csv": return { bytes: csv(source), contentType: "text/csv; charset=utf-8", filename: `${base}.csv` };
    case "svg": return { bytes: svgChart(source), contentType: "image/svg+xml", filename: `${base}.svg` };
    case "html": return { bytes: htmlReport(source), contentType: "text/html; charset=utf-8", filename: `${base}.html` };
    case "mermaid": return { bytes: u8(source.mermaid ?? `graph TD\n  A[${source.title}] --> B[完成]`), contentType: "text/plain; charset=utf-8", filename: `${base}.mmd` };
    case "json": return { bytes: u8(JSON.stringify(source.json ?? { title: source.title, markdown: source.markdown }, null, 2)), contentType: "application/json", filename: `${base}.json` };
    default: return { bytes: u8(source.markdown), contentType: "text/markdown; charset=utf-8", filename: `${base}.md` };
  }
}
