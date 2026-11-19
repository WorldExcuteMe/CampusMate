# Agent Architectures & Paradigms — State of the Art (2025–2026)

Re-architecture reference for a small product agent. Every dimension a mature system covers, what frontier systems actually ship, and 12 ranked moves. Sources in §(c).

## (a) Dimension checklist

| # | Dimension | Mature practice | Example systems | Why it matters |
|---|---|---|---|---|
| 1 | Loop primitive | Single `while` loop of model → tools → observation, hard max-steps, explicit stop conditions; ReAct-style interleaved reasoning | ReAct, Claude Code, OpenAI Agents SDK | One loop beats bespoke pipelines; caps are the only reliable cost guard |
| 2 | Deliberate planning | Separate plan artifact (JSON/markdown) produced before acting; plan-and-execute for long tasks; ToT/value-search only for high-branching search | Plan-and-execute, Tree-of-Thoughts | Turns implicit intent into auditable state that survives compaction |
| 3 | Plan mode / exit-plan gate | Read-only planning phase, then an explicit `exit_plan_mode`-style tool returning a plan for human approval; approval switches to write permissions | Claude Code plan mode + permission modes | Cheapest human-in-the-loop control point; prevents expensive wrong-direction work |
| 4 | Reflection | Post-episode verbal critique stored for the next attempt (Reflexion); self-consistency sampling (k samples, vote) for high-stakes answers | Reflexion, self-consistency | Recovers a large share of failures without weight updates |
| 5 | Steering & interrupts | Asynchronous user messages injected between steps, cancel/abort current tool, pause-and-resume; tool calls classified concurrency-safe vs exclusive | Claude Code, DSH rolling-pool dispatch | Users must be able to redirect mid-run or the agent becomes unaffordable to babysit |
| 6 | Checkpoint & resume | Append-only event log (event sourcing) of steps, tool calls, results; resume from last durable checkpoint, not from scratch; deterministic replay | Anthropic research system (durable execution + checkpoints), Temporal-style durable agents | Long runs fail; restart-from-zero is the dominant reliability loss |
| 7 | Context as budget | Token accounting per section; smallest high-signal token set; treat context as a finite attention budget with diminishing returns | Anthropic context engineering | Context rot degrades *all* models at every length increment |
| 8 | Compaction | Summarize history near the limit, preserving decisions/bugs/open threads; clear stale tool results; keep last N files touched | Claude Code compaction, Claude Developer Platform context management | Enables hour-scale tasks inside a fixed window |
| 9 | Filesystem as memory | Notes/todo/plan files outside the window (`NOTES.md`, todo list), re-read on resume; agentic memory tool | Claude Code todos, Claude memory tool, Claude Plays Pokémon | Survives summarization; cheap persistence with minimal tokens |
| 10 | JIT retrieval & progressive disclosure | Keep lightweight references (paths, queries, links) and load on demand; hybrid: preload small stable docs (CLAUDE.md), grep/glob the rest | Claude Code, Anthropic "just in time" pattern | Avoids stale indexing and upfront context dump |
| 11 | Prompt assembly order | Byte-stable prefix (system, tool defs, stable docs) first, volatile history last; never mutate the head | Prefix/KV caching guidance | Only a byte-immutable prefix keeps cache hit rate; a change re-prefills everything after it |
| 12 | Tool schema quality | Minimal distinct tool set, unambiguous descriptions, return-format docs, 1–5 realistic `input_examples` per tool | Anthropic Tool Use Examples (72%→90% param accuracy) | Most tool failures are wrong-tool/wrong-param, not capability |
| 13 | Tool discovery at scale | Defer tool definitions (`defer_loading`), search tools on demand (regex/BM25/embeddings); keep 3–5 hot tools always loaded | Anthropic Tool Search Tool (85% token cut, 134K→~8.7K) | MCP sprawl burns ~50–100K tokens before work starts |
| 14 | Code-mode / PTC | Model writes code orchestrating tools in a sandbox; only final output enters context; loops, joins, filtering in code | Cloudflare Code Mode, Anthropic Programmatic Tool Calling, DSH PTC | 37% token cut, removes N−1 inference passes, fewer errors |
| 15 | Parallel & batched calls | Concurrent dispatch with per-tool safety class; `asyncio.gather` inside code mode; batch API for offline work | Anthropic research (3+ parallel subagents/tools; −90% time) | Latency is dominated by serial inference round-trips |
| 16 | Idempotency & envelopes | Idempotency keys on side-effectful tools; uniform result envelope (`ok`, `is_error`, truncated flag, artifact path, cost); size caps + spill result to file | MCP tool results, Claude Code tool envelopes | Retries and replays must not double-charge or duplicate writes |
| 17 | Interop protocols | MCP for tools/context (2025-11-25: async tasks, URL elicitation); A2A for agent-to-agent (Linux Foundation, 2025); ACP/ANP for other topologies | MCP, A2A, ACP, ANP | Avoids a private tool bus; ecosystem leverage |
| 18 | Multi-agent topology | Orchestrator–worker with tight task briefs (objective, format, tools, boundaries), effort-scaling rules, condensed 1–2K-token returns | Anthropic Research (90.2% over single-agent on internal eval) | Buys parallelism and context isolation, at ~15× chat token cost |
| 19 | Isolation & shared state | Git worktree per code subagent; shared state via files/task board, not chat; subagent writes artifacts, returns references | Claude Code `isolation: worktree`, Anthropic artifact pattern | Prevents write conflicts and "game of telephone" loss |
| 20 | Memory hierarchy | Short-term context; core/recall blocks; archival store; episodic/procedural/semantic split; extraction + dedup + invalidation pipeline; forgetting/consolidation | MemGPT/Letta, Mem0, Zep (temporal KG; LoCoMo/DMR SOTA) | Cross-session continuity is the product moat for a personal agent |
| 21 | Verification | Separate verifier with rubric (not same-context self-check); end-state assertions for state-mutating tasks; eval gates + CI regression | Anthropic LLM-judge rubric, judge-subagent patterns | Self-grading is biased; independent checks catch confident errors |
| 22 | Guardrails & approvals | Input/output classifiers, allow/deny/ask policy per action, approval prompts for irreversible ops, deny-by-default for destructive verbs | Claude Code permission modes + auto-mode classifier, OpenAI Agents SDK guardrails/`needs_approval` | Autonomy must be bounded by blast radius, not vibes |
| 23 | Failure handling | Typed errors, bounded retries with backoff, model fallback, circuit breakers, graceful degradation, uncertainty/abstention | Anthropic research reliability practice | Compound errors derail long runs; restarts are expensive |
| 24 | Execution sandbox | MicroVM/isolate per session (E2B Firecracker, Daytona, Modal, Cloudflare isolates); CPU/mem/time/disk caps, network allowlists, no host FS | E2B, Daytona, Cloudflare Dynamic Workers | Untrusted generated code is the core security surface |
| 25 | Browser / computer use | Headless browser + accessibility-tree selectors over screenshot-only CUA; cloud browsers for isolation | browser-use, Browserbase, OpenAI CUA (OSWorld 38.1%) | Reaches systems without APIs; weaker than APIs, use as fallback |
| 26 | Observability | OTel GenAI semconv (`gen_ai.*`, `invoke_agent`/`execute_tool`/`chat` spans), full trajectory logs, per-run token/cost ledger | OTel GenAI semconv, Datadog LLM observability | Non-deterministic runs are undebuggable without traces |
| 27 | Eval harness | 20–50 golden tasks first, LLM-judge rubric + programmatic end-state checks, public anchors (SWE-bench Verified, Terminal-Bench 2.0, GAIA, AgentBench, τ²-bench), online A/B, regression gate | Anthropic research evals, Terminal-Bench, τ-bench | Prompt tweaks have huge effect sizes; small evals catch them |
| 28 | Model routing | Effort tiers per step (minimal→max), cheap-model default with escalation on failure/uncertainty, cascades/speculative draft+verify, structured output schemas | Claude effort parameter (5 levels), GPT-5 `reasoning_effort`, RouteLLM | Largest single cost lever; 40–76% token savings at equal quality |
| 29 | Self-improvement | Trace-driven optimization (DSPy, GEPA reflective prompt evolution), memory of failures, skill libraries induced from trajectories, eval-driven iteration | DSPy/GEPA, Voyager, Agent Workflow Memory | Compounds gains without retraining; must be gated by evals |
| 30 | Deployment hygiene | Rainbow/gradual rollout, versioned prompts+tools, per-agent config, cost quotas per tenant | Anthropic research (rainbow deploys) | Running agents must not be broken by mid-flight upgrades |

## (b) 12 highest-leverage ideas for a small product agent (ranked impact/cost)

1. **Append-only event log + checkpoint/resume.** Every step, tool call, result, and cost is an event; resume replays from the last checkpoint. Highest reliability-per-line-of-code; enables replay-based debugging later.
2. **Compaction + todo/plan file + tool-result clearing.** The single biggest capability unlock for long tasks; near-zero infrastructure.
3. **Prefix-stable prompt assembly + caching.** Order context stable→volatile, freeze system/tools, append history. Cost/latency win with no behavior change.
4. **Tight, small toolset with result envelopes and size caps.** Cap results, spill overflow to files, return `{ok, error, path, tokens}`. Prevents most failure modes cheaply; add tool search only past ~10 tools.
5. **Plan → approve → execute gate.** Read-only plan, explicit approval tool, then write permissions. Cheap HITL and the best cost guard against wrong-direction work.
6. **Independent verifier pass.** A second, cheaper call with a rubric on the artifact, feeding one bounded retry. Outperforms self-critique in the same context.
7. **Trajectory logging with OTel GenAI attributes + per-run cost ledger.** Prerequisite for every later optimization; without it you tune blind.
8. **20–50 golden-task eval suite with a CI regression gate.** Small evals suffice because early prompt changes move success 30→80%.
9. **Sandboxed execution with resource and network limits.** Non-negotiable once the agent writes/runs code; microVM or isolate per session.
10. **Effort tiers + escalate-on-failure routing.** Cheap model + low effort by default; escalate on verifier failure or low confidence. Biggest cost lever.
11. **One context-isolated subagent for the noisiest subtask.** Research/search/file-exploration worker returns ≤2K tokens. Buys context headroom; don't build a team.
12. **Post-task memory write.** Extract preferences/lessons/failures into a small store, retrieve top-k at task start, consolidate periodically. The durable product differentiator.

Anti-patterns to skip at small scale: open-ended multi-agent teams, screenshot computer-use, ToT/MCTS search, full A2A mesh, custom memory infrastructure. All burn cost for capability you can rent later.

## (c) Links

**Agent loops & control** — [ReAct](https://arxiv.org/abs/2210.03629) · [Reflexion](https://arxiv.org/abs/2303.11366) · [Tree of Thoughts](https://arxiv.org/abs/2305.10601) · [Self-consistency](https://arxiv.org/abs/2203.11171) · [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) · [Claude Code permission/plan modes](https://code.claude.com/docs/en/permission-modes)

**Context engineering** — [Anthropic: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Chroma context rot](https://research.trychroma.com/context-rot) · [Lost in the Middle](https://arxiv.org/abs/2307.03172) · [Context management (compaction/memory tool)](https://www.anthropic.com/news/context-management) · [Automatic context compaction cookbook](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)

**Tools & ACI** — [Anthropic advanced tool use (search, PTC, examples)](https://www.anthropic.com/engineering/advanced-tool-use) · [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) · [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) · [MCP spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog) · [MCP/ACP/A2A/ANP survey](https://arxiv.org/abs/2505.02279) · [A2A announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) · [A2A → Linux Foundation](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/)

**Multi-agent** — [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Claude Code subagents (worktree isolation)](https://code.claude.com/docs/en/sub-agents)

**Memory** — [MemGPT](https://arxiv.org/abs/2310.08560) · [Zep temporal KG](https://arxiv.org/abs/2501.13956) · [Mem0](https://arxiv.org/abs/2504.19413) · [Letta memory docs](https://docs.letta.com/)

**Verification / guardrails** — [OpenAI Agents SDK guardrails & approvals](https://openai.github.io/openai-agents-python/guardrails/) · [LLM-judge principles](https://dl.acm.org/doi/10.1145/3731120.3744588)

**Execution environments** — [E2B](https://e2b.dev/docs) · [Daytona](https://www.daytona.io/docs) · [browser-use](https://github.com/browser-use/browser-use) · [OSWorld](https://arxiv.org/abs/2404.07972) · [Cloudflare Dynamic Workers (isolates)](https://www.infoq.com/news/2026/04/cloudflare-dynamic-workers-beta/)

**Observability & eval** — [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) · [GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) · [Datadog OTel GenAI](https://www.datadoghq.com/blog/llm-otel-semantic-convention/) · [Terminal-Bench](https://www.tbench.ai/) · [SWE-bench](https://www.swebench.com/) · [GAIA](https://arxiv.org/abs/2311.12983) · [AgentBench](https://arxiv.org/abs/2308.03688) · [τ-bench](https://arxiv.org/abs/2406.12045)

**Models & routing** — [Claude Opus 4.5 effort parameter](https://www.anthropic.com/news/claude-opus-4-5) · [RouteLLM](https://arxiv.org/abs/2406.18665)

**Self-improvement** — [DSPy](https://dspy.ai/) · [GEPA](https://arxiv.org/abs/2507.19457) · [Voyager skill library](https://arxiv.org/abs/2305.16291)
