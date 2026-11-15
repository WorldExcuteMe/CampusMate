// One definition of failure for both the execution loop and invocation records.
export function toolResultFailed(out: string): boolean {
  try {
    const value = JSON.parse(out);
    if (value?.__approval_pending__ || value?.__budget_pending__) return false;
    return Boolean(value && typeof value === "object" &&
      (value.ok === false || value.success === false || value.error));
  } catch { return false; } // Plain-text tool output is allowed by the current contract.
}
