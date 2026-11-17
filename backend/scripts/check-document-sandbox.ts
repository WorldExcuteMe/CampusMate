// CI preflight for the product's sandboxed document renderer. No --no-sandbox.
// Chromium guidance, checked 2026-11-15:
// https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { availableDocumentFormats, DOCUMENT_CHROMIUM_OPTIONS, inspectExport, renderDocument } from "../src/core/document-renderer.ts";
import type { DocumentAst } from "../../shared/document.ts";

async function check() {
  const browser = await chromium.launch(DOCUMENT_CHROMIUM_OPTIONS);
  await browser.close();
}

try {
  await check();
  console.log("[document-sandbox] Sandboxed Chromium ready.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Preserve the failing probe in CI evidence, before changing one setting.
  console.error("[document-sandbox] Initial sandbox launch failed:", message);
  const restriction = await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").catch(() => "");
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" || restriction.trim() !== "1"
    || !/No usable sandbox|Failed to move to new namespace|Operation not permitted/i.test(message)) throw error;

  // Disposable GitHub-hosted runner only. Scope the exception to Playwright's
  // browser binaries; retain global userns restrictions and Chromium's sandbox.
  const executable = await realpath(chromium.executablePath());
  const cache = path.dirname(path.dirname(path.dirname(executable)));
  if (!path.isAbsolute(cache) || cache === "/" || /["\n\r{}*]/.test(cache)) throw new Error("Unexpected browser cache path");
  const profile = "/etc/apparmor.d/campusmate-ci-chromium";
  const content = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile campusmate-ci-chromium "${cache}/**/{chrome,chrome-headless-shell,headless_shell}" flags=(unconfined) {\n  userns,\n}\n`;
  for (const [args, input] of [
    [["tee", profile], content],
    [["apparmor_parser", "-r", profile], undefined],
  ] as const) {
    const result = spawnSync("sudo", [...args], { input, encoding: "utf8", timeout: 15000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Cannot configure CI browser profile: ${result.error?.message ?? result.stderr}`);
  }
  await check();
  console.log("[document-sandbox] Sandboxed Chromium ready with a runner-local browser profile.");
}

// Probe the real renderer, not just the executable's presence: catches missing fonts,
// chart screenshots, PDF generation and text extraction without model/DB requests.
assert.ok(availableDocumentFormats().includes("pdf"), "缺少固定Chromium或中文字体；请先运行 npm run documents:setup");
const smoke: DocumentAst = {
  schemaVersion: 1, kind: "document", title: "文档导出环境自检", sources: [],
  blocks: [
    { type: "paragraph", text: "中文字体、表格和图表必须真实导出。仅为本机测试，不包含用户数据。" },
    { type: "table", headers: ["检查项目", "要求"], rows: [["中文", "可复读"], ["图表", "真实图片"]] },
    { type: "chart", title: "导出环境检查", labels: ["中文", "图表"], values: [2, 3] },
  ],
};
for (const format of ["docx", "pdf"] as const) {
  const bytes = await renderDocument(smoke, format), result = await inspectExport(smoke, bytes, format);
  assert.equal(result.passed, true, JSON.stringify(result));
  console.log(`[document-runtime] ${format.toUpperCase()} exported and read back: ${bytes.length} bytes${result.pages ? `, ${result.pages} pages` : ""}.`);
}
