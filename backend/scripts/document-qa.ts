// Explicit local QA only; never exposed as an Agent host-execution tool.
import fs from "node:fs/promises";
import path from "node:path";
import { richDocument } from "../tests/fixtures/document.ts";
import { renderDocument, inspectExport } from "../src/core/document-renderer.ts";
const out = process.argv[2]; if (!out || !path.isAbsolute(out)) throw new Error("Provide an absolute QA output directory");
await fs.mkdir(out, { recursive: true });
const ast = richDocument();
await fs.writeFile(path.join(out, "document.json"), JSON.stringify(ast, null, 2));
const results: unknown[] = [];
for (const format of ["docx", "pdf"] as const) {
  const bytes = await renderDocument(ast, format); await fs.writeFile(path.join(out, `campusmate-proposal.${format}`), bytes);
  results.push(await inspectExport(ast, bytes, format));
  if (format === "pdf") { const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"), doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise; try { for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i), content = await page.getTextContent(); await fs.writeFile(path.join(out, `pdf-page-${i}.txt`), content.items.map((item) => "str" in item ? item.str : "").join("\n")); } } finally { await doc.destroy(); } }
}
await fs.writeFile(path.join(out, "inspection.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
