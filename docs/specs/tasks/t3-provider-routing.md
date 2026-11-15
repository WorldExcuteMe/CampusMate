# T3 认证模型配置与真实路由

Status: locally accepted, single agent. 基线350caed；总Spec v2已获用户“确认”，本文件细化R2/AC05–06，不新增外部操作。

## 契约及选择

- 复用ProviderStore；API公开配置只含hasKey。AES-256-GCM使用服务端32字节主密钥、随机12字节nonce、16字节tag；AAD绑定owner/provider/version，缺主密钥拒绝保存新凭证。支持keyVersion及旧解密键映射，省略apiKey保留、removeSecret明确移除。
- 仅OpenAI兼容协议；能力按配置标记unknown/known及来源，不由模型名正则推断。默认模型展示来自LLM_MODEL和真实响应；旧builtin-deepseek仅兼容别名。
- POST/GET /v1/providers，POST /:id/test、/:id/default，DELETE /:id，均认证且owner隔离。测试连接主动调用小请求；测试仅注入假上游。
- POST /v1/tasks接受providerId；Task冻结不含密钥的modelConfig。Worker按owner解析凭证并核对配置版本，配置编辑/删除后不静默用新key配旧URL，失败提示重新提交。实际响应模型独立存modelRuntime。
- BYOK URL仅公开HTTPS，无用户名/密码/query/hash；复用现有IP/域名守卫，在HTTPS连接lookup时校验实际DNS地址，禁止redirect携带密钥。服务端默认URL受运维配置控制；不让用户传环境白名单。
- 浏览器仅持有providerId/思考偏好；设置与聊天共享认证目录、账号分离query key。新增/编辑/移除凭证/测试/设默认/删除状态和错误可见；无认证后端时说明能力限制。
- T9接续输出/usage/deadline/streaming/reasoning，不在本任务声称缓存收益已验证。安全技能仅source guidance；本地工程回归沿用户已批准流程。

## 影响面（350caed基线）

| 路径 | 现有位置/变化 |
|---|---|
| backend/src/core/llm.ts:4 | 注入带配置的transport，保留原构造兼容，错误脱敏与模型返回契约 |
| 新core/providers.ts、provider-http.ts、credentials.ts及测试 | 模型目录/快照/加密和公开HTTPS出站 |
| backend/src/core/types.ts:44、runtime/store.ts:12、postgres-store.ts:26 | modelConfig/modelRuntime DTO、接受hash和持久化 |
| backend/src/api/server.ts:26、app-context.ts:25、main*.ts | 认证provider接口、API和Worker统一service，无默认key亦可运行BYOK Worker |
| web/src/lib/llm/proxy.ts:5、features/settings/ProviderSettings.tsx:20、features/agent/AgentChatPage.tsx:55 | 统一DTO、设置交互、实际选择与真实模型显示 |
| 新CLI迁移、runtime/migrations.ts | Task模型快照/运行信息JSON增量，不改旧SQL、不应用远程库 |

## GWT及测试

| ID | Given/When | Then | 测试 |
|---|---|---|---|
| P1 | 两用户配置同名provider，提交A/B任务 | 假上游收到各自model/key，历史/公开DTO无key | API→Worker provider-routing集成，memory/PGlite |
| P2 | 保存/编辑省略/移除密钥 | 密文可验证；AAD篡改失败；空主密钥拒绝明文回退 | credentials及API/store回归 |
| P3 | 任务接受后配置变动或删除 | 原快照保留，拒绝用新配置偷偷路由 | Worker配置版本fixture |
| P4 | 私网URL、DNS私网或重定向 | 不泄露凭证、不访问该目标 | URL/lookup fixture；不探测外部地址 |
| P5 | 用户在设置编辑/测试/设默认，聊天选B | UI有结果，任务携带B；刷新模型名正确 | frontend用户行为及请求捕获 |

先新增失败消费者断言再最小实现。串行运行定向测试→后端完整回归→迁移/类型→前端回归/类型/构建；fake fetch/lookup只在I/O边界注入。真实API质量、跨进程PG、部署均未授权且不参与本地验收。

## 回滚及风险

本地分支独立提交；增量JSON列向后兼容。主密钥丢失不能解密，应保留版本键并走受控轮换，不能通过日志恢复。默认环境配置与用户密钥不进入task/checkpoint；上游错误可能回显key，transport统一移除已知凭证后再抛出。认证用户可选择自己的公共LLM端点，无跨用户provider回退。

## 官方核验（2026-11-14）

- [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)：GCM在final后取tag，解密需显式16字节tag校验；本机Node24.21.0已有相应API。
- [Node HTTPS](https://github.com/nodejs/node/blob/main/doc/api/https.md)：HTTPS支持自定义lookup，保持hostname/SNI/TLS验证；按连接实际解析地址校验，不复用先检查再二次DNS的模式。

## Evidence

- memory/PGlite真实API→Worker→假上游分别路由两用户同名provider及内置Gemma；配置/实际返回模型分离，凭证不进入DTO/Task。
- 编辑省略保留、明确移除、默认/删除、模型变更后旧任务拒绝、同turn网络重试复用快照、owner/AAD/nonce/篡改/旧版本键、IPv6映射/保留IP/实际lookup边界均有fixture。
- 最后完整后端224/224；随后新增上游回显/协议缺失用例，最终定向13/13。前端106/106；两侧类型检查、六份迁移16/16、最新生产构建通过。保留既有Vite大chunk提示。
- 设置页编辑/连接测试/默认和认证客户端请求捕获已测；未访问真实模型、Supabase或外部恶意端点，未执行完整安全审计/浏览器端到端，未部署/push。
- 运行要求见docs/MODEL_SETUP.md与backend/.env.example；未生成或改动用户真实密钥。T9继续能力控制、总deadline、streaming及思考档位调用策略。
