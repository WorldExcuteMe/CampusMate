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
import { providerCatalog, saveProvider, removeProvider } from "@/lib/llm/proxy";

export function ProviderSettings() {
  const qc = useQueryClient();
  const { data: catalog } = useQuery({ queryKey: ["provider-catalog"], queryFn: providerCatalog });
  const providers = catalog?.providers ?? [];
  const mutable = catalog?.mutable === true;
  const [form, setForm] = useState({ id: "", name: "", baseUrl: "", protocol: "openai", model: "", apiKey: "" });

  const save = useMutation({
    mutationFn: () => saveProvider(form),
    onSuccess: (ok) => {
      if (!ok) return toast.error("保存失败（需本地代理服务运行）");
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["provider-catalog"] });
      toast.success("供应商已保存（密钥仅存服务端）");
      setForm({ id: "", name: "", baseUrl: "", protocol: "openai", model: "", apiKey: "" });
    },
    onError: () => toast.error("保存失败，请检查代理连接"),
  });
  const del = useMutation({
    mutationFn: (id: string) => removeProvider(id),
    onSuccess: (ok) => {
      if (!ok) return toast.error("删除失败");
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["provider-catalog"] });
    },
    onError: () => toast.error("删除失败，请检查代理连接"),
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
          <p>生产模型由管理员配置服务端 Secret；当前只支持 OpenAI 兼容协议。本地开发代理支持保存自定义供应商，密钥不写入前端 bundle 或 localStorage。</p>
        </div>

        <div className="flex flex-col gap-2">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{p.name} <span className="text-xs text-muted-foreground">({p.id})</span></p>
                <p className="truncate text-xs text-muted-foreground">{p.baseUrl} · {p.protocol} · {p.model || "默认模型"} · 密钥 {p.hasKey ? "已配置 ••••" : "未配置"}</p>
              </div>
              {mutable && p.id !== "builtin-deepseek" && (
                <Button size="icon-xs" variant="ghost" aria-label="删除" onClick={() => del.mutate(p.id)}>
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              )}
            </div>
          ))}
        </div>

        {!mutable && <p className="text-xs text-muted-foreground">供应商管理为只读。生产环境请配置服务端 Secret；本地编辑需运行 npm run dev:api。</p>}
        {mutable && <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Provider ID</Label><Input placeholder="my-provider" value={form.id} onChange={set("id")} /></div>
          <div><Label>显示名称</Label><Input placeholder="我的供应商" value={form.name} onChange={set("name")} /></div>
          <div><Label>API 地址</Label><Input placeholder="https://api.example.com/v1" value={form.baseUrl} onChange={set("baseUrl")} /></div>
          <div>
            <Label>API 协议</Label>
            <Select value={form.protocol} onValueChange={(v) => setForm((f) => ({ ...f, protocol: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI 兼容</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>模型</Label><Input placeholder="deepseek-chat" value={form.model} onChange={set("model")} /></div>
          <div><Label>API 密钥</Label><Input type="password" placeholder="sk-…（仅提交到服务端）" value={form.apiKey} onChange={set("apiKey")} /></div>
          <div className="sm:col-span-2">
            <Button disabled={!form.id || !form.baseUrl || !form.model || !form.apiKey || save.isPending} onClick={() => save.mutate()}>
              <Plus className="size-4" />添加供应商
            </Button>
          </div>
        </div>}
      </CardContent>
    </Card>
  );
}
