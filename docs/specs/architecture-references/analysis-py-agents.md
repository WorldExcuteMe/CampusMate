# Python-agent architectures: OpenHands, SWE-agent, Aider

**Evidence base.** Trees live in `agent-arch-refs/`; all paths below are repo-relative. OpenHands is the current **Agent Canvas** frontend (v1.42.0, shallow HEAD `8b49946`); its README puts the Python SDK, Agent Server, agents/tools/events and condenser in `OpenHands/software-agent-sdk`, so this clone supplies the event/control-center side, typed wire contracts and docs. SWE-agent is a SWE-agent 1.x tree (`sweagent/`, docs, config); it has no own `.git`, so `rev-parse` resolved an enclosing repo (`f400cb38`). Aider's clone was still extracting when analysis began: I read the tarball copy at `_aider_py_tmp/aider-main/`, which now hash-matches the completed clone at `aider/`.

## OpenHands — event-sourced control plane, not an agent loop

Canvas runs no agent code. Agent Server instances own execution; the browser opens a session WebSocket, renders a typed event stream (actions, observations, state updates, errors), and can drive OpenHands, ACP CLIs, planning agents and child conversations across local, Docker and cloud backends. Its signature idea is treating a conversation as an append-only, resumable event log rather than as chat state.

- **Sequence-cursored replay.** Durable frames may arrive out of `seq` order, so the client resumes from the highest *contiguous* seq and backfills older events via paginated REST search (`src/utils/session-seq-cursor.ts`, `src/api/event-service/event-service.api.ts`); reconnect uses 1s→30s backoff plus a 30s/60s reconnecting/retryable grace period (`src/hooks/use-websocket.ts`, `src/hooks/use-connection-error-grace-period.ts`).
- **Condensation is evented and configurable.** `CondensationEvent` records `forgotten_event_ids` and `summary` (`src/types/agent-server/core/events/condensation-event.ts`). The planning preset mirrors the SDK's `LLMSummarizingCondenser {max_size:100, keep_first:6}` (`src/api/agent-server-adapter.ts:1380`); profiles expose `enable_default_condenser` and `condenser_max_size` (`src/api/settings-service/settings-service.api.ts:536`).
- **Async subagents.** `launch_child_conversation` takes a self-contained brief, target `local|cloud`, isolation `worktree|shared`; the call is acked by the agent-server before the browser acts, and the real outcome arrives later as a `[child-conversation]` message (`src/api/launch-child-conversation-client-tool.ts`, `src/constants/child-conversation.ts`).
- **Replay/audit.** Markdown/HTML transcript export, conversation zip download, `HookExecutionEvent` and a metrics store (`src/utils/transcript-export/index.ts`, `src/hooks/use-download-conversation.ts`); ops cover Docker-per-conversation, a 30s `/alive` watchdog, loopback binding and session keys (`README.md`, `docs/SELF_HOSTING.md`).

## SWE-agent — a benchmark-grade step loop

`DefaultAgent.run()` is an explicit `while not done: step()` loop: sample/parse thought+action, execute through `SWEEnv` (a thin SWE-ReX wrapper over Docker/Modal/AWS deployments), append observation to history and the `.traj`, save after every step. `RetryAgent` wraps attempts with a reviewer model; `ShellAgent` lets a human take over the same loop.

- **ACI as tool bundles**: bash plus a windowed file viewer/editor (`open`, `goto`, `scroll_up/down`), search that lists only matching files, `filemap`, explicit `submit`, and a linter that refuses syntactically broken edits; empty output becomes "Your command ran successfully and did not produce any output" (`docs/background/aci.md`, `config/default.yaml`).
- **State after every action**: a `state_command` returns JSON (open file, cwd; the `diff_state` bundle returns the working diff) for templates and recovery (`sweagent/tools/tools.py`, `docs/config/tools.md`).
- **Autosubmit on any terminal condition**: context/cost/API/env/timeout/forfeit errors all try to extract a patch; submission is detected by a `<<SWE_AGENT_SUBMISSION>>` marker, then `/root/model.patch` is read, and if the runtime is dead the last step's `state["diff"]` is used (`sweagent/agent/agents.py:823`, `sweagent/tools/tools.py:372`).
- **Bounded requery**: format errors, blocklisted commands (vim, `tail -f`, bare python) and bash syntax errors re-prompt with a corrective template up to `max_requeries` (`sweagent/agent/agents.py:1062`, `sweagent/tools/tools.py:29`).
- **Context and replay**: pluggable history processors (`LastNObservations(n=5, polling=…)` to preserve prompt cache, `CacheControl`, `TagToolCallObservations`, `RemoveRegex`; `sweagent/agent/history_processors.py`); `.traj` stores exact `query`/thought/action/observation/state, with CLI/web inspector and `run replay` (`docs/usage/trajectories.md`, `sweagent/inspector/server.py`, `sweagent/run/run_replay.py`).

## Aider — a git-native chat REPL

Aider's loop is human-driven: `input → run_one → send_message → apply edits → auto-commit → lint → shell/tests → reflected_message`, with reflection capped at 3. Context is a repo map plus explicitly added files; every AI edit becomes a git commit, so `/undo` is `git reset --hard HEAD~1`.

- **Repo map**: tree-sitter tags form a `networkx` def/ref graph ranked by PageRank personalized by chat files, mentioned identifiers and path components (`personalize = 100/num_nodes`), rendered within a token budget (1/8 of context, capped 4096; ×8 when no files are in chat) and cached in sqlite (`aider/repomap.py:365`, `aider/models.py:782`).
- **Edit formats with self-correction**: SEARCH/REPLACE blocks, unified diffs, whole files, patches; failed blocks feed back a "Did you mean…" excerpt, and malformed output becomes a reflected message (`aider/coders/editblock_coder.py`).
- **Architect mode**: one model writes the plan, then a second editor `Coder` applies it with fresh history and `editor_edit_format` (`aider/coders/architect_coder.py`, `aider/coders/architect_prompts.py`).
- **Lint/test/commit loop**: `auto_lint` defaults on and offers "Attempt to fix lint errors?" via reflection; `auto_test` (off by default) does the same with `--test-cmd`; edits auto-commit with a weak-model conventional message, dirty files are committed first, and `/undo` reverts (`aider/coders/base_coder.py:106,1681,2375`).
- **History summarization**: recursive head/tail `ChatSummary` keeps recent turns and summarizes the rest as a first-person user message at `max_chat_history_tokens` (1/16 of context, 1k–8k) (`aider/history.py`, `aider/models.py:355`).

## Shared dimensions

| dimension | OpenHands | SWE-agent | Aider | transferable lesson |
|---|---|---|---|---|
| execution | server event stream; UI replay | explicit step loop | human REPL, per message | separate run loop from rendering |
| ACI/tools | typed actions, client tools, ACP passthrough | tool bundles: windowed editor, search, submit, lint gate | bash + edit formats + commands | curate a small, defensive ACI |
| context | LLM condenser + condensation events | history processors, LastN=5 | recursive ChatSummary | condense history, don't truncate blindly |
| repo context | file editor, skills, backend skills | filemap + search | PageRank repo map | rank before you dump tokens |
| orchestration | planning conversation, launch_child | RetryAgent + reviewer loops, human takeover | architect→editor hand-off | delegation is a scheduling problem |
| sandbox | Docker per conversation, host/cloud backends | SWE-ReX container (Docker/Modal/AWS) | none; local git + confirmations | isolate, checkpoint, restart cleanly |
| observability | event log, transcript export, hook events | `.traj` + inspector + replay | git commits, `/undo` | persist exact model inputs |
| recovery | reconnect/backfill, held messages, sandbox resume | autosubmit on every error class | reflections, auto-commit, undo | assume failure; preserve partial work |

## Top 6 mechanisms a small product agent should copy

1. **Event-sourced run log with seq and replay.** Append `{seq, kind, payload}` JSONL; stream it over a socket; reconnect from the highest contiguous seq and backfill from REST history; render UI from the list (`session-seq-cursor.ts` pattern).
2. **Two-tier context budget.** Repo context: tree-sitter signatures ranked by PageRank over chat files/mentions within ~10–20% of the window (Aider repo map). History: pin first N + last N, summarize the middle past ~70% tokens (OpenHands condenser, SWE-agent processors).
3. **Guarded edit loop.** One structured edit format (SEARCH/REPLACE); parse errors returned as tool results with bounded reflection (max 3); lint before returning and inject file/line context; copy Aider's "Did you mean" hint.
4. **Defensive ACI.** Windowed viewer (`open/goto/scroll`), search listing only files, empty-output acknowledgement, explicit `finish`, and a JSON state snapshot (open file/cwd/diff) after each action.
5. **Bounded failure recovery.** Snapshot git diff every N steps; on context/cost/timeout/exception return the best patch plus trajectory; retry only format/API errors once or twice, not every class.
6. **Async child agents with isolation.** A `launch_child(task, isolation)` tool requiring a self-contained brief, defaulting to a git worktree, acking immediately and later posting a result message with child id/status (OpenHands pattern) enables parallel work without blocking.

## 3 anti-patterns / overkill

1. **Benchmark multi-attempt machinery.** SWE-agent's `RetryAgent` + chooser/score retry loops + reviewer model and per-attempt cost accounting (`sweagent/agent/reviewer.py`) optimize leaderboards; in a product they multiply latency/cost and make incidents unreadable. Keep one attempt and one targeted retry.
2. **Multi-service platform sprawl.** OpenHands' split (frontend/SDK/agent server/automation/cloud) plus five ACP CLIs and per-backend contracts is a large surface, and the clone's agent logic lives elsewhere. Start with one process and one sandbox; the seq-gap workaround is a symptom of needing ordering guarantees earlier.
3. **Edit-format and persona zoo.** Aider carries ~16 coder classes, weak/editor/secondary models and voice/watch/GUI modes; the useful core is one edit format plus architect/editor split. Likewise, don't build a condenser inventory (many kinds, per-use attribution, planning condenser) before one rolling summarizer is measured.
