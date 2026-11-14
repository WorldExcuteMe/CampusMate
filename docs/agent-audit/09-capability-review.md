# 09 · Capability 审查

## 重点检查 6：Capability Registry 是否实际参与执行决策

**结论：Complete。Registry → Manifest → 工具门控实际参与 Worker 执行。**

### 执行链路（真实参与）
- `core/capability.ts CapabilityRegistry`：registerCloudDefaults 注册云端 Provider（llm.chat/web.fetch/web.search/rag.search/db.*）。
- `core/manifest.ts buildManifest`：Worker.executeTask 任务前调用，叠加 Companion 授权能力。
- `core/tool-registry.ts manifestTools`：按 Manifest 可用能力过滤 `taskTools`，注入 runAgentLoop → **模型实际看到的工具集由 Manifest 决定**。
- `resolveCapability`：缺失→ALTERNATIVES 替代 / 明确报告不可用（禁止假装）。

### 证据
- capability.test.ts(7)：云端默认无本机能力、健康检查、Manifest 叠加、缺失替代、无替代报告、工具门控、ToolSpec 元数据。
- worker-manifest.test.ts(3)：**CaptureTransport 断言模型实际工具集**——云端含 web_search 不含 run_terminal；Companion 注册后 run_terminal 可见；capabilities API owner 鉴权。
- API GET /v1/capabilities 返回用户 Manifest（api 集成验证）。

### 判定
- Registry 参与执行决策：**Complete**（非仅注册表摆设，Worker 真实过滤工具集）。

## 缺口
- Companion 能力健康检查为基线 available（无真实探测）；llm.chat 健康未由最近成功调用推断 → Partial。
- dev runtime 与 cloud 区分：TOOL_SPECS runtime 含 dev，但 Manifest 默认 cloud；dev 专用路径未单独验证。