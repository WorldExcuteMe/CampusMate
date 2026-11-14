import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { repository } from "@/app/config";
import { useAuth } from "@/app/auth";
import { backendEnabled, listSchedules, listTerms } from "@/lib/agent/api-client";
import { localParts, type ScheduleKnowledge } from "../../../../shared/calendar";

export function useCampusCalendar() {
  const owner = useAuth().session?.user.id ?? "demo";
  const [termId, setTermId] = useState<string>();
  const terms = useQuery({ queryKey: ["terms", owner], queryFn: listTerms, enabled: backendEnabled() });
  const ordered = [...(terms.data ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const term = ordered.find((t) => t.id === termId) ?? ordered.find((t) => { const today = localParts(Date.now(), t.timezone).date; return today >= t.startDate && today <= t.endDate; }) ?? ordered[0];
  const schedules = useQuery({ queryKey: ["schedules", owner, term?.id], queryFn: () => listSchedules(term!.id), enabled: Boolean(term) });
  const tasks = useQuery({ queryKey: ["tasks", owner], queryFn: () => repository.listTasks() });
  const opps = useQuery({ queryKey: ["opps", owner], queryFn: () => repository.listOpportunities() });
  const knowledge: ScheduleKnowledge = !backendEnabled() ? "unknown" : terms.isError || schedules.isError ? "error" : terms.isLoading || (Boolean(term) && schedules.isLoading) ? "loading" : !term ? "unknown" : schedules.data?.schedules.length ? "ready" : "empty";
  const timezone = term?.timezone ?? "Asia/Shanghai";
  return { terms, term, setTermId, schedules, tasks, opps, knowledge, timezone, today: localParts(Date.now(), timezone).date };
}
