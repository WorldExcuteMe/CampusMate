import { z } from "zod";

export const noticeCategory = z.enum([
  "competition",
  "internship",
  "research",
  "scholarship",
  "activity",
  "opensource",
  "notice",
]);
export type NoticeCategory = z.infer<typeof noticeCategory>;

export const noticeClass = z.enum([
  "must_act",
  "high_value",
  "worth_watching",
  "normal",
  "risk",
]);
export type NoticeClass = z.infer<typeof noticeClass>;

export const extractedNoticeSchema = z.object({
  title: z.string().min(1),
  category: noticeCategory,
  org: z.string().default(""),
  summary: z.string().default(""),
  deadline: z.string().nullable().default(null),
  conditions: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  cost: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
  evidenceExcerpt: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type ExtractedNotice = z.infer<typeof extractedNoticeSchema>;

export const classificationSchema = z.object({
  class: noticeClass,
  priorityScore: z.number().min(0).max(100),
  priorityReason: z.string(),
  riskSignals: z.array(z.string()).default([]),
});
export type Classification = z.infer<typeof classificationSchema>;

export const extractInputSchema = z.object({
  rawText: z.string().min(1),
  sourceUrl: z.string().nullable().default(null),
  sourceType: z.enum(["text", "image", "pdf", "docx", "url"]).default("text"),
});
export type ExtractInput = z.infer<typeof extractInputSchema>;

export const inboxStatus = z.enum([
  "pending_review",
  "confirmed",
  "ignored",
  "archived",
  "failed",
]);
export type InboxStatus = z.infer<typeof inboxStatus>;

export const taskStatus = z.enum(["todo", "in_progress", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof taskStatus>;

export const matchWeightsSchema = z.object({
  interest: z.number().default(25),
  skill: z.number().default(25),
  goal: z.number().default(20),
  time: z.number().default(15),
  experience: z.number().default(15),
});
export type MatchWeights = z.infer<typeof matchWeightsSchema>;

export const verificationStatus = z.enum([
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "UNVERIFIED",
  "CONFLICTING",
  "RISK_FLAGGED",
]);
export type VerificationStatus = z.infer<typeof verificationStatus>;

export const evidenceSchema = z.object({
  sourceUrl: z.string(),
  sourceType: z.string(),
  excerpt: z.string(),
  retrievedAt: z.string(),
  supports: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Evidence = z.infer<typeof evidenceSchema>;