# 失败回放集（Failure Replay）

放入 `*.json` 的 `EvalSuite`（`schemaVersion: 1`），用于把线上/真实回归中确认根因的失败固化成回归用例。

约定：

1. 只在**确认根因**后沉淀；偶发环境问题（网络波动、上游 429）不要固化，避免污染回归。
2. 优先把用例补进固定集（`../datasets/baseline.json` 等）；本目录适合临时/实验性回放。
3. 用例 `source` 使用 `"failure_replay"`，并尽量在 `tags` 中写根因（如 `timezone`, `duplicate_save`, `single_double_week`）。
4. 运行：`node scripts/eval.ts run --suite <文件名前缀> --target <scripted|api-memory|live>`。
5. AI/工作 Agent 生成后必须 `node scripts/eval.ts validate --suite <id>`。

当前包含 `inbox-date-correction.json`（suite id: `replay-inbox-date-correction`）：明确更正已有通知的截止日期时，旧 save 工具调用也必须保留同一 itemId、原文和单条记录；覆盖跨日期及重复更正。它使用 api-memory 验证业务兼容契约，不替代真实模型的 CONV-006。
