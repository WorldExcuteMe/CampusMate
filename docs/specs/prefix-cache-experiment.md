# 前缀缓存观测与候选优化实验（CM_PREFIX_POLICY）

日期 2026-11-18。分支 `feature/agent-local-workspaces`，基于未提交工作区。本文档描述的观测（Phase 1）默认开启；候选优化（Phase 2）默认关闭，只有 `CM_PREFIX_POLICY=1` 或显式 `DeepSeekConfig.prefixPolicy: true` 才生效。

## 1. 端点实测约束（AMD 端点，artifact `external-benchmarks/amd/prefix-cache-probe-20261118.json`）

| 观测 | 结论 | 对实现的影响 |
| --- | --- | --- |
| 1226 tokens 相同前缀重复 | `cached_tokens=1024` | 可复用单位按 **1024 tokens 块** 向下取整，`expectedCacheableTokens = floor(reusablePrefixTokens/1024)*1024` |
| 1226 tokens 冷前缀 | 33.2s；同前缀热请求 1.1s | 冷前缀长度是首要 A/B 指标；`coldPrefixBlockTokens` 单独上报 |
| 系统提示词中段改字节 | `cached_tokens=0`，整段失效 | 段 A 单一哈希；中段变化 → `changedSegment="system"`，可复用块置 0 |
| 提示词末尾追加 | 旧前缀仍命中 | 段 A 末尾追加 → `changeKind="prefix-append"`，只保留旧稳定前缀块 |
| 历史压缩/改写 | 改写点之后失效 | 段 C 每消息边界滚动哈希 + `firstDivergence.index`，只保留差异点之前的块 |
| `reasoning_effort` 为 high/max | 端点在最前注入思考提示词（+79/+92 prompt tokens） | 请求指纹记录 requested/effective/family；档位变化 → `changedSegment="effort"`；理由见 §4.2 |

## 2. Phase 1 观测（始终开启）

新增模块 `backend/src/core/prefix-trace.ts`，在 `DeepSeekTransport.chat()` 中**请求体完成序列化、发送之前**计算一次 `PrefixTrace`，并随现有 telemetry 通道下发：

- 不新增事件类型，复用现有 `llm.request` / `llm.response` 事件里的 `payload.telemetry`；`LlmTelemetry` 通过结构扩展携带 `prefixTrace`（`types.ts` 未改动）。
- 成功响应的 `result.telemetry.prefixTrace`、失败时 `LlmTransportError.telemetry.prefixTrace` 都携带同一记录；agent-loop 的现有 `llm.response` 事件自动转出到事件库与评测 trace。
- 不改变请求体（同一请求一次 `JSON.stringify` 后既发送又供追踪读取），不改变预算、工具可见性和生成参数（Phase 2 关闭时）。
- 只输出哈希、长度、角色、计数：**绝不包含提示词正文**（单测 `事件只含哈希/长度/角色，绝不含提示词正文` 强制）。

### 2.1 分段定义

设 `messages` 为实际发送的 wire `messages` 数组，`systemEnd` 为领先 system 消息数，`tools` 为按名称排序后的工具定义（`llm.ts` 已有的稳定排序）。

| 段 | 内容 | 指纹定义 |
| --- | --- | --- |
| A `system` | `messages[0..systemEnd)`（JSON 工具协议端点合并后含协议正文） | `sha256(JSON.stringify(systemMessages))` 精确字节；`chars` 为同一序列化串长；`tokens=messagesTokens(systemMessages)`；`change` 为与上一请求相比 `unchanged / appended / middle`；`hoisted` 为被旧合并逻辑提升进 system 区的尾部 system 消息数 |
| B `tools` | 工具定义块 | `sha256(canonicalArgs(tools))`（键排序 canonical JSON，与既有 `toolsHash` 同构）；`chars` 为 canonical JSON 长度；`tokens=toolsTokens(tools)`；`placement=body/system/none`；`changed/added/removed` 为工具集变更点 |
| C `history` | `messages[systemEnd..]` 的会话历史 | 滚动链：`h₀=sha256("prefix-trace:v1:history|"+scope.id)`，`hᵢ=sha256(hᵢ₋₁+"\\n"+JSON.stringify(mᵢ))`；每个消息边界记录 `{index, role, hash, chars(累计), tokens(累计)}`；`firstDivergence` 与上一请求比较逐边界哈希，输出 `{kind, index, previousRequestId}`，`kind∈initial/none/extended/changed/truncated` |
| D `compaction` | 历史压缩摘要消息（`【历史摘要：已压缩…】`，逻辑索引定位） | `sha256(JSON.stringify(摘要消息子集))` + 条数/索引/字符/token |
| E `dynamicTail` | 运行期动态观测：`tool` 结果消息、JSON 协议 `[工具观测…]`、尾部 system 注入（如 `【研究交付进度】`）、`[系统提醒]` 重复提醒 | 同上（子集哈希 + 索引 + 角色） |

D/E 是 C 的逻辑子集（C 是物理 wire 链）；被旧合并逻辑提升进 A 的尾部消息由 `system.hoisted` 暴露。

### 2.2 缓存估算

```
stablePrefixTokens = system.tokens + (tools.placement === "body" ? tools.tokens : 0)
coldPrefixTokens   = stablePrefixTokens + preambleTokens(端点注入的思考提示词，默认未配置)
coldPrefixBlockTokens = floor(coldPrefixTokens / 1024) * 1024

// 与上一请求比较（同一 tracer 实例、同一 scope）：
middle 改 system / tools 变化 / effort 变化 / scope 变化 → reusable = 0（实测整段失效）
system 仅末尾追加                                   → reusable = 上一请求 coldPrefixTokens
历史仅追加（extended）或不变                        → reusable = stablePrefixTokens + preamble + 差异点之前的历史 tokens
历史改写（changed/truncated）                        → reusable = stablePrefixTokens + preamble + 差异点之前的历史 tokens
无基线                                              → reusable = 0（basis="no-baseline"）
expectedCacheableTokens = floor(reusable / 1024) * 1024
```

`basis=no-baseline` 时 `expectedCacheableTokens=0`，冷前缀用量看 `coldPrefixBlockTokens`。响应回来后 transport 回填 `observed={inputTokens: usage.inputTotal, cachedTokens: usage.cacheRead}` 供 A/B 对照。

### 2.3 事件样例（`llm.response` payload，节选）

```json
{
  "type": "llm.response",
  "payload": {
    "round": 1,
    "model": "deepseek-chat",
    "toolCalls": 0,
    "telemetry": {
      "requestId": "9a7cfddf-…",
      "attempts": 1,
      "prefixTrace": {
        "version": 1,
        "requestId": "9a7cfddf-…",
        "requestSeq": 1,
        "round": 1,
        "stage": "simple",
        "scope": { "id": "90268c…", "source": "explicit", "complete": true, "userIdHash": "a24a7f…", "workspaceHash": "0065ab…", "conversationHash": null },
        "policy": { "enabled": true, "mode": "tail-stable", "effortLocked": false, "toolPruning": "disabled", "notes": [] },
        "system":  { "hash": "7516ef…", "chars": 56, "tokens": 25, "count": 1, "change": "unchanged", "hoisted": 0 },
        "tools":   { "hash": "b0f5be…", "chars": 191, "tokens": 48, "count": 2, "names": ["web_fetch","web_search"], "placement": "body", "changed": false, "added": [], "removed": [] },
        "history": {
          "messages": 3, "chars": 252, "tokens": 58, "rollingHash": "e3adfc…",
          "boundaries": [
            { "index": 0, "role": "user", "hash": "0120b7…", "chars": 37, "tokens": 17 },
            { "index": 1, "role": "assistant", "hash": "4152e0…", "chars": 188, "tokens": 46 }
          ],
          "firstDivergence": { "kind": "extended", "index": 1, "previousRequestId": "33d433…" }
        },
        "compaction":  { "hash": "4f53cd…", "chars": 2, "tokens": 0, "count": 0, "indices": [] },
        "dynamicTail": { "hash": "4c630e…", "chars": 66, "tokens": 12, "count": 1, "indices": [3], "roles": ["tool"] },
        "effort": { "requested": "auto", "effective": "low", "family": "deepseek_thinking", "stage": "simple", "preambleExpected": false, "preambleTokens": null, "changed": false, "previous": { "effective": "low", "family": "deepseek_thinking" } },
        "cache": {
          "blockTokens": 1024, "stablePrefixTokens": 73, "preambleTokens": null,
          "coldPrefixTokens": 73, "coldPrefixBlockTokens": 0,
          "matchedHistoryMessages": 1, "reusablePrefixTokens": 90, "expectedCacheableTokens": 0,
          "basis": "previous-request", "prefixInvalidatingChange": false,
          "changedSegments": [], "changedSegment": null, "changeKind": "tail-only"
        },
        "total": { "chars": 624, "tokens": 131 },
        "overhead": { "hashedChars": 850, "hashCalls": 8, "elapsedMs": 0.179 },
        "observed": { "inputTokens": 1500, "cachedTokens": 1024 }
      }
    }
  }
}
```

### 2.4 作用域（scope）与安全

`prefixTrace.scope`：

- `id = sha256(canonicalArgs({version, provider: baseUrl, model, userId, workspaceId, conversationId}))`
- `userIdHash / workspaceHash / conversationHash` 是 16 位 hex 哈希前缀，**原始 id 不进入事件**；`complete` 仅在调用方显式提供 userId 和 workspaceId 时为 true。
- 滚动基线（上一请求比较）保存在 **transport 实例**上，而生产路径每个任务经 `ProviderService.transport(task)` 构造新 transport，因此基线不会跨任务/跨用户复用；`scope` 变化会记 `changedSegment="scope"` 并置可复用块 0。
- 当前限制：`providers.ts` 未把 `task.userId` 传入 transport（该文件不在本轮允许写入范围）。显式 `DeepSeekConfig.prefixScope` / `CM_PREFIX_SCOPE_USER` + `CM_PREFIX_SCOPE_WORKSPACE` 已支持；生产完整用户/工作区 scope 需要后续在 `providers.ts` 的 `new DeepSeekTransport({...})` 加一行 `prefixScope: { userId: task.userId }`（本轮未做，见 §7）。

## 3. 开销（实测）

代表性请求：20 个云工具（tools JSON 6566 字符）、system 约 3.6k 字符、11 条历史消息，序列化请求体 25089 字符。

| 指标 | 值 |
| --- | --- |
| 每请求哈希字符数 | 30393（≈1.21×请求体；含每消息 64 字符链盐与 system/tool canonical 字节） |
| 哈希调用数 | 24–30 次（system 1 + tools 1 + 每条历史 1 + 压缩/尾部子集 2 + 链种子 1） |
| 追踪耗时 | 冷请求 1.62ms；连续热请求中位 0.58ms（最大 2.21ms） |
| 复杂度 | O(request size)，无 I/O；相对一次模型请求（1–180s）可忽略 |

## 4. Phase 2 候选优化（默认关闭）

启用方式（任一）：

- 环境变量 `CM_PREFIX_POLICY=1`（transport 构造时读取；`transportFromEnv` 也接受）
- 程序化 `new DeepSeekTransport({ ..., prefixPolicy: true })`

关闭时行为与改动前逐字节一致（单测验证两个相同配置 transport 的请求体 `deepEqual`）。

### 4.1 尾部动态观测不再插入历史之前

`jsonTools`（JSON 工具协议）且端点未声明 `singleSystem` 时，旧逻辑把**所有** system 消息合并到首条 system 中，于是运行期追加的尾部 system 观测（`[系统提醒]`、`【研究交付进度】`、续写标记等）每轮都被提升到历史之前，导致整段缓存前缀失效。开启策略后只合并**头部连续** system 消息 + 工具协议，尾部 system 观测保留在原位（真实追加位置）。模型可见文本顺序不变、内容不变，只改变 system 消息的物理位置；`singleSystem=true` 的端点仍必须合并，trace 记 `notes:["single-system-endpoint-hoists-tail-system"]`。

### 4.2 同一任务阶段锁定思考档位

段 A+B+工具放置方式与上一请求完全一致（同一任务阶段、同一 transport 实例）时，若阶段路由（`generationPolicy`）会改变 `effective` 思考档位，则沿用上一请求的档位参数，trace 记 `policy.effortLocked=true`。理由：实测 high/max 会让端点在最前注入思考提示词（+79/+92 tokens），档位切换等于在**最前面**改字节，整段缓存失效。阶段前缀已变化（新阶段/新任务/工具变化）时照常采用新档位，并记 `changedSegment="effort"`。默认关闭时档位切换仍按原逻辑发生，但 trace 会如实标记该事件为前缀失效。

### 4.3 工具集变更点显式记录；不自动裁剪

工具集变化（段 B 改变）必然使整段缓存失效，因此策略**不做隐式裁剪**：`prefixTrace.tools` 的 `changed/added/removed/placement` 记录每一次变化，`cache.changedSegments` 含 `"tools"`、`expectedCacheableTokens=0`。自动按阶段裁剪工具会改变模型可见能力（提示词语义/评测行为），本轮不实现；现有 agent-loop 在 summary 阶段 `requestTools=[]` 的显式阶段切换仍会发生，并被记录为工具集变更点。

## 5. 维护与回滚

- 关闭候选：移除/取消 `CM_PREFIX_POLICY`，或 `prefixPolicy:false`；观测保留。
- 完全回滚：删除 `prefix-trace.ts` 与新测试、把 `llm.ts` 中 telemetry 挂载与 `transportFromEnv` 两处新增字段去掉即可；`context.ts` 只新增导出常量，`agent-loop.ts` 只新增 2 个可选 `round` 参数。
- 工具裁剪若要上线，必须在 trace 中新增显式 `tool-set change point` 事件并在同一任务阶段保持工具集不变，否则 A/B 无法归因。

## 6. A/B 需比较的三个指标

1. **冷前缀长度**：`prefixTrace.cache.coldPrefixBlockTokens`（字节稳定前缀按 1024 块取整的 tokens），以及未取整的 `coldPrefixTokens`。预期候选不改变该值（它衡量固定成本，不因缓存命中而变）。
2. **热缓存命中率**：对 `prefixInvalidatingChange=false` 且 `basis="previous-request"` 的请求，`observed.cachedTokens / observed.inputTokens`；并与 `expectedCacheableTokens` 比较（设备/端点本地估计与提供商计量的偏差）。按轮次均值 + 按任务加权各报一次。
3. **每次成功的未缓存输入**：按任务汇总 `Σ(observed.inputTokens − observed.cachedTokens) / 成功任务数`（`observed.cachedTokens` 缺失时按 0 计并单列未知比例）。这是最终指标：冷 prefill 昂贵（33.2s vs 1.1s），它直接连接超时率与任务成功率。

辅助字段：`overhead.elapsedMs`（确认观测开销）、`cache.changeKind` 分布（`tail-only` 占比越高越利于缓存）、`firstDivergence.index` 分布（定位压缩/改写事件）。

## 7. 已知限制（本轮未解决）

- **端点注入的思考提示词不可观测**：trace 只能记录 `effort` 指纹与配置的 preamble token 估算（`CM_PREFIX_PREAMBLE_TOKENS='{"high":79,"max":92}'`）。未配置时 `preambleUnaccounted=true`，`expectedCacheableTokens` 会少算 preamble 块；A/B 时请配置实测值或用 `observed.cachedTokens − expectedCacheableTokens` 差值校正。
- **用户/工作区 scope 未接入生产 transport**：`providers.ts` 在允许写入范围之外，见 §2.4；当前生产 trace 的 `source="endpoint"`、`complete=false`，多用户隔离依靠「每任务新 transport + 提供商按账号/模型缓存」。后续接线只需一行。
- `singleSystem` 端点仍会提升尾部 system 观测（端点约束），trace 以 note 标记，A/B 时这些端点应单独分层比较。
- 基线按 transport 实例串行假设；transport 若被并发共用，trace 的「上一请求」比较仅作近似（不影响请求体）。脚本化/注入 transport 不经过 `DeepSeekTransport`，不产生 prefixTrace（评测 scripted target 不受影响）。
- `expectedCacheableTokens` 是「字节完全相同 + 块对齐」下的上界估计：提供商缓存 TTL、账号/实例分片、其他并发流量都会让 `observed.cachedTokens` 更低；用 `observed` 校正，不要用估计值代替真实计量。

## 8. 验证命令

```powershell
cd backend
node --test --test-concurrency=1 src/core/prefix-trace.test.ts   # 13 pass
node --test --test-concurrency=1 src/core/prefix-trace.test.ts src/core/llm.test.ts src/core/llm-policy.test.ts `
  src/core/llm-stream.test.ts src/core/llm-deadline.test.ts src/core/deepseek-thinking.test.ts `
  src/core/deepseek-tool-protocol.test.ts src/core/context.test.ts src/core/agent-loop.test.ts  # 76 pass
npx tsc --noEmit -p tsconfig.json                               # exit 0
```

不运行全量后端套件、不跑真实模型基准、不提交。
