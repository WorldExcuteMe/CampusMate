// Agent 层文档解析：附件原始字节在服务端解析，不依赖浏览器预处理。
// pdfjs 以 vendor 形式随 Function 一起部署；DOCX 通过 ZIP/deflate + XML 解析。
// 构建器需要看到 vendor 依赖才会把文件打进 Function 包；运行时按需加载。
// @ts-ignore vendor worker 无类型声明
if (false) void import("./vendor/pdf.worker.mjs");

type PdfTextItem = { str?: unknown };
type PdfPage = { getTextContent: () => Promise<{ items?: PdfTextItem[] }>; cleanup?: () => void };
type PdfDocument = { numPages: number; getPage: (page: number) => Promise<PdfPage>; destroy: () => Promise<void> };

function base64Bytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("document_data_invalid");
  const binary = atob(dataUrl.slice(comma + 1).replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zipEntry(bytes: Uint8Array, target: string): Promise<Uint8Array | null> {
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (u32(bytes, index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) return null;
  const count = u16(bytes, eocd + 10), offset = u32(bytes, eocd + 16);
  let cursor = offset;
  for (let index = 0; index < count && cursor + 46 <= bytes.length; index++) {
    if (u32(bytes, cursor) !== 0x02014b50) return null;
    const method = u16(bytes, cursor + 10);
    const compressed = u32(bytes, cursor + 20);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const name = decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (name === target) {
      if (u32(bytes, localOffset) !== 0x04034b50) return null;
      const localNameLength = u16(bytes, localOffset + 26);
      const localExtraLength = u16(bytes, localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.slice(start, start + compressed);
      return method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function docxText(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/gi, "\t")
    .replace(/<w:br[^>]*\/>/gi, "\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#(\d+);/g, (_, v: string) => String.fromCodePoint(Number(v))).replace(/&#x([0-9a-f]+);/gi, (_, v: string) => String.fromCodePoint(Number.parseInt(v, 16)));
}
async function xlsxText(bytes: Uint8Array): Promise<string> {
  const sharedXml = await zipEntry(bytes, "xl/sharedStrings.xml");
  const shared = sharedXml ? [...decode(sharedXml).matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map(m => decodeXml(m[1])) : [];
  let sheetXml = await zipEntry(bytes, "xl/worksheets/sheet1.xml");
  if (!sheetXml) sheetXml = await zipEntry(bytes, "xl/worksheets/sheet2.xml");
  if (!sheetXml) throw new Error("document_format_unsupported");
  const rows = [...decode(sheetXml).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(row => {
    const cells = [...row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
      const attrs = cell[1], inner = cell[2];
      const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? "";
      return type === "s" ? shared[Number(value)] ?? "" : decodeXml(value);
    });
    return cells.join("\t");
  });
  return rows.join("\n").slice(0, 100_000);
}
async function pdfText(bytes: Uint8Array): Promise<string> {
  // @ts-ignore vendor pdfjs 无类型声明
  const { getDocument } = await import("./vendor/pdf.mjs") as { getDocument: (options: unknown) => { promise: Promise<PdfDocument> } };
  const loading = getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: true });
  const document = await loading.promise;
  try {
    const pages = Math.min(document.numPages, 50);
    const chunks: string[] = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const line = (content.items ?? []).map(item => typeof item.str === "string" ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
      if (line) chunks.push(line);
      page.cleanup?.();
    }
    return chunks.join("\n").slice(0, 100_000);
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

export async function parseDocumentText(dataUrl: string, filename: string): Promise<string> {
  if (!dataUrl.startsWith("data:")) throw new Error("document_data_invalid");
  const bytes = base64Bytes(dataUrl);
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf") || dataUrl.startsWith("data:application/pdf")) return await pdfText(bytes);
  if (lower.endsWith(".docx") || dataUrl.includes("wordprocessingml")) {
    const xml = await zipEntry(bytes, "word/document.xml");
    if (!xml) throw new Error("document_format_unsupported");
    return docxText(decode(xml));
  }
  if (lower.endsWith(".xlsx") || dataUrl.includes("spreadsheetml")) return await xlsxText(bytes);
  if (lower.endsWith(".txt") || lower.endsWith(".md") || dataUrl.startsWith("data:text/")) {
    return decode(bytes).slice(0, 100_000);
  }
  throw new Error("document_format_unsupported");
}
