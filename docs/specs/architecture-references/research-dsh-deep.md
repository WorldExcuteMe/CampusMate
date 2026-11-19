# DSH Deep Dive — subsystems beyond the first digest

Source: `C:\Users\Asus\CodeBuddy\dsh-src` (docs, package READMEs, source maps); refs are `docs/...` or `packages/...`.

## 1. Extensions & hooks

**Extensions** (`packages/extensions/cordis-host-runner`, `docs/subsystems/extensions.md`) is self-extension: agents define versioned Cordis packages whose host half runs in a `node:vm` (`src/sandbox.ts`) and browser half in a page. `define` precompiles both halves (runs nothing) and mints immutable package ids; a browser-half `run` emits `cordis/request-run` and suspends until a page answers `runHostHalf → getClientCode → resolveRequestRun`; `stop` retracts effects but keeps the definition. Definitions are session-scoped, process-local. **Not a security boundary — "treat like bash."**

Hook taxonomy is core: three event domains (durable session, live `agent/*`, capability `fs/* tools/*`) and five dispatch modes (`emit|parallel|serial|bail|waterfall`; `docs/cordis-primer.md`). Loop points: `agent/pre-step` waterfall (the only pre-request chain; accepts/rewrites/rejects the claimed batch; reject or empty first batch closes the turn with no step), `agent/request-error`, serial `agent/turn-stopping` (no `next()`; objects only by steering), `system-prompt/assemble`, `llm/stream`, `tools/pre-execute|execute|post-execute`, `approval/request`. Waterfall = around-middleware: you must call `next()`, and wrappers preserve downstream decisions via `{...decision, messages}`. Fail-closed: no approval answerer → `unavailable`; archived session rejected in pre-step; a throwing telemetry listener withholds that record.

**Borrow:** one small typed bus, 3 modes, ~8 names; policy in listeners, mechanism in services. **Skip:** dynamic package runner, browser halves, five modes, declaration-merged typing.

## 2. Presets

Preset = YAML: `id` + child plugin rows (`packages/preset/agent-preset`). The registry eagerly mounts each preset into a scoped tree, keeps revisions, and binds an agent to the revision current at creation; the session log records the preset id. Resume resolves *today's* definition of that id and rejects a missing one; edits affect only new agents (KV stability). Failed definitions stay visible; activation audits imports, missing services and leaks. `persona` is a scope-only row shadowing deployment prompt prefix/suffix. Deployments compose profile → bundles → `cordis.patch.yml` → home patch → `--patch` overlays.

**Borrow:** profile as data (id, model route, tool allowlist, prompt sections, permission policy), persisted per session, boot-validated, immutable for a live session. **Skip:** mount trees/revisions; presets are not sandboxes.

## 3. Goals

Event-sourced, one goal per session: each mutation appends `goal/change` with the full post-state (clear = tombstone); phases `active|paused|blocked|complete`; blocked carries a stable code + message; CAS by `{id, revision}`; default cap 256 rounds. Durable phase and process-local armed/disarmed are separate — every session-start edge disarms. The round driver (`packages/goal/goal-round-driver`) reserves round n at idle, queues a `<goal_round>` prompt; only an *entered* user message consumes the cap; a pre-step listener re-verifies before **and after** `next()`; before queueing it awaits `sessions.flush()` then rechecks. Stops: cap (blocker `round-limit`), max-token turn end, write failure, cancellation (pause at next idle), unload (disarm only), resume/fork (disarmed until human resume). No token budget or evaluator by design.

**Borrow:** durable objective + phase + round cap with admission accounting, disarm-on-resume, explicit stop reasons. **Skip:** projection unit, strict-replay validation; fold tool+command+driver into one feature.

## 4. Team & workflow

**Team** (`packages/team/agent-team`) adds a durable board to the root log: whole-snapshot tasks with revision CAS, `blockedBy` DAG, advisory `writeScopes`, root-only reassign; membership comes from the subagent tree. Task commits never wake agents; no automatic owner release.

**Workflow** (`packages/workflow/workflow`) runs a model-written JS script in a subprocess/PTC engine with hooks `agent(prompt,{schema})`, `parallel`, `pipeline`, `phase`, `log`; one blocking call returns `{runId, agentsStarted, result}`. Engine is split from capability; runs are holder-owned and must be disposed; results never reject (`stopReason`); caps: 1000 agents, 4096 items/call, CPU-based concurrency, 5 s sync slice; hook misuse is fatal, child failure → `null`. No journal/resume, foreground only.

**Borrow:** delegation contract (fresh session, depth cap, structured result + stop reason; partial failure never reads as success); a CAS task board only when >2 agents; a narrow `pipeline()` with schema results and hard caps — not a code VM. **Skip:** PTC workflow engine, RALPH, broadcasts.

## 5. Schedule

Durable tasks in a versioned storage unit (v2 with `compatibleVersions:[1]`, decode-normalize at open). Seven timing kinds (`after/at/every/daily/weekly/cron/rrule`; Vixie cron, bounded RRULE), one committed UTC occurrence advanced on delivery. Targets: existing `session`, `new_once` (reserve id, create on first delivery, reuse), `new` (fresh session per run, 60 s floor). Host timer only: tasks survive restart but only the latest missed occurrence fires. Delivery = enqueue a user-role reminder into the target inbox, await flush, then save receipt + next occurrence in separate commits → **at least once**; a receipt proves inbox persistence, not execution. Management uses `expectedUpdatedAt` CAS.

**Borrow:** durable store + pure recurrence evaluator + inbox delivery + receipt/history + CAS + "collapse missed occurrences, host must run." **Skip:** seven kinds (pick at/every/daily/cron), version ladder, change notices.

## 6. Projection, query, controller

**Projection** (`packages/session/session-projection`): units register `{key, stateVersion, init(header, inheritedEventCount), apply(state,event), wire.view, wire.summary}`; the registry drives every committed event synchronously and publishes only when the raw view reference changes. `snapshot()` returns `{asOfSeq, values}` — one consistent cut for the UI.

**Query** (`packages/session-query/session-query`): live-preferred corpus, detached clones, exact reads/filters/lineage; search delegated to a backend.

**Controller** (`packages/api/session-controller`): RPC endpoints with per-resource access control; prompt admission is idempotent by `requestId`; history is per-event pages with an inclusive seq cursor plus a `follow` journal stream (live chunks are client-only frames); fork copies the inclusive prefix at `atSeq` (default: latest completed turn) into an independent session; `create` reuses a blank named session; resume conflict → `session/writer-held`; an archive gate runs in pre-step.

**Borrow:** projections as the only UI read model, history pages + follow stream, idempotent prompt ids, fork-by-seq. **Skip:** multi-carrier roles, cursorless assistant frames, list work slices. Transport is subscription RPC + journal streams, not SSE.

## 7. PTC runtime

`ctx.ptcRuntime` (`packages/ptc-runtime/ptc-runtime`) is a seam: `resolve(request)` validates cwd/deadline/sandbox → `run(spec)` executes a program against named async bindings, returning lossless-JSON `value`, ordered `output`, or `error`. Node provider: fresh managed process under the file sandbox, defaults 120 s timeout / 600 s max, 64 MiB output, 128 pending calls. Tool mode (`packages/core/tool-executor-ptc`): `run_code` is the only directly callable tool; a deterministic SDK is generated from the scoped `ToolDefinition` list, each binding capturing a frozen schema; calls traverse the normal approval/guard/log pipeline; allowance `floor(timeoutMin × maxSubCallsPerMinute)` (default 1024/min) plus `maxParallelSubCalls` 10 with exclusive barriers; failed calls reject with `ToolCallError`; only the outer result is size-capped. The VM is not a security boundary.

**Borrow only if tool count is large:** one code-mode tool, scoped generated SDK, per-program call budget, parallel-safe scheduling, outer-result cap; for ≤10 tools native calling wins. **Skip:** multi-language portability, retained REPL, image inspect, mode matrix.

## 8. Guards and token meter

`repeat-tool-reminder`: detection on `tools/post-execute` (also fires for denied calls), per-agent chain keyed by (tool, deep-key-sorted args), thresholds `[3,5,8]`, advisory; delivered via `additionalContexts` → the loop injects a user message after results; in-memory. `timeout-policy`: per-tool `timeoutMs` on the definition; a `tools/execute` wrapper fuses `exec.signal`, classifies scoped `TOOL_TIMEOUT`, replaces the result with `ToolTimeoutError`; cooperative only; registration order decides outer (retry-wide) vs inner (attempt). `token-meter`: replay-based fold prices the surface (4 chars/token), reuses provider usage only for an identical canonical envelope, exposes `tokenUsage`, `contextPressure`, `contextBreakdown`; compaction reads `measure()`, UI divides by model capacity.

**Borrow:** advisory repeat guard, per-tool timeout on the definition, one shared measurement service. **Skip:** four projections/shadow-price machinery, image pricing.

## 9. Package-boundary lessons

- Core spine = replaceable singleton services with data contracts: session log, agent registry/loop, tool registry+pipeline, prompt assembly, llm adapter, scope. Everything else is a plugin; "every part is a plugin, including the loop" (`docs/architecture.md`).
- A seam needs three roles: Service Definition / Provider / Consumer. Policy ≠ capability: `fs-observation-policy` registers no service; it decides `fs/*` waterfalls, and removing it doesn't break the tool. Mechanism in services, policy in listeners.
- Composition is data: profiles → bundles → patches, presets as YAML. In a monolith: one config object + feature flags, not a runtime loader.

## 10. Target architecture — CampusMate v2

Inward-only deps; kernel publishes hooks, features subscribe.

- `kernel/events` — append-only log, schemas, pure fold (history/surface/projections); `kernel/storage` implements `append/flush/open/list`.
- `kernel/llm` — adapter seam + streaming → events.
- `kernel/hooks` — typed bus (waterfall/serial/emit), ~8 names.
- `kernel/prompt` — ordered sections, persona/preset inputs, runtime-context message → events, hooks.
- `kernel/tools` — `ToolDefinition` (schema+execute+timeout), registry, pipeline, budgeting/spill → events, hooks.
- `kernel/loop` — turn/step machine, inbox, cancellation; deps events, llm, prompt, tools, hooks. Only writer of lifecycle events.
- `features/presets` → tools/prompt/llm; `features/delegation` → loop/events; `features/schedules` → storage + session API; `features/telemetry` → events/tools (read-only).
- `policies/*` (repeat guard, timeout, approval, archive) → hooks/tools only; never imported by the loop.
- `protocol/api` — RPC commands (prompt/cancel/model/rename/fork/create/resume), history pages, follow stream, projection snapshots → events, projections, loop API.
- `app` — config + composition.

Rule: no feature imports another; they meet in kernel APIs; policies point inward and the kernel knows only the hook bus.

## 11. Migration order

1. **Log first.** Dual-write an append-only event schema beside current storage; derive the transcript; replay recorded sessions as golden fixtures; single writer.
2. **Loop boundaries.** Extract turn/step + atomic inbox claim; no-op `pre-step`; always append `turn/end`; repair interrupted turns by appended closers; add a step cap (DSH has none).
3. **Tool unification.** One definition → schema/validation/execution/error/timeout, migrated tool by tool behind flags; add pipeline and spill.
4. **Prompt + measurement.** Deterministic ordered sections, volatile context as one appended message, prefix snapshot tests; then token meter.
5. **Hook bus + policy.** Move repeat reminder, timeouts, approvals/archive checks into listeners; fail-closed tests (no answerer → deny).
6. **Profiles + model seam.** Config-driven profiles with boot validation; record profile id in session.
7. **Protocol.** History pages + follow stream + projection snapshots; old endpoints as adapters; idempotent prompt ids, fork-by-seq.
8. **Features by story:** goals → delegation → schedules → code mode/workflow last.

Each step behind a flag with replay tests; one owner per state; a per-feature kill switch.
