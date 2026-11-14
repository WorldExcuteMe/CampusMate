// backendEnabled 时机会雷达读写走后端 Task Runtime 真相源（Agent save_opportunity 写入）；其余方法委托 base。
import type { Repository, Opportunity } from "./types";
import { backendEnabled, listBackendOpportunities, getBackendOpportunity, createBackendOpportunity } from "@/lib/agent/api-client";

export function withBackendOpportunities(base: Repository): Repository {
  if (!backendEnabled()) return base;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "listOpportunities") return () => listBackendOpportunities();
      if (prop === "getOpportunity") return (id: string) => getBackendOpportunity(id);
      if (prop === "createOpportunity") return (o: Opportunity) => createBackendOpportunity(o);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}