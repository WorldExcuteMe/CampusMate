// 聊天附件解析：图片→dataURL；PDF/DOCX→文本。供输入框附件/拖拽/粘贴使用。
export interface Attachment {
  name: string;
  kind: "image" | "doc";
  text?: string;
  dataUrl?: string;
}

export async function parseFile(file: File): Promise<Attachment> {
  const type = file.type;
  if (type.startsWith("image/")) {
    const dataUrl = await readAsDataURL(file);
    return { name: file.name, kind: "image", dataUrl };
  }
  if (type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const text = await parsePdf(file);
    return { name: file.name, kind: "doc", text };
  }
  if (
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.name.toLowerCase().endsWith(".docx")
  ) {
    const text = await parseDocx(file);
    return { name: file.name, kind: "doc", text };
  }
  // 纯文本兜底
  const text = await file.text();
  return { name: file.name, kind: "doc", text };
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function parsePdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    parts.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return parts.join("\n");
}

async function parseDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const buf = await file.arrayBuffer();
  const res = await mammoth.extractRawText({ arrayBuffer: buf });
  return res.value;
}