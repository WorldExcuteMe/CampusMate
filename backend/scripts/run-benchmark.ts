// Benchmark CLI：运行 30 任务，输出指标报告。运行：node scripts/run-benchmark.ts
import { runAll, computeMetrics } from "../tests/agent-benchmark/runner.ts";

const results = await runAll();
const m = computeMetrics(results);
console.log("=== CampusMate Agent Benchmark ===");
console.log(`总任务: ${m.total} | VERIFIED: ${m.verified} | FAILED: ${m.failed} | BLOCKED_EXTERNAL: ${m.blocked}`);
console.log(`End-to-End 成功率: ${(m.endToEndSuccessRate * 100).toFixed(1)}%`);
console.log(`证据覆盖: ${(m.evidenceCoverage * 100).toFixed(1)}% | 恢复成功: ${(m.recoverySuccessRate * 100).toFixed(1)}% | 环境泛化: ${(m.environmentGeneralizationRate * 100).toFixed(1)}%`);
console.log(`人工介入率: ${(m.humanInterventionRate * 100).toFixed(1)}% | 平均成本: $${m.avgCostUsd.toFixed(6)} | 平均时延: ${m.avgDurationMs.toFixed(0)}ms`);
console.log("--- 分类 ---");
for (const [k, v] of Object.entries(m.byCategory)) console.log(`  ${k}: ${v.passed}/${v.total} (${(v.rate * 100).toFixed(0)}%)`);
const failed = results.filter((r) => r.status === "FAILED");
if (failed.length) { console.log("--- 失败 ---"); for (const f of failed) console.log(`  ${f.id}: ${f.failureReason}`); }
console.log(m.failed === 0 ? "BENCHMARK_PASS" : "BENCHMARK_FAIL");
process.exit(m.failed === 0 ? 0 : 1);