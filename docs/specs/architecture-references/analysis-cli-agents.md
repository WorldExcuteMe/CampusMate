# Codex CLI vs. Gemini CLI — Agent Architecture Comparison

*Sources: openai/codex `main`; gemini-cli `0.71.0-nightly.20261118`.*

## 1. openai/codex

**Architecture.** Codex is a Rust workspace split into a wire-protocol crate and an agent runtime (`codex-rs/core`), driven by one submission/event bus: hosts send `Op` (`codex-rs/protocol/src/protocol.rs:738`) and consume `EventMsg` (`:1574`), shared by all front-ends. A thread runs one **turn** per user input; `run_turn` (`codex-rs/core/src/session/turn.rs:218`) snapshots a `StepContext` per model request (`session/step_activation.rs`), records typed context fragments, builds a `Prompt` (`turn.rs:1969`), streams the response, dispatches each `function_call` via `ToolCallRuntime` (`tools/parallel.rs:147`), appends `FunctionCallOutput` items, and loops while follow-up is needed. Steered input drains between steps (`turn.rs:555-711`, `session/input_queue.rs`). History is append-only `ResponseItemEnvelope`s (`context_manager/history.rs:105`), compacted inline/async/remotely (`compact.rs`, `compact_remote_v2.rs`, `session/async_compaction.rs`), and persisted as replayable rollouts.

**Best ideas.**
- **Typed context fragments, not prompt strings** — ~47 modules in `core/src/context/`, each a `ContextualUserFragment` (cache-stable ordering, versionable, diffable).
- **World-state diffing** — `TurnContextItem`/`WorldStateSnapshot` baselines (`context_manager/history.rs:151`) reinject only changed context, preserving prefix caching.
- **Atomic `StepContext`** — tools, skills, MCP requirements, approvals and model settings captured per request (`session/step_context.rs`), so a request view is never inconsistent.
- **Guardian reviewer** (`core/src/guardian/`): isolated LLM sub-session approving risky actions with own input/request budgets and audit trail (`review_session.rs`, `input_budget.rs`).
- **Truncation as policy** — `TruncationPolicy::{Bytes,Tokens}` with `Mul<f64>`, per-model defaults (`protocol.rs:3856`, `protocol/src/openai_models.rs:474`); `unified_exec/output.rs` keeps head+tail with explicit omission markers and original token counts.
- **Tool namespaces + code-mode** — `tools/router.rs`, `tools/spec_plan.rs` filter model-visible specs, defer namespaces, and run JS "cells" in a V8 worker (`code-mode*` crates) to batch many calls per invocation.
- **Approvals persisted as policy** — `execpolicy` canonicalized command-prefix rules with amendments (`execpolicy/src/rule.rs`, `amend.rs`); `AskForApproval::Granular` (5 flags) plus `SandboxPolicy` with `WritableRoot.read_only_subpaths` protecting `.git`/`.codex` (`protocol.rs:1205`, `:1292`).

## 2. google-gemini/gemini-cli

**Architecture.** TypeScript monorepo: Ink UI (`packages/cli`) over a core library (`packages/core`). `GeminiClient.sendMessageStream` (`packages/core/src/core/client.ts:954`) drives a turn: BeforeAgent hooks → `processTurn` (`:655`) → context management (graph `ContextManager` or legacy provider) → compression → tool-output masking → overflow pre-check → model routing/fallback → `Turn.run` (`core/turn.ts:270`) consuming `GeminiChat` stream events (thoughts, text, function calls, citations, finished). Tool calls go to `Scheduler.schedule` (`scheduler/scheduler.ts:237`), which validates, confirms through a request/response `MessageBus` (`confirmation-bus/message-bus.ts`), batches contiguous parallelizable calls (`_startBatch`, `:519`), executes, and feeds responses back, recursing until no pending tool calls (`MAX_TURNS = 100`). Two optional judges follow: `LoopDetectionService` (hash of tool+args, threshold 5; content 10; periodic LLM double-check — `services/loopDetectionService.ts`) and `checkNextSpeaker`, a utility call that can force "Please continue." Results are dual-channel: `llmContent` for the model, `returnDisplay` for UI (`tools/tools.ts`).

**Best ideas.**
- **Confirmation over an async message bus** — core publishes `TOOL_CONFIRMATION_REQUEST` with a correlation id; any front-end answers (`confirmation-bus/message-bus.ts`), decoupling core from UI.
- **Scheduler state machine** — `Validating → Scheduled → Executing → Completed|Errored|Cancelled` with contiguous-parallel batchers and per-call confirmation (`scheduler/types.ts`, `scheduler.ts`).
- **Spill instead of delete** — old tool outputs masked only after 50k protected and ≥30k prunable tokens; full text written to `session-<id>` files with a pointer snippet, recoverable via `read_file` (`context/toolOutputMaskingService.ts`).
- **Graduated compression** — trigger at 50% of window; protect 3 recent tool turns; collapse older `functionResponse`s to ≤2 KB; 256 KB byte secondary trigger; retrieval tools exempt (64 KB); `PreCompress` hook (`context/chatCompressionService.ts`).
- **Graph context engine** — `ConcreteNode` history, GC/distillation/normalization trigger pipeline, protected nodes, render cache by `nodesHash`, token ground truth calibrated from API `promptTokenCount` (`context/contextManager.ts`, `client.ts:873`).
- **Policy engine with shell reasoning** — priority-sorted rules/checkers, default DENY non-interactive, parsed-argv matching with redirection downgrades, TOML loader, folder trust (`policy/policy-engine.ts:266`).
- **Subagents as isolated executors** — fresh tool/prompt/resource registries, own compression loop, terminate modes (max turns/timeout/abort), activity callbacks (`agents/local-executor.ts`, `agents/registry.ts`).

## 3. Shared dimensions

| Dimension | codex | gemini-cli | Transferable lesson |
|---|---|---|---|
| Loop & turns | Turn = many steps; `Op`; steer drained between steps | Model stream + tool batch, recursion ≤100; next-speaker judge | Turn as resumable step tree with queued steering |
| Tool ACI | Responses items; `ToolRouter` specs, namespaces, parallelism | Function declarations; `llmContent` vs `returnDisplay`; call states | One `ToolSpec`+`ToolResult` envelope, split model/UI payloads |
| Result trimming | Bytes/tokens policy, head+tail, omission markers | Threshold truncate, distill, mask-to-file spill | Trim at capture; spill, never silently drop |
| Approvals | `AskForApproval` (4 modes, 5 flags); execpolicy prefix rules | `PolicyEngine` + 4 approval modes + folder trust | Rules → Allow/Ask/Deny; persist "always" as scoped rules |
| Sandboxing | bwrap+seccomp, Seatbelt, Windows; writable roots, read-only subpaths | Per-OS sandbox managers, `prepareCommand`, container option | Sandbox is a second layer, never the only control |
| MCP | rmcp, namespaced tools, lazy start, elicitation, OAuth | mcp-client, resources/prompts, OAuth, `/mcp` | Treat MCP as untrusted plugins with per-server approval |
| Subagents | `LocalAgentControl`: roles, fork modes, depth, max_threads | Isolated registries per agent; local + remote (A2A) | Subagent = isolated session + explicit result contract |
| Context mgmt | Append-only items, token anchors, pre/mid/post compaction | Node graph + triggers, compression 50%, masking/spill | Deterministic masking first, summarize second |
| Prompt & caching | Typed fragments, world diffs, `prompt_cache_key`/TTL, `previous_response_id` | `PromptProvider`/snippets per model, GEMINI.md hierarchy | Stable prefix + typed mutable sections = cache hits |
| Telemetry | OTel/OTLP, analytics, critical-path turn timing | OTel metrics/logs, GCP exporters, sanitizer | Instrument turns/steps/tool calls, not just requests |
| Hooks/extensions | 14 events, 4 handler types, sync/async, trust statuses | 11 events, command/runtime handlers, inject/block | Hooks are policy + observability; must be async-safe |

## 4. Top 5 things a small product agent should copy

1. **Explicit turn/step records + one event stream.** `Turn{id,input,steps[]}`, `Step{request_id,tool_calls[],results[],usage}`; emit `turn_started | step_started | tool_call | tool_result | turn_complete | error`, persisting steps (codex `turn.rs`+`protocol.rs`; gemini scheduler states), giving replay, resume, evals.
2. **Typed context items with a stable prefix.** Ordered `ContextItem{kind, priority, pinned, tokens}`; render instructions first, environment/cwd/git/time as diffed world state last (codex `core/src/context/`; gemini `promptProvider.ts`); apply per-model truncation policy at item creation, not send time.
3. **Tool ACI envelope with dual payloads and spill.** `ToolResult{llm_content, display, bytes, truncated, spill_path}`; head+tail truncation with `"… [N bytes omitted] …"` and original counts (codex `unified_exec/output.rs`); offload old outputs to a session scratch file with a `read_file` pointer (gemini `toolOutputMaskingService.ts`).
4. **Two-speed context reduction.** Fast pass: protect last 1–3 turns, exempt retrieval tools, mask/spill once prunable ≥30k tokens. Slow pass: summarize at ~50–70% of window into one pinned summary, keeping recent user messages verbatim (gemini compression; codex `compact.rs:733`). Trigger from measured usage, else estimates.
5. **Policy-before-sandbox approvals.** `evaluate(call) → Allow|Ask|Deny` from ordered rules (global→project→session) matched on tool name + parsed argv (not raw strings), Deny by default headless, then sandbox (workspace-write / read-only / none) as the second layer; persist "always allow" as a scoped rule (gemini `policy-engine.ts`; codex `execpolicy/src/rule.rs`, `AskForApproval`).

## 5. Three things not worth copying

1. **The 119-crate topology plus code-mode V8 worker and realtime/remote-compaction machinery** (codex). It serves many distribution surfaces; keep the `Op`/`EventMsg` model, skip the sprawl.
2. **The node-graph context pipeline with hot-start calibration and token ground truth** (gemini `context/graph/*`, `context/pipeline/*`). Costly to test and debug, and it coexists with a legacy path; an ordered item list + masking captures most value.
3. **LLM micro-judges inside the loop** — Gemini's `checkNextSpeaker` and periodic loop double-check, codex's Guardian reviewer. Extra latency, cost, nondeterminism; use deterministic heuristics (repeated-call hashes, no-progress counters) and reserve model judges for async audits.
