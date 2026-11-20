import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRepository } from "@/app/auth";
import { useAuth } from "@/app/auth";
import { backendEnabled, listSchedules, listTerms } from "@/lib/agent/api-client";
import { runtime } from "@/app/config";
import { localParts, type ScheduleKnowledge } from "../../../../shared/calendar";
import { useBeijingDay } from "@/lib/use-beijing-day";

export function useCampusCalendar() {
  const repository = useRepository();
  const defaultToday = useBeijingDay();
  const owner = useAuth().session?.user.id ?? "demo";
  // 云端匿名 Demo 不请求需要登录的 /v1 接口，避免把 401 误当作“课表读取失败”。
  const live = backendEnabled() && (runtime !== "cloud" || Boolean(useAuth().session));
  const [termId, setTermId] = useState<string>();
  const terms = useQuery({ queryKey: ["terms", owner], queryFn: listTerms, enabled: live });
  const ordered = [...(terms.data ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const term = ordered.find((t) => t.id === termId) ?? ordered.find((t) => { const today = localParts(Date.now(), t.timezone).date; return today >= t.startDate && today <= t.endDate; }) ?? ordered[0];
  const schedules = useQuery({ queryKey: ["schedules", owner, term?.id], queryFn: () => listSchedules(term!.id), enabled: live && Boolean(term) });
  const tasks = useQuery({ queryKey: ["tasks", owner], queryFn: () => repository.listTasks() });
  const opps = useQuery({ queryKey: ["opps", owner], queryFn: () => repository.listOpportunities() });
  const knowledge: ScheduleKnowledge = !live ? "unknown" : terms.isError || schedules.isError ? "error" : terms.isLoading || (Boolean(term) && schedules.isLoading) ? "loading" : !term ? "unknown" : schedules.data?.schedules.length ? "ready" : "empty";
  const timezone = term?.timezone ?? "Asia/Shanghai";
  return { terms, term, setTermId, schedules, tasks, opps, knowledge, timezone, today: term ? localParts(Date.now(), timezone).date : defaultToday };
}
