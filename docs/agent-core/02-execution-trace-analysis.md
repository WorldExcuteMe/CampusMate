# 02 · 执行 Trace 分析（失败复现 + 修复前后 + 基线）

> 真实代码取证。包含一条失败 Trace 的逐步还原、修复前后对比，以及当前自动化基线。

## 1. 失败 Trace：`真实模型调用中断（[object Object]）`

任务：用户「把这条竞赛讲座写进 inbox」。模型正常返回 `tool_calls: save_to_inbox`，但 Supabase 写入命中唯一约束冲突。

### 修复前（逐步）
```
t1  runChat → llmChat(/api/llm)            ✅ HTTP 200，模型返回 tool_calls=[save_to_inbox]
t2  executeTool("save_to_inbox")           进入 dispatchTool
t3  repo.createInbox(item)                 Supabase 返回 { error: {message:"duplicate key …", code:"23505"} }
t4  SupabaseRepository: if(error) throw error   抛出【普通对象】（非 Error）  supabase.ts:84
t5  异常冒泡穿过 executeTool（无 try/catch）→ runChat catch
t6  reason = String(err)                   = "[object Object]"             旧 chat.ts:466
t7  return { reply:"真实模型调用中断（[object Object]）…", mock:true }
```
关键误判：**t1 模型调用成功**，却在 t7 被报成「模型中断」并降级假 Mock。用户看到 `[object Object]`，无法判断真因（其实是 DB 唯一约束冲突）。

### 修复后（逐步）
```
t1  runChat → llmChat(/api/llm)            ✅ HTTP 200，tool_calls=[save_to_inbox]
t2  executeTool → dispatchTool → repo.createInbox   抛 PostgrestError 对象
t3  executeTool 安全边界 catch             return JSON.stringify({error:`工具 save_to_inbox 执行失败：${errorMessage(e)}`})
                                           = {error:"工具 save_to_inbox 执行失败：duplicate key value … | code: 23505 | hint: use upsert"}
t4  messages.push({role:"tool", content: 上述可读错误})   模型循环继续（不中断）
t5  llmChat 第二轮                          ✅ 模型读到工具错误，自然语言如实说明「写入失败（重复），不再重复写入」
t6  return { reply: 模型真实答复, mock:false }
```
证据：`chatResilience.test.ts` 断言第二轮 `/api/llm` 请求体含 `role:"tool"` 且 `content` 含 `duplicate key value`、不含 `[object Object]`；`out.mock===false`。

## 2. 三类错误路径对照（修复后）

| 触发 | 分类 | mock | 模型循环 | 用户可见 |
|---|---|---|---|---|
| 工具/DB 抛任意值（含普通对象） | 工具观测 error | false | 继续 | 模型如实说明，可读真因 |
| 真实传输失败（网络/上游/超时/非JSON） | LlmTransportError | true | 终止本轮 | 「模型连接失败（真实原因）」+ 排查指引 |
| localStorage 配额满 | best-effort 静默 | false | 继续 | 成功答复正常返回 |

## 3. 当前自动化基线（V1 Baseline，可重复）

运行：`node node_modules/vitest/vitest.mjs run`（无需手动输入提示词，脚本化 LLM 驱动）。

- **82 测试 / 16 文件全通过**；`tsc --noEmit` exit 0。
- benchmark 场景（benchmark.test.ts）：B2 总结群+合并 inbox+写雷达、B5 网页搜索+写雷达、B7 长任务 plan+memory checkpoint、B10 指定 QQ 群锁定 scope 不暴露 web_search、B9 抗幻觉查不到如实说明。
- 韧性回归（本次新增）：errors(10) + chatResilience(3)。
- 真实模型冒烟：HTTP 200 / `deepseek-flash` / 「在线」 / 948ms。

> 这是 GPT 文档第 4 阶段「30 场景 Benchmark」的起点子集。现有 benchmark 已覆盖容器写入/搜索/长任务/作用域/抗幻觉/错误韧性；尚缺：跨会话恢复、进程崩溃恢复、陌生学校官网、来源冲突、独立验收、幂等、预算硬停（对应 Test 1/3/6/7/8/9/10）。

## 4. 取证结论与下一步（不盲目大规模重构）

F0（[object Object] / 虚假模型中断）已根因修复并验证。按 GPT 文档纪律，下一步先补 **持久化任务状态 + 事件日志 + Checkpoint**（Phase B/C）与 **独立 Evaluator**（Phase E），再谈 Multi-Agent。每项改动须回答：原问题→参考的成熟设计→选型理由→改动组件→测试证据→业务影响。

建议的最小增量顺序（每步带 TDD 与回滚）：
1. `TaskRecord` + append-only 事件日志（Supabase 表），chat 主循环每步落 `goal/task/step/toolcall` ID 与 token/time。
2. Checkpoint：每轮工具循环后写快照；`resume(taskId)` 从最后成功检查点续跑（满足 Test 3）。
3. 幂等键：业务写入工具带 `idempotencyKey`，重复触发不重复写（满足 Test 9，闭合 F5 缺口）。
4. 独立 Evaluator：验收条件 + 证据校验，执行 Agent 不得自判成功（满足 Test 8）。
5. 预算硬停：token/time/tool-call 预算，超限部分交付或请求决策（满足 Test 10）。