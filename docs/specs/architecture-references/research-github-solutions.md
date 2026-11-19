# GitHub solutions survey — CampusMate agent architecture

Snapshot 2026-11-19 (repo pages/API, docs, papers; no clones). "Borrow" = the pattern or a small library, not the project; integration points reference `backend/src/{core,runtime,evaluation}`.

## Table

| Category | Project | What it gives | License / maturity | Borrow? | Concrete integration point |
|---|---|---|---|---|---|
| Runtime | LangGraph | Graph state machine, checkpointers, interrupts, streaming; Python/JS | MIT, 29k★, production-proven | maybe | Checkpoint/interrupt semantics for `runtime/worker.ts`; keep own loop |
| Runtime | OpenAI Agents SDK | Small loop: handoffs, guardrails, sessions, tracing; Python/TS | MIT, fast-moving | maybe | Session/guardrail contracts for `core/llm.ts` turns |
| Runtime | PydanticAI | Typed deps/output, validated tool args, eval helpers; Python | MIT, active | no | Zod-validate tool results in `tool-protocol.ts` |
| Runtime | smolagents | CodeAgent writes Python actions; sandbox executors; tiny core | Apache-2.0, HuggingFace-backed | maybe | Reference for programmatic tool calling; see code-mode rows |
| Runtime | Agno | Agent platform: memory, knowledge, tools, AgentOS runtime | Apache-2.0, 43k★ | no | Platform-sized; product already owns these |
| Runtime | AutoGen/AG2, CrewAI, MetaGPT | Multi-agent conversations, crews, SOP organizations | MIT (AG2 Apache-2.0), research-shaped | no | No agent-to-agent requirement |
| Runtime | Letta (MemGPT) | Stateful agents, memory blocks, sleep-time compute, server | Apache-2.0, active | maybe | Memory-block schema for `core/memory.ts` |
| Runtime | Google ADK | Multi-agent kit, tools, evals, A2A, deploy | Apache-2.0, v2.x | no | Python-first; not a TS product fit |
| Runtime | Mastra | TS agents/workflows/MCP/evals, server, deploy | Apache-2.0 + enterprise terms, 29.6k★ | maybe | TS workflow/eval reference; avoid a second runtime |
| Runtime | Temporal | Durable workflows, retries, signals, timers; TS SDK | MIT, mature infra | no | Lease/checkpoint already durable; borrow signal/idempotency semantics |
| Runtime | Vercel AI SDK | TS provider abstraction, streaming, typed tool calls | Apache-2.0, 25k★+, very active | maybe | Provider layer if BYOK churn grows; `llm.ts` is enough today |
| Memory | Mem0 | Extraction, dedupe, scoring, vector/graph store; open-core | Apache-2.0, 54k★ | maybe | Copy extract→dedupe→score into `memory.ts` |
| Memory | Zep / Graphiti | Temporal knowledge graph, incremental episodes, hybrid search | Graphiti Apache-2.0; Zep CE frozen | maybe | Graphiti schema as reference; Postgres+pgvector, no graph DB |
| Memory | LangMem | Memory tools + prompt optimizer, LangGraph-tied | MIT | no | Concepts only; pulls LangChain in |
| Memory | Motörhead + memory MCP server | Deprecated memory server; thin KG MCP demo | deprecated / MIT | no | Skip; memory stays in PG with RLS |
| Protocol | MCP spec + TS SDK + registry | Tool protocol; TS SDK; official registry (preview) | SDK MIT; registry preview, NOASSERTION | yes | MCP client behind `manifest.ts`; don't trust registry metadata |
| Protocol | A2A | Agent cards, task lifecycle; v1.0 stable under Linux Foundation | Apache-2.0, 150+ orgs | no | Only if agent-to-agent interfaces ship later |
| Protocol | OpenAPI→tools (api-to-mcp, FastMCP, openapi-typescript) | Web APIs as MCP tools or typed clients | MIT / Apache-2.0, mixed | maybe | Typed client for campus data APIs; curated subset only |
| Tools | E2B, microsandbox | Remote/self-hosted microVM code sandboxes; TS SDKs | Apache-2.0; beta | maybe | One `run_code` adapter if code execution ships |
| Tools | Daytona, Firecracker | Daytona archived/private core; Firecracker raw VMM | archived / Apache-2.0 | no | Too heavy or decaying; skip |
| Evals | Inspect AI | Dataset/solver/scorer, sandboxed runs, log viewer; UK AISI | MIT, active | maybe | Scorer/log schema for `evaluation/` |
| Evals | promptfoo | YAML assertions, red-team suites, CI gates | MIT, part of OpenAI, active | yes | Declarative assertions feeding the Gate |
| Evals | DeepEval, Ragas, OpenAI evals | Metric catalogs: G-Eval, RAG triad, task completion; OpenAI evals legacy | Apache-2.0 / MIT | maybe | Steal metric definitions; skip the frameworks |
| Evals | SWE-bench, Terminal-Bench, AgentBench | Coding/terminal/multi-env benchmarks | MIT / Apache-2.0 | no | Wrong task shape; product evals beat leaderboards |
| Evals | GAIA | 466 real-world assistant tasks, 3 levels, tool use | MIT, community | maybe | Task-writing template for live datasets |
| Evals | τ-bench | Tool+user-sim domains, pass^k reliability metric | MIT | yes | Add pass^k repeat metric to reports |
| Evals | LiveMCPBench | 95 tasks over 70 MCP servers; retrieval at scale | research paper; license unverified | maybe | Tool-selection scoring once MCP lands |
| Observability | OTel GenAI semconv | `gen_ai.*` spans/attrs for chat, tools, agents | Apache-2.0; still Development status | yes | Map `monitoring.ts`/`prefix-trace.ts` to spans; pin version |
| Observability | Langfuse, Phoenix | OTel-native trace/eval UIs, prompt management | Langfuse MIT core; Phoenix ELv2 | maybe | Self-host Langfuse as OTLP sink; ELv2 blocks resale only |
| Observability | Braintrust, Helicone, AgentOps | Hosted eval/logging, proxy caching, session replay | SaaS / Apache-2.0 / MIT | no | Avoid student-data egress; local events suffice |
| ACI | SWE-agent | Guarded view/search/edit, concise observations, lint feedback | MIT, NeurIPS 2024 | yes | Rewrite `tool-protocol.ts` observations: concise, structured, guardrailed |
| ACI | OpenHands SDK | Composable typed tools + sandboxed runtime | MIT, 2025 | maybe | Tool/runtime boundary before adding subagents |
| ACI | Aider repo map | tree-sitter AST + PageRank, token-budget fit | Apache-2.0 | no | No codebase navigation in product |
| ACI | codex execpolicy | Starlark `prefix_rule` allow/prompt/forbid for shell | Apache-2.0 | yes | Declarative policy replacing hardcoded `approval.ts` logic |
| ACI | Claude Code hooks/skills | Pre/PostToolUse hooks; SKILL.md progressive disclosure | proprietary, public docs | yes | Hooks in `wrappedExecuteTool`; lazy-load `skills/*/SKILL.md` |
| ACI | Cline, Roo Code, Continue | Shadow-git checkpoints/restore; config-driven IDE agents | Apache-2.0 | maybe | Checkpoint pattern for artifact workspace |
| Code-mode | Cloudflare Code Mode | Typed TS API + V8 isolate execution instead of JSON calls | blog pattern | maybe | Read-heavy tools only; isolate dependency heavy |
| Code-mode | Anthropic code execution with MCP | Tool defs as files, model writes code; 150K→2K-token example | pattern/docs | yes | Lazy-load tool/skill definitions; code execution optional |
| Browser | browser-use, WebVoyager | Python browser automation; real-site benchmark | MIT / MIT | maybe | Python-only; borrow WebVoyager task style |
| Browser | Stagehand, Playwright MCP | TS act/extract/observe on Playwright; a11y-tree browser MCP | MIT / Apache-2.0 | yes | Stagehand for UI verification; Playwright MCP if client lands |

## Minimal mature stack (8–10 pieces)

For a small TS product agent with an existing durable loop:

1. **Keep the custom loop + worker.** 14.8k lines are product logic; parallel read batches and a plan ledger beat a new runtime — no LangGraph/Temporal rewrite.
2. **Provider layer:** keep `core/llm.ts`; adopt Vercel AI SDK only when provider/streaming churn outweighs maintenance.
3. **Tool contracts:** Zod schemas + `@modelcontextprotocol/sdk` (MIT) for external tools, still gated by `manifest.ts` risk rules.
4. **Context strategy:** progressive disclosure of tool/skill definitions (Anthropic) + model compaction with anchored facts; no memory framework.
5. **Memory:** Postgres/pgvector in existing Supabase, Mem0-style extract/dedupe/score write-back after each task; candidates go to a review queue, not the prompt.
6. **Observability:** OpenTelemetry Node SDK with pinned GenAI conventions; OTLP to self-hosted Langfuse (MIT) only if a trace UI is used.
7. **Evals:** existing harness + promptfoo-style declarative assertions/red-team + τ-bench pass^k; failed live runs become replay cases.
8. **Safety:** codex-style declarative exec policy + Claude-Code-style Pre/PostToolUse hooks around tool execution; keep the egress allowlist.
9. **Browser:** Playwright + Stagehand (MIT) as one verification tool, not an autonomous browser agent.
10. **Sandbox:** none today; if code execution ships, one E2B/microsandbox adapter behind `run_code`, never a browser-visible VM layer.

Cross-cutting: every borrowed pattern must terminate in `CheckpointState` and the event log, or replay/parity guarantees break.

## Anti-patterns

- **Graph/multi-agent frameworks on a single product agent.** CrewAI, MetaGPT, AutoGen and LangGraph DSLs add a second state model competing with `CheckpointState`; replay stops being byte-for-byte and debugging moves into framework internals.
- **Python-only memory services** (Mem0 server, Graphiti/Zep, Letta server): second datastore, second auth boundary, student data outside Postgres RLS.
- **"Agent OS" platforms** (Agno, Letta server, ADK): they assume your agent is a tenant of their runtime; a queue+worker product agent needs none of it.
- **Eval SaaS as source of truth** (Braintrust, Phoenix for resale): student PII egress; ELv2 restricts offering the software as a service, so it is not a safe bundled dependency.
- **Benchmark chasing:** SWE-bench/Terminal-Bench/AgentBench measure coding and terminal agents; CampusMate failures are evidence, tool-format and honesty failures.
- **Sandbox maximalism:** Firecracker/Daytona before code execution exists; Daytona is archived, and microVMs add ops surface Windows cannot run reliably.
- **Spec-preview coupling:** MCP registry metadata, A2A v1.0, unpinned GenAI conventions — churn without product value; pin versions.
- **Code-mode everything:** executing model-written code for HTTP tools expands the attack surface; use only where tool-call chatter dominates.
- **Dual telemetry:** custom event log plus framework tracing creates two truths and doubles instrumentation.

## Sources

[LangGraph](https://github.com/langchain-ai/langgraph) · [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) · [MCP spec](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [A2A](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations) · [Anthropic code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) · [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) · [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) · [promptfoo](https://github.com/promptfoo/promptfoo) · [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [OTel GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) · [τ-bench](https://github.com/sierra-research/tau-bench) · [Aider repo map](https://aider.chat/docs/repomap.html)
