import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { downloadArtifact, getArtifact } from "@/lib/agent/api-client";
import { bodyChars, documentErrors, type DocumentAst, type DocumentBlock } from "../../../../shared/document";

export function DocumentArtifacts({ ids, owner, partial }: { ids: string[]; owner: string; partial: boolean }) {
  return <section className="space-y-2" aria-label="文档产物">{ids.map((id, i) => <ArtifactDialog key={id} id={id} owner={owner} index={i} partial={partial} />)}</section>;
}
function ArtifactDialog({ id, owner, index, partial }: { id: string; owner: string; index: number; partial: boolean }) {
  const [open, setOpen] = useState(false), [downloading, setDownloading] = useState(""), [error, setError] = useState("");
  const query = useQuery({ queryKey: ["artifact", owner, id], queryFn: () => getArtifact(id), enabled: open, retry: false });
  const artifact = query.data?.artifact;
  const inline = artifact?.inline as { format?: unknown; text?: unknown } | null | undefined;
  const markdown = Boolean(artifact && (artifact.kind === "markdown" || inline?.format === "md") && typeof inline?.text === "string");
  const markdownText = markdown ? String(inline?.text ?? "") : "";
  const invalid = artifact && !markdown && (artifact.kind !== "document" || documentErrors(artifact.inline).length > 0);
  const ast = artifact && !invalid && !markdown ? artifact.inline as DocumentAst : undefined;
  async function download(format: "md" | "docx" | "pdf") {
    setDownloading(format); setError("");
    try { const file = await downloadArtifact(id, format), url = URL.createObjectURL(file.blob), a = document.createElement("a"); a.href = url; a.download = file.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setDownloading(""); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" className="h-auto w-full justify-start gap-2 py-3 text-left text-xs"><FileText className="size-4 shrink-0 text-primary" /><span>查看{partial ? "未完成草稿" : "文档"}{index > 0 ? ` ${index + 1}` : ""}<span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">预览与下载</span></span></Button></DialogTrigger><DialogContent className="flex max-h-[90dvh] flex-col gap-4 sm:max-w-4xl">
    <DialogHeader><DialogTitle>{ast?.title ?? artifact?.filename ?? "文档预览"}</DialogTitle><DialogDescription>{partial ? "这是未完成草稿，请查看任务检查中的具体差距。" : "同一版本的正文与引用；关键事实、方案和估算仍需核对。"}</DialogDescription></DialogHeader>
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">正在读取文档…</p>}{query.isError && <p role="alert" className="text-sm text-destructive">读取失败：{query.error.message}<button className="ml-2 underline" onClick={() => void query.refetch()}>重试</button></p>}{invalid && <p role="alert" className="text-sm text-destructive">产物结构无法安全预览，请检查执行记录。</p>}
    {markdown && <><div className="flex flex-wrap items-center gap-2 border-b pb-3"><span className="mr-auto break-all text-xs text-muted-foreground">{artifact!.filename} · {markdownText.length} 字符</span><Button size="sm" variant="outline" disabled={Boolean(downloading)} onClick={() => void download("md")}><Download className="mr-1 size-3" />{downloading === "md" ? "生成下载…" : "下载 MD"}</Button></div><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs leading-6">{markdownText}</pre></>}
    {ast && <><div className="flex flex-wrap items-center gap-2 border-b pb-3"><span className="mr-auto text-xs text-muted-foreground">版本 {artifact!.revision} · 正文 {bodyChars(ast)} 字符 · {ast.sources.length} 条来源</span>{(["md", "docx", "pdf"] as const).filter((format) => query.data!.availableFormats.includes(format)).map((format) => <Button key={format} size="sm" variant="outline" disabled={Boolean(downloading)} onClick={() => void download(format)}><Download className="mr-1 size-3" />{downloading === format ? "生成下载…" : `下载 ${format.toUpperCase()}`}</Button>)}</div><article aria-label="文档正文" className="min-h-0 flex-1 space-y-4 overflow-auto pr-2 text-sm leading-7">{ast.blocks.map((b, i) => <Block key={i} block={b} />)}{ast.sources.length > 0 && <section className="space-y-3 border-t pt-5"><h2 className="text-lg font-semibold">参考来源</h2>{ast.sources.map((s) => <div key={s.id} className="rounded-lg bg-muted/40 p-3 text-xs leading-6"><a href={s.url} target="_blank" rel="noreferrer" className="break-all font-medium text-primary">[{s.id}] {s.title}</a><p className="text-muted-foreground">取得于 {new Date(s.retrievedAt).toLocaleString()} · 网页已取得，事实仍需核对</p><details><summary className="cursor-pointer">查看来源摘录</summary><p className="mt-2 whitespace-pre-wrap">{s.excerpt}</p></details></div>)}</section>}</article><p className="truncate border-t pt-2 font-mono text-[10px] text-muted-foreground" title={artifact!.sha256}>内容 SHA-256：{artifact!.sha256}</p></>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </DialogContent></Dialog>;
}
function Block({ block: b }: { block: DocumentBlock }) {
  const label = "claimType" in b && b.claimType ? ({ proposal: "建议方案", fact: "外部事实", estimate: "估算", unverified: "待核实" } as const)[b.claimType] : undefined;
  const refs = "sourceIds" in b ? b.sourceIds?.join("、") : undefined;
  let content;
  switch (b.type) {
    case "heading": return b.level === 1 ? <h1 className="pt-3 text-2xl font-semibold">{b.text}</h1> : b.level === 2 ? <h2 className="border-b pb-2 pt-4 text-xl font-semibold">{b.text}</h2> : <h3 className="pt-3 text-lg font-semibold">{b.text}</h3>;
    case "paragraph": content = <p className="whitespace-pre-wrap break-words">{b.text}</p>; break;
    case "list": content = b.ordered ? <ol className="list-decimal space-y-1 pl-5">{b.items.map((s, i) => <li key={i}>{s}</li>)}</ol> : <ul className="list-disc space-y-1 pl-5">{b.items.map((s, i) => <li key={i}>{s}</li>)}</ul>; break;
    case "table": content = <div className="overflow-auto"><table className="w-full border-collapse text-left text-xs"><thead><tr>{b.headers.map((s, i) => <th key={i} className="border bg-muted p-2">{s}</th>)}</tr></thead><tbody>{b.rows.map((row, i) => <tr key={i}>{row.map((s, j) => <td key={j} className="whitespace-pre-wrap border p-2">{s}</td>)}</tr>)}</tbody></table></div>; break;
    case "image": content = <figure><img src={b.src} alt={b.alt} className="mx-auto max-h-96 max-w-full object-contain" />{b.caption && <figcaption className="text-center text-xs text-muted-foreground">{b.caption}</figcaption>}</figure>; break;
    case "chart": { const max = Math.max(1, ...b.values.map(Math.abs)); content = <figure className="space-y-2 rounded-lg bg-muted/30 p-4"><figcaption className="font-medium">{b.title}</figcaption>{b.labels.map((s, i) => <div key={i} className="grid grid-cols-[7rem_1fr_4rem] items-center gap-2 text-xs"><span className="break-words">{s}</span><div className="h-3 rounded bg-primary/10"><div className="h-3 rounded bg-primary/60" style={{ width: `${Math.abs(b.values[i]) / max * 100}%` }} /></div><span>{b.values[i]}</span></div>)}</figure>; break; }
    case "reference": return <p className="text-xs text-primary">参见来源 [{b.sourceId}]</p>;
  }
  return <section>{label && <span className="mb-1 inline-block rounded bg-muted px-1.5 text-[10px] leading-5 text-muted-foreground">{label}</span>}{content}{refs && <p className="mt-1 break-all text-[10px] text-primary">来源：{refs}</p>}</section>;
}
