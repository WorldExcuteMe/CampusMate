import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listProviders, saveProvider, removeProvider, testProvider, defaultProvider, type ProviderPublic } from "@/lib/llm/proxy";
import { backendEnabled } from "@/lib/agent/api-client";
import { useAuth } from "@/app/auth";
import { errorMessage } from "@/lib/llm/errors";

const blank = () => ({ id: `provider-${crypto.randomUUID()}`, name: "", baseUrl: "", protocol: "openai", model: "", apiKey: "", contextLimit: "" });
const capabilityLabel = (value: unknown) => value === true ? "支持" : value === false ? "不支持" : "待实际请求确认";

export function ProviderSettings() {
  const qc = useQueryClient();
  const { session } = useAuth();
  const owner = session?.user.id ?? "demo";
  const enabled = backendEnabled() && Boolean(session);
  const queryKey = ["providers", owner];
  const { data: providers = [], isPending, error } = useQuery({ queryKey, queryFn: listProviders });
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const refresh = () => { void qc.invalidateQueries({ queryKey }); };
  const save = useMutation({
    mutationFn: () => saveProvider({ id: form.id, name: form.name || form.model, baseUrl: form.baseUrl, protocol: "openai", model: form.model, apiKey: form.apiKey || undefined, contextLimit: form.contextLimit ? Number(form.contextLimit) : null }),
    onSuccess: (ok) => { if (!ok) throw new Error("保存失败"); refresh(); setForm(blank()); setEditing(false); },
  });
  const action = useMutation({
    mutationFn: async ({ p, kind }: { p: ProviderPublic; kind: "test" | "default" | "delete" | "clear" }) => {
      if (kind === "test") { const result = await testProvider(p.id); return { id: p.id, text: `文本连接成功 · 配置 ${result.configuredModel} · 实际 ${result.actualModel}。其他能力按接口规则及实际请求确认。` }; }
      if (kind === "default") await defaultProvider(p.id);
      if (kind === "delete") await removeProvider(p.id);
      if (kind === "clear") await saveProvider({ id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: p.protocol, model: p.model, removeSecret: true });
      return { id: p.id, text: kind === "default" ? "已设为默认" : kind === "clear" ? "凭证已移除" : "配置已删除" };
    },
    onSuccess: ({ id, text }) => { setFeedback((old) => ({ ...old, [id]: text })); refresh(); },
  });
  function edit(p: ProviderPublic) {
    setForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: "openai", model: p.model, apiKey: "", contextLimit: p.contextLimit?.toString() ?? "" });
    setEditing(true);
    save.reset();
  }
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((old) => ({ ...old, [key]: e.target.value }));

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4 text-primary" />模型与连接</CardTitle>
        <p className="text-sm text-muted-foreground">选择你熟悉的模型。聊天会使用这里的配置，并展示上游实际返回的模型名称。</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="flex items-start gap-2 rounded-xl bg-primary/5 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />自定义密钥通过认证后端加密保存，列表只返回配置状态。编辑时留空可保留原密钥。</p>
        {!enabled && <p role="status" className="text-sm text-muted-foreground">自定义接入需要配置后端并登录。当前可查看开发环境提供的模型。</p>}
        {isPending && <p role="status">正在加载模型…</p>}
        {error && <p role="alert" className="text-sm text-destructive">模型加载失败：{errorMessage(error)}</p>}
        {!isPending && !error && providers.length === 0 && <p className="text-sm text-muted-foreground">尚未配置模型，可以在下方添加一个连接。</p>}
        <div className="space-y-3">
          {providers.map((p) => (
            <div key={p.id} className={`rounded-xl border p-4 ${p.isDefault ? "border-primary/25 bg-primary/5" : "border-border"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{p.name}{p.isDefault && <span className="ml-2 text-xs text-primary">默认</span>}{p.builtin && <span className="ml-2 text-xs text-muted-foreground">服务端提供</span>}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">{p.model || "模型未知"} · {p.hasKey ? "密钥已配置" : "缺少密钥"} · 窗口 {p.contextLimit?.toLocaleString() ?? "未知"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">图片：{capabilityLabel(p.capabilities?.vision)} · 工具：{p.capabilities?.tools === "native" ? "原生调用" : p.capabilities?.tools === "none" ? "不支持" : "兼容回退"} · 流式：{capabilityLabel(p.capabilities?.streaming)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{p.metadataSource?.startsWith("endpoint-profile") ? "按厂商接口规则自动适配；实际可用性以请求为准。" : "接口自动适配；未确认的能力保留未知，不需要手动填写。"}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" disabled={!enabled || action.isPending} aria-label={`测试连接 ${p.name}`} onClick={() => action.mutate({ p, kind: "test" })}>测试连接</Button>
                  {!p.isDefault && <Button size="sm" variant="ghost" disabled={!enabled || action.isPending} aria-label={`设为默认 ${p.name}`} onClick={() => action.mutate({ p, kind: "default" })}>设为默认</Button>}
                  {!p.builtin && p.id !== "builtin-deepseek" && <>
                    <Button size="sm" variant="ghost" disabled={!enabled} aria-label={`编辑 ${p.name}`} onClick={() => edit(p)}>编辑</Button>
                    {p.hasKey && <Button size="sm" variant="ghost" disabled={!enabled || action.isPending} aria-label={`移除凭证 ${p.name}`} onClick={() => action.mutate({ p, kind: "clear" })}>移除凭证</Button>}
                    <Button size="sm" variant="ghost" disabled={!enabled || action.isPending} aria-label={`删除 ${p.name}`} onClick={() => action.mutate({ p, kind: "delete" })}>删除</Button>
                  </>}
                </div>
              </div>
              <p className="mt-2 break-all text-xs text-muted-foreground">{p.baseUrl} · OpenAI兼容 · 能力来源：{p.metadataSource ?? "未提供"}</p>
              {feedback[p.id] && <p role="status" className="mt-2 text-xs text-primary">{feedback[p.id]}</p>}
            </div>
          ))}
        </div>
        <form className="grid gap-3 border-t pt-5 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <p className="font-medium sm:col-span-2">{editing ? "编辑连接" : "添加自定义连接"}</p>
          <div><Label htmlFor="provider-id">连接 ID</Label><Input id="provider-id" required disabled={editing || !enabled} placeholder="my-provider" value={form.id} onChange={set("id")} /></div>
          <div><Label htmlFor="provider-name">显示名称</Label><Input id="provider-name" disabled={!enabled} placeholder="可选，默认使用模型名称" value={form.name} onChange={set("name")} /></div>
          <div><Label htmlFor="provider-url">API 地址</Label><Input id="provider-url" type="url" required disabled={!enabled} placeholder="https://api.example.com/v1" value={form.baseUrl} onChange={set("baseUrl")} /></div>
          <div><Label htmlFor="provider-model">模型 ID</Label><Input id="provider-model" required disabled={!enabled} placeholder="服务商提供的模型ID" value={form.model} onChange={set("model")} /></div>
          <div><Label htmlFor="provider-key">API 密钥</Label><Input id="provider-key" type="password" autoComplete="off" disabled={!enabled} placeholder={editing ? "留空保留原密钥" : "仅提交到认证后端"} value={form.apiKey} onChange={set("apiKey")} /></div>
          <p className="text-xs text-muted-foreground sm:col-span-2">只需填写API地址、模型ID和密钥，连接ID已自动生成，显示名称可留空。已知接口按厂商规则自动适配，其他能力在实际请求中确认；当前支持OpenAI Chat Completions兼容协议。</p>
          {(save.error || action.error) && <p role="alert" className="text-sm text-destructive sm:col-span-2">{errorMessage(save.error ?? action.error)}</p>}
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={!enabled || !form.id || !form.model || !form.baseUrl || save.isPending}><Plus className="size-4" />{save.isPending ? "正在保存…" : editing ? "保存更改" : "添加供应商"}</Button>{editing && <Button type="button" variant="ghost" onClick={() => { setForm(blank()); setEditing(false); }}>取消编辑</Button>}</div>
        </form>
      </CardContent>
    </Card>
  );
}
