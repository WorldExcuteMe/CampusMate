# T9 调用策略、思考强度与可观测性

Status: locally accepted（2026-11-15收口）。基线f583810，单代理；总Spec v2 R8/R9、AC16–18已批准。无真实模型付费调用/远程迁移/部署。

## 方案与边界

- 稳定规则及较稳定profile在前，时间、task/step/预算、历史摘要与当前输入在后；授权过滤后的工具按名字稳定排序，记录前缀/schema指纹，不能据哈希宣称KV命中已改善。
- ProviderCapabilities配置驱动native tools/JSON/vision/streaming/temperature/output/reasoning；未知不发送厂商私有参数。首批映射reasoning_effort与enable_thinking；thinking_budget必须有明确端点adapter才启用，当前报告受限。
- 用户auto/low/medium/high偏好冻结于Task.modelConfig；Worker按阶段与剩余预算选实际档位并持久化原因。复杂规划/核验允许升级，格式化不默认高档，未知参数族保持未知。
- 单一transport负责最多3次attempt，总deadline覆盖fetch、body及退避，读取Retry-After。400/401/额度/协议/超窗不盲重试；接收任何正文后不重放流式请求；不自动换模型/端点。
- 规范usage的input/cacheRead/cacheWrite/output/reasoning允许null，保留原始数值字段及reasoning是否已包含output，不重复计数。未知价格不假称精确USD；token估算仅供硬预算并明确来源。
- 支持已配置端点的SSE正文增量、分片tools与usage；不采集/显示私密reasoning字段。断流、length、预算停止保留未完成产物/说明并暂停，不能因模型可达就完整成功。
- 大工具输出首次入模型前保留稳定摘要及owner受限artifact引用，完整原文仍保存于transcript/artifact，支持分页读取。重试与检索缓存按任务/owner/参数/内容哈希隔离。
- 不部署原生Anthropic/Gemini协议、通用compute或承诺缓存阈值。真实缓存收益需用户另给模型实验预算。

## 影响面与接口

| 文件/基线位置 | 改动 |
|---|---|
| core/llm.ts:4、types.ts:45/168 | ChatOptions(deadline/output/stage/delta)、telemetry/nullableUsage，ProviderSnapshot生成偏好与runtime信息 |
| 新core/generation-policy.ts、llm-usage.ts、llm-stream.ts及测试 | 端点能力映射、规范计量、受控SSE解析；纯函数与I/O分离 |
| core/context-builder.ts:25、context.ts:160、新system-prompt.ts | 固定规则/动态上下文分层与安全预算 |
| runtime/worker.ts:135、core/agent-loop.ts:120 | 真实接线、硬停、artifact摘要、实际思考策略/请求事件，不止测试helper |
| core/cloud-tools.ts:10、tool-registry.ts:19、main*.ts | owner artifact分页读取及共享固定prompt |
| api/server.ts:130、core/providers.ts:83 | 偏好验证/快照、能力下传及连接测试小输出限制 |
| web/features/agent/AgentChatPage.tsx、lib/agent/{api-client,sessions,chat}.ts、lib/llm/proxy.ts | 偏好UI/任务提交、当前计量、浏览器取消多层重试；T4接事件展示 |

## GWT/测试

| ID | 初始与动作 | 预期 | 验证 |
|---|---|---|---|
| L1 | 两轮仅时间/task变化 | 稳定前缀和schema相同；dynamic变化 | 真实Worker请求捕获 |
| L2 | user high/auto复杂规划，经API提交 | 已知族实际带参数；未知族无字段且记录受限 | API→Worker→假上游 |
| L3 | 缺失/0/cache/reasoning包含fixture | null/0可区分，reasoning不重复累加 | usage模块与transport |
| L4 | 429 RetryAfter/慢body/取消/401 | attempt与总deadline受控，不乘法重试 | 可注入I/O/时钟fixture |
| L5 | 正文流断/length/预算不足 | 部分内容保留且paused，完整成功被拒 | transport→Worker |
| L6 | 大工具结果，后续分页 | 首次模型只见摘要+引用，原文/owner检索正确 | Worker与artifact集成 |

先消费者Red再实现Green；串行定向→完整回归→类型/迁移→前端/构建。示例provider统计不是质量或缓存基线。

## 官方核验（2026-11-14）

- [OpenAI Chat Create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：参数支持因模型而异；max_completion_tokens包含思考与正文；stream usage可能在断流时缺失。
- [OpenAI Streaming](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)：正文/工具delta与最终usage分离，reasoning计入completion tokens。
- [DeepSeek Cache](https://api-docs.deepseek.com/guides/kv_cache/)：usage提供cache hit/miss，best effort不保证固定命中率。

## 验证记录

- 首组5个消费者断言Red，分别复现high未传、usage丢失口径、慢body超时失效、SSE解析缺失、Worker把截断当成功；现均Green。
- 真实API→Task快照→Worker→假上游收到high；前端真实组件选择high后请求捕获正确，窗口与实际模型来自后端。
- 固定system/profile前缀、动态clock/task分离、工具排序与指纹；大结果首次模型仅见摘要+artifact引用，原始transcript完整保留，owner隔离已测。没有真实KV收益数据。
- unknown/0/cacheRead/cacheWrite/reasoning包含关系、SSE正文及分片tools、断流/length、429 Retry-After/总deadline/401/3attempt均有fixture。私密reasoning字段不进入返回或事件；原始usage只保留数值计数字段。
- 摘要自身计入预算、当前目标固定保留、未授权工具/参数拒绝；工具组预算中断在memory/PGlite恢复不重复已做步骤，预算需明确调整。已记录的非幂等异常结果不盲重试、不假成功。
- 完整后端236/236；随后补充非幂等异常回归，最终相关14/14；前端107/107；类型、六份迁移16/16、生产构建通过。Vite既有chunk提示保留。
- USD价格未确认时telemetry.costUsd为null；内部costUsd计数器0不表示免费，当前以token/tool/wall限制为准。原生协议、真实缓存基准、多进程PG、真实模型/浏览器全链及崩溃瞬间外部副作用仍需独立环境验收，不声称分布式exactly-once。
- 回滚通过独立本地提交；没有数据删除或外部发布。T4接续事件可靠补拉、可见时间线、刷新重附着及取消/恢复。
