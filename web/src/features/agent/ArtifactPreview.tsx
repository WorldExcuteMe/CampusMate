import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Eye, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadArtifact, downloadMergedArtifacts, getArtifact } from "@/lib/agent/api-client";
import { downloadPptx } from "@/lib/agent/pptx-client";

const LABELS: Record<string, string> = { md: "MD", html: "HTML", svg: "SVG", csv: "CSV", json: "JSON", mermaid: "Mermaid", docx: "DOCX", xlsx: "XLSX", pptx: "PPTX" };

export function ArtifactsPanel({ ids, owner, taskId }: { ids: string[]; owner: string; taskId: string }) {
  const [selected, setSelected] = useState(ids[0] ?? "");
  const [merging, setMerging] = useState("");
  async function merge(format: "md" | "docx" | "html") {
    setMerging(format);
    try { const file = await downloadMergedArtifacts(taskId, format); const a = document.createElement("a"); a.href = URL.createObjectURL(file.blob); a.download = file.filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
    finally { setMerging(""); }
  }
  useEffect(() => { if (!ids.includes(selected)) setSelected(ids[0] ?? ""); }, [ids, selected]);
  if (!ids.length) return <p className="text-xs leading-6 text-muted-foreground">本轮还没有生成文档产物。生成后可在这里预览与下载。</p>;
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-1">
      {ids.map((id, i) => <button key={id} type="button" onClick={() => setSelected(id)} className={`rounded-md border px-2 py-1 text-[11px] ${selected === id ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>产物 {i + 1}</button>)}
    </div>
    {ids.length > 1 && <div className="flex flex-wrap items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground">合并导出{(["docx", "html", "md"] as const).map((f) => <button key={f} type="button" disabled={Boolean(merging)} onClick={() => void merge(f)} className="rounded px-1.5 py-0.5 text-primary hover:bg-primary/10">{merging === f ? "生成…" : f.toUpperCase()}</button>)}</div>}
    <ArtifactPreview id={selected} owner={owner} />
  </div>;
}

export function ArtifactPreview({ id, owner }: { id: string; owner: string }) {
  const query = useQuery({ queryKey: ["artifact", owner, id], queryFn: () => getArtifact(id), enabled: Boolean(id) });
  const artifact = query.data?.artifact;
  const formats = query.data?.availableFormats ?? ["md"];
  const [format, setFormat] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!artifact) return;
    const preferred = artifact.primaryFormat && formats.includes(artifact.primaryFormat) ? artifact.primaryFormat : formats.includes("html") ? "html" : formats[0] ?? "md";
    setFormat(preferred);
  }, [artifact?.id]);

  useEffect(() => {
    setUrl("");
    setText("");
    setError("");
    if (!artifact || !format) return;
    if (format === "md") {
      const inline = artifact.inline as { text?: unknown } | null;
      setText(typeof inline?.text === "string" ? inline.text : "");
      return;
    }
    if (["docx", "xlsx", "pptx"].includes(format)) return;
    let active = true;
    void downloadArtifact(id, format).then(async (file) => {
      if (!active) return;
      if (format === "html" || format === "svg") { setUrl(URL.createObjectURL(file.blob)); return; }
      setText((await file.blob.text()).slice(0, 60_000));
    }).catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [id, format, artifact?.id]);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function save() {
    if (!artifact) return;
    setBusy(true); setError("");
    try {
      if (format === "pptx") await downloadPptx(artifact.source ?? { title: artifact.filename, markdown: text }, artifact.filename ?? "campusmate.pptx");
      else if (format === "md") { const inline = artifact.inline as { text?: string } | null; const blob = new Blob([inline?.text ?? ""], { type: "text/markdown;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = artifact.filename ?? "campusmate.md"; a.click(); }
      else { const file = await downloadArtifact(id, format); const a = document.createElement("a"); a.href = URL.createObjectURL(file.blob); a.download = file.filename; a.click(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  if (query.isLoading) return <p role="status" className="text-xs text-muted-foreground">正在读取产物…</p>;
  if (query.isError) return <p role="alert" className="text-xs text-destructive">读取失败：{query.error.message}</p>;
  if (!artifact) return null;
  const unsupported = format === "docx" || format === "xlsx" || format === "pptx";
  return <div className="rounded-lg border border-border/70 bg-background">
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
      <FileText className="size-3.5 text-primary" />
      <span className="mr-auto truncate text-[11px] text-muted-foreground" title={artifact.filename}>{artifact.section ? `第 ${artifact.section}${artifact.totalSections ? `/${artifact.totalSections}` : ""} 节 · ` : ""}{artifact.filename}</span>
      {formats.map((f) => <button key={f} type="button" onClick={() => setFormat(f)} className={`rounded px-1.5 py-0.5 text-[10px] ${format === f ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>{LABELS[f] ?? f}</button>)}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save()}><Download className="size-3" />{busy ? "生成…" : "下载"}</Button>
    </div>
    <div className="p-2">
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {unsupported && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Eye className="size-3.5" />{LABELS[format]} 不支持内嵌预览，请点“下载”获取成品。</p>}
      {format === "md" && <pre className="max-h-[min(60dvh,620px)] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5">{text || "（正文为空）"}</pre>}
      {(format === "html" || format === "svg") && url && (format === "html" ? <iframe title="产物预览" src={url} sandbox="allow-scripts allow-same-origin" className="h-[min(65dvh,680px)] w-full rounded border bg-white" /> : <img src={url} alt="SVG 预览" className="max-h-[min(65dvh,680px)] w-full object-contain" />)}
      {(format === "csv" || format === "json" || format === "mermaid") && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5">{text || "（内容为空）"}</pre>}
    </div>
  </div>;
}
