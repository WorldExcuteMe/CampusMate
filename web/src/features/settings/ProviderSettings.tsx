import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Plus, Trash2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listProviders, saveProvider, removeProvider } from "@/lib/llm/proxy";

export function ProviderSettings() {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const [form, setForm] = useState({ id: "", name: "", baseUrl: "", protocol: "openai", model: "", apiKey: "" });

  const save = useMutation({
    mutationFn: () => saveProvider(form),
    onSuccess: (ok) => {
      if (!ok) return toast.error("保存失败（需本地代理服务运行）");
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast.success("供应商已保存（密钥仅存服务端）");
      setForm({ id: "", name: "", baseUrl: "", protocol: "openai", model: "", apiKey: "" });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => removeProvider(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" />模型供应商</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          <p>API 密钥仅提交一次并存储于服务端（本地 gitignored 文件 / 生产 Supabase Secret），前端 bundle、localStorage 与 GitHub 均不含密钥。列表仅显示掩码状态。</p>
        </div>

        <div className="flex flex-col gap-2">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{p.name} <span className="text-xs text-muted-foreground">({p.id})</span></p>
                <p className="truncate text-xs text-muted-foreground">{p.baseUrl} · {p.protocol} · {p.model || "默认模型"} · 密钥 {p.hasKey ? "已配置 ••••" : "未配置"}</p>
              </div>
              {p.id !== "builtin-deepseek" && (
                <Button size="icon-xs" variant="ghost" aria-label="删除" onClick={() => del.mutate(p.id)}>
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              )}
            </div>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Provider ID</Label><Input placeholder="my-provider" value={form.id} onChange={set("id")} /></div>
          <div><Label>显示名称</Label><Input placeholder="我的供应商" value={form.name} onChange={set("name")} /></div>
          <div><Label>API 地址</Label><Input placeholder="https://api.example.com/v1" value={form.baseUrl} onChange={set("baseUrl")} /></div>
          <div>
            <Label>API 协议</Label>
            <Select value={form.protocol} onValueChange={(v) => setForm((f) => ({ ...f, protocol: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI 兼容</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="custom">自定义</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>模型</Label><Input placeholder="deepseek-chat" value={form.model} onChange={set("model")} /></div>
          <div><Label>API 密钥</Label><Input type="password" placeholder="sk-…（仅提交到服务端）" value={form.apiKey} onChange={set("apiKey")} /></div>
          <div className="sm:col-span-2">
            <Button disabled={!form.id || !form.baseUrl || save.isPending} onClick={() => save.mutate()}>
              <Plus className="size-4" />添加供应商
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}