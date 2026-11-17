// 评测系统公共入口：供 CLI、测试与未来 Dashboard/CI 复用。
export * from "./types.ts";
export {
  EVAL_DIRS, DEFAULT_RUNS_ROOT, listSuites, listSuiteFiles, loadSuite, loadSuites, parseSuite,
  suiteHash, caseHash, suiteStats, saveSuite, stableStringify, sha256,
} from "./dataset.ts";
export { runEvaluation, computeMetrics, appliesToTarget, skippedResult } from "./runner.ts";
export { evaluateChecks, implicitRuntimeChecks, classifyFailure, checkId, checkLabel } from "./checks.ts";
export { evaluateCase, type EvaluateCaseResult } from "./evaluator.ts";
export { createTraceCollector, traceDigest, traceToolSequence, deriveSteps } from "./trace.ts";
export { analyzeRun, renderAnalysis, calibrationSample, type FailureAnalysis, type FailureCluster } from "./analysis.ts";
export { createManifest, compareRuns, evaluateGate, gitInfo, type ManifestInput } from "./experiment.ts";
export { saveRun, loadRun, listRuns, runsRoot, runPaths, createRunId, resolveRunDir, type RunPaths } from "./store.ts";
export { compactSummary, renderConsoleSummary, renderMarkdown, renderCaseLine } from "./reporter.ts";
export { ScriptedTarget } from "./targets/scripted.ts";
export { ApiTarget } from "./targets/api.ts";
export { runLegacyBenchmark } from "./legacy.ts";
export { LlmJudge, buildJudgePrompt, type LlmJudgeOptions } from "./judge.ts";
export {
  compareBehavior, fingerprintFromHuman, fingerprintFromEval, loadEvalFingerprint, normalizeHumanEvidence,
  renderParity, DEFAULT_PARITY_THRESHOLDS,
  type BehaviorFingerprint, type HumanEvidence, type ParityMetrics, type ParityResult, type ParityThresholds,
} from "./parity.ts";
export { expandBlueprint, writeGeneratedSuite, validateBlueprint, type Blueprint } from "./generator.ts";
