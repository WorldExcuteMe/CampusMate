import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseRepository } from "../data/supabase";
import type { VerificationReport } from "../data/types";
import { runChat } from "../agent/chat";
import { demoProfile } from "@/demo/seed";

afterEach(() => vi.unstubAllGlobals());

const report: VerificationReport = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", opportunityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "VERIFIED", summary: "fixture", findings: [], createdAt: "2026-11-14T00:00:00Z",
  evidence: [{ sourceUrl: "https://example.org/fixture", sourceType: "official", excerpt: "fixture excerpt", supports: "deadline", confidence: 0.9, retrievedAt: "2026-11-14T00:00:00Z" }],
};
const stored = () => ({
  id: report.id, opportunity_id: report.opportunityId, status: report.status, summary: report.summary,
  findings: [], created_at: "2026-11-14T00:01:00Z",
  evidence_items: report.evidence.map(e => ({ source_url: e.sourceUrl, source_type: e.sourceType, excerpt: e.excerpt, supports: e.supports, confidence: e.confidence, retrieved_at: e.retrievedAt })),
});
function fixture() {
  const rpc = vi.fn().mockResolvedValue({ data: stored(), error: null });
  const from = vi.fn((table: string) => ({ insert: vi.fn().mockResolvedValue({ error: table === "evidence_items" ? { message: "fixture evidence insert denied", code: "42501" } : null }) }));
  const repo = new SupabaseRepository({ rpc, from } as unknown as SupabaseClient, "fixture-owner");
  return { repo, rpc, from };
}

describe("atomic verification report persistence", () => {
  it("a failed report save stops the chat tool loop and never emits a saved action", async () => {
    const { repo, rpc } = fixture();
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "fixture evidence insert denied" } });
    const fetcher = vi.fn(async () => Response.json({ model: "fixture", choices: [{ message: { content: null, tool_calls: [{ id: "save-1", type: "function", function: { name: "verify_opportunity", arguments: JSON.stringify({ opportunityId: report.opportunityId, status: "VERIFIED", evidence: report.evidence }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    vi.stubGlobal("fetch", fetcher);
    const outcome = await runChat({ message: "核验这个机会", history: [], profile: demoProfile, repository: repo });
    expect(outcome.failed).toBe(true);
    expect(outcome.actions).toEqual([]);
    expect(outcome.reply).toContain("fixture evidence insert denied");
    expect(outcome.reply).not.toContain("模型连接失败");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("propagates evidence write failure instead of resolving a successful report", async () => {
    const { repo, rpc } = fixture();
    rpc.mockResolvedValue({ data: null, error: { message: "fixture evidence insert denied", code: "42501" } });
    await expect(repo.createReport(report)).rejects.toMatchObject({ code: "42501", message: "fixture evidence insert denied" });
  });
  it("uses one atomic RPC, preserves retrieval timestamps and returns persisted data", async () => {
    const { repo, rpc, from } = fixture();
    const saved = await repo.createReport(report);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("save_verification_report", { p_report: {
      id: report.id, opportunity_id: report.opportunityId, status: report.status, summary: report.summary, findings: [], evidence: stored().evidence_items,
    } });
    expect(from).not.toHaveBeenCalled();
    expect(saved.createdAt).toBe("2026-11-14T00:01:00Z");
    expect(saved.evidence).toEqual(report.evidence);
  });
  it.each([null, {}, { ...stored(), id: "wrong-id" }, { ...stored(), evidence_items: [] }])("does not report success for incomplete RPC result %j", async data => {
    const { repo, rpc } = fixture(); rpc.mockResolvedValue({ data, error: null });
    await expect(repo.createReport(report)).rejects.toThrow(/保存结果/);
  });
  it("does not fall back to non-atomic inserts when migration is missing", async () => {
    const { repo, rpc, from } = fixture();
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "function not found" } });
    await expect(repo.createReport(report)).rejects.toThrow(/迁移/);
    expect(from).not.toHaveBeenCalled();
  });
  it("can retry a failed save using the same report id and payload", async () => {
    const { repo, rpc } = fixture();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "fixture transaction failed" } });
    await expect(repo.createReport(report)).rejects.toMatchObject({ message: "fixture transaction failed" });
    await expect(repo.createReport(report)).resolves.toMatchObject({ id: report.id });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it("permits zero evidence without inventing evidence or replacing database time", async () => {
    const { repo, rpc } = fixture(); rpc.mockResolvedValue({ data: { ...stored(), status: "UNVERIFIED", evidence_items: [] }, error: null });
    expect((await repo.createReport({ ...report, evidence: [], status: "UNVERIFIED" })).evidence).toEqual([]);
  });
});
