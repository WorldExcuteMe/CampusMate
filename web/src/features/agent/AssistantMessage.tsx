import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo } from "react";
import { guardUrl } from "@/lib/security/urlGuard";
import { localWorkspaceIdentity } from "@/lib/agent/local-workspace";
import type { Root, Parent, RootContent } from "mdast";

function campusAutolinkBoundaries() {
  return (tree: Root, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const visit = (parent: Parent) => {
      const children: RootContent[] = [];
      for (const child of parent.children) {
        if ("children" in child) visit(child as Parent);
        const start = child.position?.start.offset, end = child.position?.end.offset;
        // GFM's transform-time autolink nodes have no source position.
        const raw = start !== undefined && end !== undefined ? source.slice(start, end) : child.type === "link" && child.children.length === 1 && child.children[0].type === "text" ? child.children[0].value : "";
        // Only implicit links: preserve explicit Markdown destinations, angle
        // autolinks and code, including intentionally encoded Chinese paths.
        const boundary = raw.search(/[（），。；！？、【】「」“”《》]/);
        if (child.type === "link" && /^(?:https?:\/\/|www\.)/i.test(raw) && boundary > 0) {
          const visible = raw.slice(0, boundary);
          children.push({ ...child, url: /^www\./i.test(visible) ? `http://${visible}` : visible, children: [{ type: "text", value: visible }] }, { type: "text", value: raw.slice(boundary) });
        } else children.push(child);
      }
      parent.children = children;
    };
    visit(tree);
  };
}
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR } from '../../../../shared/tool-protocol';

function safeLink(url: string, localWorkspace: boolean): string {
  const preview = localWorkspace && /^\/(?:app\/)?calendar\?import=([a-z0-9-]{1,80})$/i.exec(url);
  if (preview) return `/app/calendar?import=${preview[1]}`;
  if (/^#[a-zA-Z0-9_-]+$/.test(url)) return url;
  const result = guardUrl(url);
  if (!result.ok) return "";
  const parsed = new URL(result.normalized!);
  return parsed.username || parsed.password ? "" : parsed.href;
}

// Model text is untrusted. No raw HTML, injected handlers, executable URLs or
// automatic external image requests. Only the assistant side is Markdown.
export const AssistantMessage = memo(function AssistantMessage({ content }: { content: string }) {
  const localWorkspace = Boolean(localWorkspaceIdentity());
  if (hasRawToolMarkup(content)) return <p role="alert" className="text-sm leading-7 text-destructive">{TOOL_PROTOCOL_ERROR}</p>;
  return (
    <div data-testid="assistant-markdown" className="min-w-0 max-w-full space-y-3 [overflow-wrap:anywhere] text-sm leading-7 [&_p]:whitespace-pre-wrap [&_strong]:font-semibold [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_h4]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_li>p]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/60 [&_pre]:p-3 [&_pre]:leading-6 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_hr]:border-border [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_input]:mr-1.5">
      <Markdown
        remarkPlugins={[remarkGfm, campusAutolinkBoundaries]}
        skipHtml
        urlTransform={(url) => safeLink(url, localWorkspace)}
        components={{
          a: ({ href, children }) => href
            ? <a href={href} target={href.startsWith("/") || href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer nofollow">{children}</a>
            : <span>{children}</span>,
          img: ({ alt }) => <span className="text-muted-foreground">[图片未自动加载{alt ? `：${alt}` : ""}]</span>,
          table: ({ children }) => (
            <div role="region" aria-label="回复中的表格" tabIndex={0} className="max-w-full overflow-x-auto rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <table className="w-full min-w-max border-collapse text-left text-sm [&_th]:border-b [&_th]:border-border [&_th]:bg-muted/70 [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_tr:last-child_td]:border-b-0">{children}</table>
            </div>
          ),
        }}
      >{content}</Markdown>
    </div>
  );
});
