// CI preflight for the product's sandboxed document renderer. No --no-sandbox.
// Chromium guidance, checked 2026-11-15:
// https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

async function check() {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 15000 });
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
