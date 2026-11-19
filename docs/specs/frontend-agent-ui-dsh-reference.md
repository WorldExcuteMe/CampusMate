# Frontend Agent-UI Reference — DSH Patterns for CampusMate

Mined from `C:\Users\Asus\CodeBuddy\dsh-src`; paths are relative to it. Copy the architecture and interaction rules, not proprietary components.

## 1. Layout blueprint

Three columns plus a full-width `shell.bottom` and `shell.overlay` (`packages/client/ui-layout/src/client/AppFrame.tsx`).

- **Left sidebar** — brand, New Session, Workspaces/Sessions, bottom-pinned Settings. 280px (264–420), 56px rail, drawer <768px, auto-collapse <1024px (`ui-sidebar/README.md`).
- **Header** — toggle + title + actions + View tabs + right-panel opener/More; blank sessions keep a 40px empty title row (`ConversationHeader.tsx`).
- **Message list** — one scrollport; "Load older" top row, back-to-bottom button, turn-navigation rail hidden when width ≤900px. Sticky composer is a separate footer band (`ui-chat/chat/ChatView.tsx`).
- **Composer** — attachment rail → editor (14-line cap) → toolbar. Left: `+`, permission, plan. Right: model+effort, activity, Stop⇄Send. Below: stats pills then context ring (`InputBar.tsx` L458–601).
- **Bottom strip** — DSH ships `shell.bottom` empty; live status is the composer dock. CampusMate: connection state in the strip, token stats in the dock.
- **Right panel** — 45% viewport on open, 70% cap, min 300px, fullscreen <768px; push or fullscreen; files/preview/browser/terminal/review tabs (`ui-sidebar-right/README.md`).
- **Responsive** — ≥1024 three columns; 768–1023 right pushes and left auto-collapses; <768 drawer + fullscreen right.

## 2. Timeline node taxonomy

Keys (`register-node-renderers.ts`): `user`, `steering`, `context`, `turn-trigger`, `system-prompt`, tool rows, `command`, `manual-compaction`, `compaction`, `model-retry`, `turn-error`, `turn-max-tokens`, `turn-process`, `turn-tail`, `unknown`.

| Node | Render | Collapse |
|---|---|---|
| user / steering | right-aligned bubble, time, copy; steering outside folding | never |
| assistant | GFM prose, code, math, images, file links | none |
| thinking | "思考" row + shimmering first-line preview while running | starts collapsed always |
| tool call + result (incl. terminal command) | card per callId: glyph + title + summary; preparing→start→result; shells use a terminal card (cwd, command, output); failures add a red-dot exit capsule | body manual |
| compaction | "上下文已压缩" + "已压缩 N 条历史记录（约 X tokens）" | expandable summary; shadowed rows stay |
| approval | composer takeover, not a row; Enter=allow once, Escape=reject, "Always allow" primary when offered | modal |
| error / limits | red-dot failure row; amber dot for output-token limit; stopped row; quota uses neutral copy | none |
| artifacts | changed-files card (single "Edited + basename"; multi: count + ± lines, 4 rows then fold), delivery grid (fold after 4), usage pill | rows open preview/review |
| turn process / tail | "Completed in…" fold control; action footer + usage | hover/focus in history |

Context injections are collapsed rows reusing the tool disclosure.

**工作步骤展示** (`ui-chat.transcriptView`) has four levels — 简洁/标准/详细/完全展开:

| | compact | standard | detailed | verbose |
|---|---|---|---|---|
| group header | summary | summary + live detail | hidden running, kept historical | hidden |
| group body | collapsed | collapsed | visible running | always visible |
| settled reasoning preview | off | first line | first line | first line |
| completed turn | collapsed | collapsed | collapsed | always open |

Running titles use the latest live category ("Reading files"); closed titles join the top three ranked labels with commas/"and"/"etc.", no counts. Body cap `min(400px,50vh)`; 4px gaps, 12px before replies. Only closed, uninterrupted turns fold; running/stopped/failed stay open (`conversation-nodes/README.md`).

**工作步骤收起时机** (`ui-chat.collapseTiming`): `completion` 回答结束后 (default) vs `next-input` 下次有新消息时 (defer the latest exchange; a new submission ends it).

**收起后显示的回复** (`ui-chat.foldedReplies`): `all` 全部回复 (default; only reasoning/tools/groups fold) vs `final` 仅最终回答. Hidden in verbose. All three persist in host profile settings; unset → Desktop `standard`, Web `detailed`.

## 3. Context & token meter

```ts
type ContextPressure = { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
type ContextBreakdown = { systemTokens: number; toolsTokens: number; messageTokens: number }
occupancy = { percent: min(100, round(used / window * 100)), usedTokens: projectedTokens ?? pressureTokens, contextWindow }
```

(`ui-conversation/src/client/context-occupancy.ts`, `docs/subsystems/token-meter.md`)

Display (`ContextMeter.tsx`): 14px SVG ring (r=5.5, 2px stroke) + percent **below the composer**, after stats — screenshot `47%`; tooltip "上下文已用 47%". Click opens an anchored popover: `~266K / 1M`, segmented bar (system prompt / tool definitions / messages) with per-bucket rows. `~` = provider-anchored pressure plus heuristic repricing of newer surface changes. Numbers exact under 1000, else decimal K/M (`266.5K`; `1M = 1000K`).

Pills (`StatsPills.tsx`): gauge + `12 轮 34 步 · 42.1 tok/s`; database + `266M tok · 缓存命中 99.5%` (screenshot format). Dialogs add 模型/工具用时, TTFT, TPS and cache/input/output bucket rows. Partial hits never round to 100. Per-turn `用量 {total}` appears only when every attempt reports exact accounting. Hidden until usage and capacity exist; updates per sample.

## 4. Permission model UI

Composer bottom-left (`conversation.input.permission`), before plan/model: glyph + current label + chevron; menu opens upward (`ui-permission-presets/README.md`). Options: 仅可查看, 工作区内修改, 完全权限, 自动审查 (EXP, current session only). It changes the current session; Settings sets only the new-session default.

A preset bundles sandbox mode + approval policy: `workspace-write` = workspace-write + ask; `danger-full-access` = full-access + never. `custom` is derived, never selectable. Selecting Full access/Auto does not submit: `RiskConfirmation` opens — "确认启用完全权限？", body naming sensitive operations, checkbox "我已了解风险，并愿意继续", Cancel, "启用完全权限" disabled until checked. The trigger shows the optimistic value, then reconciles from the session projection; catalog invalidation restores the real value (`PermissionSelect.tsx`).

## 5. Provider / model settings UX

Provider rows + one editor card at a time; "Add model provider" has a segmented switch: **Third-party model provider** (catalog id + API key) vs **Custom model API** (permanent ID, display name, base URL, protocol, key, ≥1 model) (`ui-settings-models/README.md`, `docs/user/guide/providers.md`).

Per-model matrix (`ModelCatalogModel`, `api/session-controller/src/types.ts`): `id`, `name`, `contextWindow`, `maxTokens`, input **Text/Image** (≥1), `reasoningEfforts` **off/minimal/low/medium/high/xhigh/max** each with optional wire API value, `badge`/`description`. Tools are route-level; show reasoning levels as the "thinking" badge.

Context length uses decimal K/M (`1M` = 1000K; `256K`, `131072`; placeholders `1M` / `128K`). CampusMate adds chips **200K / 500K / 1M + custom** writing the same normalized number; reject 0/fractional/NaN.

Persistence: `settings.mutate` path ops with revision conflicts; keys via `credentials.set` (write-only, masked preview, env hints); model persists per session, applies at the next request boundary (running step keeps its model); selecting it also sets the new-session default. Errors: a rejected save keeps the editor open with the host diagnostic; a deleted default shows "Select model" and blocks input; an empty catalog shows "No models available"; green/red credential dots.

## 6. Workspace sidebar

- **Tabbed right panel** — capsules + close, add/guide, split, presentation, collapse; strip is the whole top edge; 45%→70%, persisted per session (`ui-sidebar-right`).
- **File tree** (`ui-sidebar-files`) — root = session cwd; lazy one-level listing; dotfiles behind an eye; directories toggle, files open tabs, unknown types greyed; current file `aria-current`. Navigator 260px: raised panel ≥560px, overlay 400–560, full-width below 400/768.
- **Preview** (`ui-sidebar-documentpreview`) — path header, renderer dropdown, wrap/reload, "Rendering document…"; Markdown/code, PDF, HTML, zoomable images, XLSX, DOCX/PPTX→PDF.
- **Open in app** (`ui-open-in-app`) — 24px split button; apps with icons, "(default)" marker, "Show file location" footer, remembered choice.
- **Generated docs** — delivery/changed-files cards open preview or changes-review; inline-code mentions become links.

## 7. Multimodal attachments

(`ui-attachment/README.md`, `docs/subsystems/attachment.md`)

- **Draft rail** under the editor, one non-wrapping 64px strip in pick order: image = 64px square; file = 240×64 card (16px radius, blue doc glyph, filename, uppercase extension + size); newest revealed.
- **Upload** — spinner, byte progress, retry on failure, remove on hover/focus (always on touch); refused images explain via pinned tooltip; Send waits for uploads.
- **Limits** — ≤20 images, ≤200MiB/message, ≤50MiB/source, ≤64MP, ≤65535px/side; normalize long edge 2048 / 4MiB; directories refused; the drop overlay shows limits; paste routes to the recent composer.
- **Sent message** — right-aligned flow; lone image 240px on its longer edge (aspect clamp 0.25–4, no upscale); multiple attachments use 64px squares beside 240×64 cards; click opens a lightbox; failed load retries.
- **Durability** — images persist before the user event; files carry an upload receipt id; per-session authorized URL cache.

## 8. Component list for CampusMate

Sources are relative to `packages/client/`; chat files under `ui-chat/src/client/chat/`.

| Component | Key props | DSH source |
|---|---|---|
| `AppShell` | `sidebar`, `rightbar`, `bottom` | `AppFrame.tsx` |
| `ConversationHeader` | `title`, `actions`, `views[]` | `ConversationHeader.tsx` |
| `Transcript` | `nodes[]`, `following`, `onLoadOlder` | `chat/ChatView.tsx` |
| `TurnGroup` | `title`, `state`, `members[]`, `open` | `ChatGroupSeat.tsx` |
| `MessageRow` | `kind`, `markdown`, `images` | `chat/MessageItem.tsx` |
| `ReasoningRow` | `text`, `running`, `expanded` | `chat/ReasoningRow.tsx` |
| `ToolCallCard` | `callId`, `phase`, `args`, `result` | `ui-tool` |
| `CompactionRow` | `summary`, `items`, `tokens` | `chat/CompactionItem.tsx` |
| `TurnFooter` | `duration`, `status`, `usage` | `TurnTailNodeView.tsx` |
| `Composer` | `value`, `attachments`, `permission`, `model`, `effort` | `InputBar.tsx` |
| `AttachmentRail` | `items[]`, `progress`, `onRetry` | `AttachmentRail.tsx` |
| `ContextMeter` | `usedTokens`, `contextWindow` | `ContextMeter.tsx` |
| `UsagePills` | `turns`, `steps`, `speed`, `cacheHit` | `chat/StatsPills.tsx` |
| `PermissionSelect` | `value`, `options[]`, `onSelect` | `PermissionSelect.tsx` |
| `ModelSelect` | `groups[]`, `selection`, `efforts[]` | `ModelSelect.tsx` |
| `RightPanel` | `tabs[]`, `activeId`, `presentation` | `SidebarRight.tsx` |
| `FileTree` | `root`, `onOpen`, `currentPath` | `ui-sidebar-files` |
| `DocumentPreview` | `path`, `renderer` | `ui-sidebar-documentpreview` |

## 9. Ten "beyond the ask" UX ideas (low cost first)

1. **Esc-Esc stop**, with the chord in the Stop tooltip and `aria-keyshortcuts`.
2. **Ellipsis-aware tooltips**: full reading only when clipped; pin on tap.
3. **Compaction marker row** so long sessions feel summarized, not truncated.
4. **Shimmer on running labels**, static under reduced motion.
5. **Slash/`@` reference chips** (skills, files, sessions) with atomic Backspace.
6. **Queued-message dock** while running: Queue vs Steer, inline edit/remove.
7. **Turn navigator rail** with previews and jump-to-turn, including unloaded turns.
8. **Deliverables card**: changed files with ± counts, hover diff, open review.
9. **Attachment rail with per-item progress/retry and a limits line.**
10. **Follow-tail scroll**: anchors on load-older, back-to-bottom, reading-preserving folds.
