# DSH Architecture Digest — transferable design for CampusMate

Source: local checkout `C:\Users\Asus\CodeBuddy\dsh-src` (origin `deepseek-ai/deepseek-harness`): English subsystem docs plus skimmed sources (`agent-loop`, `compaction`, `subagent`, `tool-todo`, `spill`, guard packages). Date: 2026-11-19. Refs are `docs/subsystems/<name>.md` or `packages/<path>`.

DSH is a general-purpose, plugin-composed harness serving several products; its cost buys composability and cross-process replay. CampusMate is one product: copy the mechanisms, not the machinery.

## 1. Execution model

DSH's spine is the `agent` handle plus the `agent-loop` driver over an append-only session log. Every typed event carries a monotonic `seq`, and model history is *derived* from the log (`deriveMessages()`), never stored separately. One driver owns one agent: waking input opens a durable turn, and the turn runs steps until neither a live tool call nor fresh steering remains. Each step claims inbox input atomically (all `next-step` items plus one `next-turn` item at a turn boundary), collects prompt sections and visible tool schemas, runs the `agent/pre-step` waterfall (reject or rewrite the batch), appends `step/start`, captures the model route (writing `request/header` only when the envelope changed), reconciles the rendered prompt into `system/message` surface nodes, admits the claimed user messages (first attempt only), projects a runtime-context snapshot after history only if it changed, derives the request (`header.config` + derived messages + `header.tools`; no `system` field), streams, dispatches tool calls through the guarded registry, and appends every accepted fact. Retries reuse the same assembly. Steering has its own lane (`steer` = next step, `inject` = context without waking, `followup` = new turn); a serial `turn-stopping` hook can only object by steering, so listener order cannot change the outcome. Cancellation keeps already-streamed text and pairs skipped calls with synthetic error results. Resume opens the persisted log with a write handle and repairs a mid-turn crash by *appending* `interruptedTurnClosers` (missing tool errors, `step/end`, `turn/end{interrupted}`) — never rewriting history; `session/flush` is the checkpoint awaited before the next turn. (`core.md`, `agent-loop/README.md`, `packages/core/agent-loop/src/agent.ts:333`, `persistence.md`)

## 2. Dimension table

| Dimension | DSH mechanism | Decision worth copying | Source refs |
|---|---|---|---|
| Loop & steering | Durable turn/step machine; two-lane inbox; `steer`/`inject`/`followup`; `agent/pre-step` waterfall | Corrections land at step boundaries, new tasks at turn boundaries; hooks steer, never block by order | `core.md` |
| Request derivation | Request = header + derived messages + tools; header only on change (route/tools/series/resume) | Log the envelope only when it changes → reconstructable and stable-prefix | `agent-loop/README.md` |
| Prompt assembly & caching | Ordered sections; volatile facts as runtime-context message after history; prompt as `system/message` node; in-history updates append | Prompt is replayable history, not a request field; append-only updates keep the KV prefix | `system-prompt.md` |
| Planning / todo | Plan mode = guidance + logged `plan/mode` + conditional exit tool; todo_write = whole-list replace, no IDs | Whole-list last-write-wins needs no IDs; guidance ≠ enforcement | `plan.md`, `todo.md` |
| Tools & progressive disclosure | Typed params + canonical output; schema by allowlist; step-time admission + scope filters; skills/tools disclosed when active | One definition drives schema, validation, execution, UI; host fields never reach the wire | `tools.md`, `skills.md` |
| Tool results & spill | Post-execute accept/replace/block; oversized results → head+tail + locator + retrieval hint | Bound output at the boundary, keep the full copy addressable, degrade best-effort | `spill.md` |
| Context compaction | Logged bracket: start → summary → one replacement message → end; trigger 0.8·W, keep newest 16%; overflow trigger separate | Compaction is a transaction; replacement shadows instead of deleting; call/result pairing preserved | `compaction.md` |
| Subagents / delegation | Provider seam; local child = durable session + parent catalog + depth cap; result carries a stop reason | New session with explicit lineage and depth cap; partial output never reads as success | `subagent.md` |
| Skills | `name` + one-line description catalog as a durable reminder; body loaded on demand | Description catalog + pull-by-name; body lands in history as a tool result | `skills.md` |
| MCP | Client adapts server tools into registry tools; resources as tools; instructions as a capped section | External tools use the same pipeline, not a side channel | `mcp.md` |
| Permissions / approvals / sandbox | allow/deny/cancel/ask; approval `allowed-once`, fail-closed, log-only audit; monotonic guards; three sandbox modes per call | Closed outcomes + fail closed; monotonic guards; policy resolved per call | `approval.md`, `sandbox.md` |
| Observability | Token meter prices surface nodes (usage anchor + delta) and exposes pressure; telemetry mirrors every event into ledger/ops channels, read-only | One measurement drives thresholds and UI; telemetry never mutates the log | `token-meter.md`, `session-telemetry.md` |
| Recovery / checkpointing | Flush before the next turn; interrupted turn repaired by appended closers; single writer; goals keep durable phase, process-local continuation | Repair as ordinary events; separate durable state from permission to continue | `persistence.md`, `goal.md` |
| Loop hygiene guards | Exact-repeat chain per agent, advisory at 3/5/8; per-tool `timeoutMs` → `TOOL_TIMEOUT` | Advisory beats hard blocks; budget on the tool, enforcement in a wrapper | guard READMEs |

## 3. Implement these 8 first

1. **Append-only session log, history by fold** *(must-copy)* — 6–8 event types with monotonic `seq`; `deriveMessages()` as a pure function; resume = replay; UI reads the same log; tests assert on logs.
2. **One loop with turn/step boundaries + two-lane inbox** *(must-copy)* — claim a batch atomically; a pre-step hook may reject or rewrite; `steer` = next step, `inject` = context only, `followup` = new turn; always append `turn/end{completed|aborted|error}`. Add a step cap (DSH deliberately has none).
3. **Tool registry + guarded pipeline + structured results** *(must-copy)* — model schema built by allowlist; internal metadata never serialized; every call produces a paired result with `isError`, `{code,message}`, content blocks; pre-dispatch allow/deny/ask; parallel-safe flag with exclusive barriers.
4. **Budgeted tool results with spill-to-file** *(must-copy)* — cap inline output (~8–12k tokens), keep head+tail, write the full result to storage, return locator + "read/grep this path"; save failure keeps the inline result.
5. **Deterministic prompt + cache-safe dynamic context** *(must-copy)* — static sections sorted by order; volatile facts (date, student profile, term) as one runtime-context message appended after history, re-emitted only when changed; reuse the rendered prompt across retries.
6. **Compaction checkpoint with retained tail** *(must-copy)* — at ~80% window summarize the oldest contiguous span into one marked summary, keep the newest ~16% verbatim, never split a call/result pair or shadow the system prompt; log one record; retry once with a larger cut on overflow.
7. **Progressive disclosure catalog** *(must-copy if >6 procedures/tools, else nice)* — one session-start reminder listing `name + one-line description`; `load_skill(name)` returns the full body into history; republish only on change.
8. **Token accounting + structured error telemetry** *(must-copy-lite)* — price each message, anchor on provider usage, show context pressure; emit one structured event per turn/tool error to a side sink. Skip OTel, redaction, product analytics.

**Next, when a story demands:** subagent delegation (new session + prompt + structured result, depth 1), repeat-call reminder at 3, plan mode, goal rounds, MCP.

## 4. Anti-overengineering warnings

- **Skip seam/provider/DI ceremony.** DSH splits each capability into abstract service + implementation + consumer (Cordis DI, scoped registries) so other products can swap them. Use plain modules and one config object.
- **Don't copy the event taxonomy.** Thirteen core events, log-only variants, `surfaceOp`, `sourceEventSeqs`, projections, strict folds — start with 8 events and a `surface` flag.
- **Skip type ceremony**: branded IDs, declaration-merged `…Map` unions, drift-checked docs.
- **One prompt + one dynamic context is 90% of the caching win.** Four admission modes and per-node prompt replacement only pay off at scale.
- **Compaction exotica** (orphan-lock detection, shadow-price events, per-node repricing, image offload, six error codes): one summarize-and-replace step suffices.
- **Subagent manager** (continuable children, cold resume, catalogs, name resolution, ACP/Codex providers): defer; one `spawn_subagent` covers most needs.
- **Goal (256-round continuation), workflow (JS VM orchestrating subagents), plan mode, MCP resources**: skip until a user story demands them.
- **Recovery machinery** (torn-frame decoding, `TOOL_OUTCOME_UNKNOWN`, write-behind windows): keep the principle — pair every call with a result, repair by appending — not the code.
- **Configurability**: DSH exposes ratios, headroom, retries, caps, locale strings. Pick defaults; expose one or two knobs.
