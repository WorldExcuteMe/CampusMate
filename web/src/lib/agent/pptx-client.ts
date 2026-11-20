import PptxGenJS from "pptxgenjs";

export interface PptxSource {
  title?: string;
  markdown?: string;
  slides?: Array<{ title: string; bullets: string[] }>;
  theme?: string;
}

function slidesFrom(src: PptxSource): Array<{ title: string; bullets: string[] }> {
  if (src.slides?.length) return src.slides.slice(0, 30);
  const lines = (src.markdown ?? "").split(/\r?\n/);
  const slides: Array<{ title: string; bullets: string[] }> = [];
  let cur: { title: string; bullets: string[] } | null = null;
  const push = () => { if (cur) slides.push(cur); cur = null; };
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) { push(); cur = { title: line.replace(/^#+\s*/, "").trim(), bullets: [] }; }
    else if (/^\s*[-*]\s/.test(line)) { if (!cur) cur = { title: src.title ?? "CampusMate", bullets: [] }; cur.bullets.push(line.replace(/^\s*[-*]\s*/, "").trim()); }
    else if (line.trim()) { if (!cur) cur = { title: src.title ?? "CampusMate", bullets: [] }; cur.bullets.push(line.trim()); }
  }
  push();
  if (!slides.length) slides.push({ title: src.title ?? "CampusMate", bullets: lines.map(l => l.trim()).filter(Boolean).slice(0, 10) });
  return slides.slice(0, 30);
}

export async function buildPptxBlob(src: PptxSource): Promise<Blob> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "CampusMate";
  pptx.title = src.title ?? "CampusMate";
  const slides = slidesFrom(src);
  const themes: Record<string, { accent: string; title: string; bg: string }> = {
    tech: { accent: "4F7CFF", title: "1F3864", bg: "FFFFFF" },
    academic: { accent: "8B1E3F", title: "3B1E1E", bg: "FFFDF8" },
    lively: { accent: "FF7A59", title: "2D1B4E", bg: "FFF8F0" },
  };
  const theme = themes[src.theme ?? "tech"] ?? themes.tech;
  slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: theme.bg };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: "100%", h: 0.12, fill: { color: theme.accent } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0.32, w: 0.08, h: 0.72, fill: { color: theme.accent } });
    slide.addText(s.title || src.title || "CampusMate", { x: 0.72, y: 0.35, w: 8.8, h: 0.8, fontSize: i === 0 ? 34 : 28, bold: true, color: theme.title, valign: "top" });
    const bullets = (s.bullets.length ? s.bullets : [" "]).slice(0, 10);
    slide.addText(bullets.map(b => ({ text: b, options: { bullet: { code: "2022" }, breakLine: true } })), { x: 0.6, y: 1.4, w: 8.8, h: 4.4, fontSize: 18, color: "333333", valign: "top", paraSpaceAfter: 8 });
    slide.addText(`${i + 1} / ${slides.length}`, { x: 8.6, y: 5.2, w: 1.1, h: 0.3, fontSize: 10, color: "999999", align: "right" });
  });
  const out = await pptx.write({ outputType: "blob" });
  return out as Blob;
}

export async function downloadPptx(src: PptxSource, filename: string): Promise<void> {
  const blob = await buildPptxBlob(src);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = /\.pptx$/i.test(filename) ? filename : `${filename.replace(/\.[^.]*$/, "")}.pptx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
