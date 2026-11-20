import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";

// DeepSeek 式顺滑思考流：以稳定速率逐字揭示增量文本，带光标与自动滚动，降低等待焦虑。
export function ThinkingStream({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(0);
  const [open, setOpen] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const target = text.length;
  useEffect(() => {
    let raf = 0;
    const step = () => {
      setShown((s) => {
        if (s >= target) return s;
        const gap = target - s;
        return Math.min(target, s + Math.max(2, Math.ceil(gap / 10)));
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  useEffect(() => { const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; }, [shown, open]);
  if (!text) return null;
  return (
    <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 p-2">
      <button type="button" onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-2 text-[11px] font-medium text-primary">
        <Brain className={`size-3.5 ${active ? "animate-pulse" : ""}`} />
        {active ? "正在思考…" : "思考过程"}
        <span className="ml-auto text-muted-foreground">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div ref={boxRef} className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
          {text.slice(0, shown)}
          {active && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-primary/70 align-middle" />}
        </div>
      )}
    </div>
  );
}
