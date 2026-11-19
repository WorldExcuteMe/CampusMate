# Frontend Agent UI — Backend API Gap Audit

Audited 2026-11-19 from source. Key files: `api/server.ts`, `runtime/worker.ts`, `runtime/store.ts`, `runtime/postgres-store.ts`, `core/providers.ts`, `core/llm.ts`, `core/manifest.ts`, `core/capability.ts`, `runtime/workspace-files.ts`, `runtime/approval.ts`, artifact/document/credential handlers. `backend/scripts/eval.ts` is a CLI harness over `/v1/tasks` and `/v1/tasks/:id/events`; it adds no UI API.

## 1. Existing HTTP/SSE surface

Zero-framework Node http, JSON `/v1`, default 8 MiB body cap (`server.ts:73-81`), CORS `*` (cloud) or strict local origin (`server.ts:93-98`; `local-app.ts:60-73`). Auth is Supabase JWT HS256/ES256/RS256 (`api/jwt.ts:40-66`); SSE may pass `?token=` because EventSource cannot set headers (`server.ts:108-110`). Owner isolation everywhere; local mode enforces one owner (`server.ts:113-114`). Errors are `{error}` with 400/401/403/404/409/413/422.

| Method + path | Purpose | Request → response | Auth |
|---|---|---|---|
| GET `/v1/health` | liveness | → `{ok,store}` | none |
| GET/POST `/v1/local-workspace` | local permission (local mode only) | `{permission:"ask"\|"full"}` → `{workspace:{owner,name,permission}}` | JWT+owner |
| GET `/v1/providers` | list BYOK + builtin | → `{providers:[{id,displayName,protocol,baseUrl,modelId,hasKey,capabilities,contextLimit,metadataSource,isDefault,builtin}]}` | JWT |
| POST `/v1/providers` | upsert provider | `{providerId,displayName,baseUrl,modelId,apiKey?,capabilities?,contextLimit?,removeSecret?}` → `{provider}` | JWT |
| DELETE `/v1/providers/:id`; POST `…/test`; POST `…/default` | remove / live probe / set default | → `{ok}`; `{ok,configuredModel,actualModel,note}`; `{ok}` | JWT |
| GET/POST `/v1/sessions`; PATCH/DELETE `/v1/sessions/:id`; POST `…/import` | session CRUD (tombstone delete, `expectedRevision`) | session DTO → `{session}`/`{sessions}` | JWT |
| GET `/v1/sessions/:id/history`, `/history/page`, `/history/changes` | full / paginated / delta history | → `{session,messages,tasks,after,before,next,totalTokens}` | JWT |
| GET `/v1/sessions/:id/messages?afterSeq`, `/tasks` | incremental messages / turns | → `{messages}`, `{tasks}` | JWT |
| POST `/v1/tasks` | accept turn (queued) | `{title,intent?,sessionId?,turnId?,images?:string[],providerId?,reasoning?,budget?}` → 201 `{taskId,sessionId,turnId,status,deduped}` | JWT |
| GET `/v1/tasks/:id`; GET `…/events?after`; GET `…/stream?token&after`; POST `…/cancel`, `…/resume` | task snapshot, event replay, SSE, control | `{task}`, `{events:[AgentEvent]}`, SSE events `task_event`/`task_status`/`close`/`stream_error`, `{ok}`/`{task}` | JWT; SSE query token |
| GET `/v1/tasks/:id/artifacts` | artifact metadata (inline stripped) | → `{artifacts:[…]}` | JWT |
| GET `/v1/artifacts/:id`; `…/download?format=md\|docx\|pdf` | document preview AST / export; linked-source file | `{artifact,availableFormats}`; file bytes + `X-Artifact-Sha256` etc. | JWT |
| GET `/v1/approvals`; POST `/v1/approvals/:id` | pending approvals / decide | `{approvals}`; `{decision:"approved"\|"rejected"}` → `{approval}` | JWT |
| GET `/v1/capabilities` | capability manifest (runtime/caps/permissions/quotas) | → `{manifest}` | JWT |
| `/v1/terms`, `/v1/schedules*`, `/v1/timetable-schemes`, `/v1/opportunities*`, POST `/v1/workflows/*` | calendar/opportunity/workflow surfaces (`server.ts:296-383`) | as specified in their handlers | JWT |

SSE is per-task (1 s poll, `after`/`Last-Event-ID`, terminal status closes; `server.ts:250-280`) — no session-level multiplex, no task-list (`GET /v1/tasks`), and artifact lists strip inline content.

## 2. Gap matrix — 8 requested UI capabilities

| # | Capability | Status | Evidence | Proposed additions |
|---|---|---|---|---|
| 1 | Provider onboarding | **partial** | list/save/delete/test/default exist (`server.ts:125-135`; `providers.ts:40-97`); DTO exposes capabilities/contextLimit/metadata (`providers.ts:13-22`). Test requires a saved key and one "OK" chat (`providers.ts:92-97`; `api/provider-routing.test.ts:63-66`); no model catalog, probe-before-save, or single-provider GET. | `GET /v1/providers/:id`; `POST /v1/providers/probe` (API key never echoed); `GET /v1/providers/:id/models`; `POST /v1/providers/:id/capabilities/check`; optional catalog cache table |
| 2 | Model settings persistence | **partial** | `contextLimit` persisted per provider (`providers.ts:60-62`; `postgres-provider-store.ts:21-24`); reasoning is per request only (`server.ts:200-201`) snapshotted into the task and applied downstream (`worker.ts:377-378`; `providers.ts:90`; `llm.ts:137`); no user/session default (UI uses localStorage). | `user_agent_settings` + `GET/PATCH /v1/settings/model` `{defaultReasoning,thinking,contextLimitPreset,maxOutputTokens,defaultProviderId}`; resolve in `POST /v1/tasks` (explicit body wins) and snapshot into `modelConfig` |
| 3 | Context occupancy + token/cache stats | **partial** | `task.promptUsage{inputTokens,contextLimit,outputReserve,source}` (`types.ts:58`; written `worker.ts:400`; DTO `server.ts:59-65`); `modelRuntime.lastRequest` has input/output/reasoning/cacheRead/cacheWrite/costUsd + ttft/attempts/reasoning effective (`types.ts:201-211`; `llm-usage.ts:16`; `llm.ts:223-235`), pushed via `llm.response` and task_status. | `POST /v1/context/estimate` (session/turn inputs → tokens, limit, reserve, breakdown); per-round occupancy peak; `GET /v1/sessions/:id/usage` with cache-hit totals (history only returns `totalTokens`, `session-feed.ts:83`) |
| 4 | Permission full vs workspace-only | **partial (local only)** | `{permission:"ask"\|"full"}` persisted in PGlite identity `full_since` (`local-workspace.ts:32-45`; `pglite-pool.ts:51-58`); route `server.ts:115-121`; gate uses task `createdAt` (`local-app.ts:101-104`; `worker.ts:287-296`) plus host-scope checks (`worker.ts:581-597`). Cloud API has no storage and does not mount the route (`main-api.ts:13`). | settings `permission_level` + `GET/PATCH /v1/settings/permissions`; snapshot on task; server-enforced approval for cloud; `task.permission` in DTO; audit permission changes |
| 5 | Work-step events | **partial** | Events exist: `step.started/finished`, `tool.called/tool.result` (stable callInstanceId, duration, sanitized summary/sourceUrls), `llm.request/response/delta`, `run.summary`, `tool.recovered`, `budget.exceeded`, `eval.*` (`types.ts:112-117`; `agent-loop.ts:428-437,642-688`; persisted `worker.ts:401-407`; served `server.ts:250-280`). Missing: reasoning/thinking deltas (captured internally `llm-stream.ts:48-52`, only text streamed `:53-57`; `reasoning_content` stripped `server.ts:175`); no args/output/terminal preview in events (full tool output only via fetching its artifact id); no invocation listing (`getInvocation` only, no route); plan/todo only in checkpoints (`agent-loop.ts:385,440,771-772`), no `plan.updated`/`step.updated`. | new event types `reasoning.delta` (provider-supplied only, opt-in), `tool.output` (bounded preview + exitCode), `plan.updated`, `step.updated`; extend `tool.called/result` with sanitized args/output preview; `GET /v1/tasks/:id/tool-invocations` |
| 6 | Multimodal upload (images/files/docs) | **partial (images only)** | `images:string[]` (data URLs/URLs), max 4 (`shared/attachments.ts:2-7`; validation `server.ts:185-188`; behavior `api/task-images.test.ts:9-41`). No size/type/page validation server-side, no multipart route, no attachment record (inline in `agent_tasks.images`, server-only `postgres-store.ts:182-192`), no endpoint to re-open an uploaded image. Docs are parsed in-browser into intent text (`web/src/lib/ingest/limits.ts:72-77`). | `POST /v1/attachments` (multipart → `{id,kind,mime,size,sha256}`), `GET /v1/attachments/:id` + `/content`, `attachmentIds[]` on task create (keep `images[]`); server magic-byte/size/page limits; store via `agent_artifacts` (`kind="upload"`, `storage_path`) |
| 7 | Workspace file listing/preview/download | **missing over HTTP** | `WorkspaceFiles` already has safe list/read/write/search/run, traversal+realpath checks, 100-entry and 256 KiB caps (`workspace-files.ts:19-141`), but only agent tools/companion can call it (`local-app.ts:49-55`; `worker.ts:312-321`); no `/v1/workspace*` route. Documents are reachable as artifacts (`server.ts:213-239`), agent-written workspace files are not. | local-only `GET /v1/workspace/tree`, `/file`, `/file/download`, `/stat` with owner+`includesPath` guards; bounded text/JSON, download via stream |
| 8 | Agent settings storage | **missing** | No settings store/table exists; only PGlite identity singleton (`pglite-pool.ts:51-58`); defaults live in browser localStorage; per-task snapshots are the only durable agent config. | `user_agent_settings` (user_id PK, model defaults, permission_level, approval prefs, revision, updated_at) + `GET/PATCH /v1/settings/agent`; optional per-session override |

## 3. Secrets & safety

- Provider keys: AES-256-GCM envelopes in `user_llm_providers.encrypted_secret`, 32-byte master key only in env (`PROVIDER_MASTER_KEY`/`PROVIDER_DECRYPTION_KEYS`), AAD binds userId+providerId+keyVersion (`credentials.ts:5-39`; table `supabase/migrations/20261114061420_campusmate_shared_storage.sql:87-117`; intentionally no client RLS policy, line 198). Responses expose only `hasKey` (`providers.ts:13-22`); tests assert no key/ciphertext leaks (`provider-routing.test.ts:31-33`).
- Local mode stores a per-workspace vault key in PGlite `campusmate_local_identity.vault_key` and injects it at startup (`local-workspace.ts:25-27`; `local-app.ts:42`).
- Never send to clients: API keys, ciphertext/nonce/tag/keyVersion, provider `Authorization`, master key, raw `reasoning_content` (opaque continuation is server-only; stripped at `server.ts:175`), raw tool args/output (only sanitized view; URL query and `sk-` secrets redacted `worker.ts:619-635`; `task-events.ts:2-19`). Images are never returned by task endpoints (`TASK_STATE_COLUMNS` excludes images, `postgres-store.ts:20-22`; SSE test asserts this).
- Approvals: `agent_approvals` stores tool name/args/risk/status under owner RLS; decide is owner-scoped (`server.ts:392-404`; `postgres-approval-store.ts:12-29`). `GET /v1/approvals` returns `args` verbatim — expected for an approver, but preview-bound the payload.
- Permission storage today is local-only (`full_since`). Cloud CORS is `*` but JWT is required; local binds 127.0.0.1 and rejects foreign Host/Origin (`local-app.ts:62,68-73`). SSE query tokens can leak into logs — issue short-lived stream tokens. No rate limiting; `POST /v1/providers/:id/test` makes a paid call per request (`providers.ts:92-97`).

## 4. Migration/backward compatibility and tests

- Migration registry `runtime/migrations.ts:4-17`; PGlite replays the same SQL at workspace init (`pglite-pool.ts:31-59`). Additive idempotent SQL only (`if not exists`, nullable/defaulted columns); PGlite strips top-level `BEGIN/COMMIT` and the pgcrypto `create extension`.
- New tables/columns: `user_agent_settings`, `agent_attachments` (or new artifact kind), `agent_tasks.permission_level` (nullable default "ask"). Keep `/v1` additive: `taskView` is an explicit allowlist (`server.ts:59-65`) and must add fields deliberately; unknown `task_event` types are ignored by current clients.
- Snapshot compatibility: persisted defaults apply only to new tasks; existing `configVersion` mismatch still returns 409 (“re-send with new message”, `providers.ts:85`).
- RLS: mirror the shared-storage pattern (owner `select`, service-role writes, no secret read policy); register new migrations in `MIGRATION_PATHS` and run on PGlite and PG.
- Tests to add: `api/settings-api.test.ts`, `api/provider-catalog.test.ts`, `api/attachments.test.ts`, `api/workspace-files.test.ts`, `runtime/permission.test.ts`, `runtime/context-usage.test.ts`; extend `runtime/worker-events.test.ts`; migration coverage in `runtime/shared-state.test.ts`/`runtime/postgres-integration.test.ts`.

## 5. Top 10 backend tasks (ranked by impact/effort)

| rank | Change | Impact/Effort | Files | Tests |
|---|---|---|---|---|
| 1 | Settings store + `/v1/settings/{agent,model}` | High/Medium | new migration, `core/storage-contracts.ts`, new settings store (`runtime/postgres-settings-store.ts`, `memory-storage.ts`), `api/server.ts`, `app-context.ts` | new `api/settings-api.test.ts`, `runtime/shared-state.test.ts` |
| 2 | Provider onboarding: probe-before-save, model catalog, provider GET | High/Medium | `core/providers.ts`, `core/provider-http.ts`, `api/server.ts` | `api/provider-routing.test.ts`, `core/provider-http.test.ts` |
| 3 | Work-step events: reasoning, tool/terminal output, plan | High/Large | `core/types.ts`, `llm-stream.ts`, `llm.ts`, `agent-loop.ts`, `runtime/worker.ts`, `api/server.ts` | `core/llm-stream.test.ts`, `runtime/worker-events.test.ts`, `api/stream.test.ts` |
| 4 | Attachment upload service + task binding | High/Large | new `runtime/attachments.ts`, `shared/attachments.ts`, `core/storage-contracts.ts`, `runtime/postgres-artifact-store.ts`, `api/server.ts`, migration | new `api/attachments.test.ts`, `runtime/storage-contracts.test.ts` |
| 5 | Cloud permission persistence + audit | High/Medium | settings store, `runtime/worker.ts`, `runtime/approval.ts`, `main-api.ts`, `api/server.ts` | new `runtime/permission.test.ts`, `runtime/approval.test.ts` |
| 6 | Context estimate + usage/cache aggregation | High/Medium | `core/context.ts`, `core/context-builder.ts`, `api/server.ts`, `runtime/session-feed.ts` | `core/context.test.ts`, `api/sessions-api.test.ts` |
| 7 | Workspace file HTTP API | Medium/Medium | `runtime/workspace-files.ts`, `api/server.ts`, `runtime/local-app.ts` | new `api/workspace-files.test.ts`, `runtime/local-workspace.test.ts` |
| 8 | Tool invocation listing/detail API | Medium/Small | `runtime/store.ts`, `runtime/postgres-store.ts`, `api/server.ts` | `runtime/store.test.ts`, `runtime/postgres-store.test.ts` |
| 9 | Artifact preview DTO + task-scoped content | Medium/Small | `api/server.ts`, `core/document-service.ts`, `runtime/postgres-artifact-store.ts` | `api/artifacts.test.ts` |
| 10 | Rate limits + short-lived stream tokens | Medium/Small | `core/providers.ts`, `api/server.ts`, `api/jwt.ts` | `api/input-validation.test.ts`, `api/stream.test.ts` |

**Blockers:** no cloud settings/permission store; missing SSE event types for reasoning/plan/terminal output; no upload/attachment store; no model-catalog endpoint; no workspace file route; SSE is per-task.
