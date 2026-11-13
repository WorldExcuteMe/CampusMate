import { useCallback, useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, AlertCircle, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface EnvCheck {
  python64: boolean;
  qqRunning: boolean;
  wechatRunning: boolean;
  qqKey: boolean;
  wechatKey: boolean;
  workspace: string;
}

// 「grill me」问答式引导：Agent 提出卡点问题，用户回答/操作后重新检测。
export function SetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [ws, setWs] = useState(() => localStorage.getItem("campusmate.workspace") || "");

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/env/check");
      const data = await res.json();
      setEnv(data);
      if (!ws && data.workspace) setWs(data.workspace);
    } catch {
      setEnv(null);
    }
    setLoading(false);
  }, [ws]);

  useEffect(() => {
    if (open) check();
  }, [open, check]);

  function saveWs() {
    localStorage.setItem("campusmate.workspace", ws);
    check();
  }

  const questions: Array<{ ok: boolean; q: string; hint: string }> = env
    ? [
        { ok: env.python64, q: "本机是否有 64 位 Python？", hint: "读取 QQ/微信内存需 64 位解释器（如 miniconda3）。缺失请先安装 64 位 Python。" },
        { ok: env.qqRunning, q: "本地 QQ 是否已登录并运行？", hint: "取 QQ 密钥需 QQ 进程在运行。请打开并登录 QQ 后点「重新检测」。" },
        { ok: env.wechatRunning, q: "本地微信是否已登录并运行？", hint: "取微信密钥需 Weixin.exe 在运行。请打开并登录微信后点「重新检测」。" },
        { ok: env.qqKey, q: "QQ 库密钥是否已就绪？", hint: "运行 qq_cli.py key 自动取钥；或手动 --key。" },
        { ok: env.wechatKey, q: "微信库密钥是否已就绪？", hint: "运行 wechat_cli.py key --auto；或手动 --key。" },
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>配置环境 · 问答引导</DialogTitle>
          <DialogDescription>
            面向零配置用户：逐项检测，卡点以问题形式提出，你操作/回答后重新检测，全部通过即可开始抓取。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-primary" />
          <Input
            placeholder="自定义工作区本地路径（存放工具/导出）"
            value={ws}
            onChange={(e) => setWs(e.target.value)}
          />
          <Button size="sm" variant="outline" onClick={saveWs}>保存</Button>
        </div>

        <div className="flex flex-col gap-2">
          {loading && <p className="text-sm text-muted-foreground">检测中…</p>}
          {!loading && !env && (
            <p className="text-sm text-destructive">无法连接本地服务（需启动 dev/llm-proxy.mjs）。</p>
          )}
          {questions.map((item, i) => (
            <div key={i} className={cn("rounded-md border p-3", item.ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50")}>
              <div className="flex items-center gap-2 text-sm font-medium">
                {item.ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <AlertCircle className="size-4 text-amber-600" />}
                {item.q}
              </div>
              {!item.ok && <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p>}
            </div>
          ))}
        </div>

        <Button onClick={check} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          我已操作，重新检测
        </Button>
      </DialogContent>
    </Dialog>
  );
}