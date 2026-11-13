# 08 · Evaluator 审查

## 重点检查 5：Evaluator 是否独立于执行 Agent

**结论：Complete。独立模块、独立证据核验、执行 Agent 不得自判成功。**

### 独立性
- `core/evaluator.ts Evaluator` 是独立类，不复用 Executor 的自我声明；输入为 AcceptanceCriterion + EvaluationInput（证据/产物/字段），输出 CompletionCertificate。
- Worker.defaultEvaluate 调用 Evaluator.evaluate；`canMarkSucceeded(certificate.passed)` 才 succeeded（state-machine.ts）。执行 Agent 的 reply 不直接决定成功。
- failed 路径也存证书（worker.ts），供审计拒绝理由。

### 证据核验（防幻觉）
- `verifyEvidence`：独立重抓 sourceUrl（safeFetch）+ excerpt 规范化子串比对；重抓失败/不符→verified=false。
- `evidence_verified` 验收：核验通过数 ≥ min 才 passed。
- 幻觉证据率 0：evaluator.test.ts"幻觉证据（excerpt 与正文不符）→拒绝"、"重抓失败 404→不核验"通过。

### VERIFIED 门控
- `verification.ts sanitizeProposedStatus`：模型自填 VERIFIED→UNVERIFIED。
- `canPersistVerified`：evaluated_by=evaluator + evidence_count≥1 + 全部 verified。
- DB 触发器 enforce_verified_gate（0002）：PGlite 验证无证据 VERIFIED 拒绝。

### 证据
- evaluator.test.ts(9)：缺证据拒绝/幻觉拒绝/重抓失败/一致通过/多验收/自填降级/门控/冲突检测。
- worker-evaluator.test.ts(4)：声称 VERIFIED 但幻觉→failed；证据一致→succeeded；无证据→failed；propose 降级+入库。
- validate-migration.ts：VERIFIED 触发器门控。

## 缺口
- 默认 acceptance 为空（Worker defaultAcceptance 返回 []）：无显式验收条件时退化为"模型可达"基线。业务级验收条件需调用方注入 → 审计注意：当前冒烟/默认任务未强制证据验收，仅 propose_verification 路径触发证据核验。
- Evaluator 重抓成本/时延未做基准测量（Not Verified 性能）。