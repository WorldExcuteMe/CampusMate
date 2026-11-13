import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./layout";
import { LandingPage } from "@/features/landing/LandingPage";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { InboxPage } from "@/features/inbox/InboxPage";
import { NewInboxPage } from "@/features/inbox/NewInboxPage";
import { InboxDetailPage } from "@/features/inbox/InboxDetailPage";
import { RadarPage } from "@/features/radar/RadarPage";
import { OpportunityDetailPage } from "@/features/radar/OpportunityDetailPage";
import { TrustPage } from "@/features/trust/TrustPage";
import { TrustReportPage } from "@/features/trust/TrustReportPage";
import { GrowthPage } from "@/features/growth/GrowthPage";
import { ProfilePage } from "@/features/profile/ProfilePage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { AgentChatPage } from "@/features/agent/AgentChatPage";
import { DailyTasksPage } from "@/features/daily/DailyTasksPage";
import { LoginPage } from "./auth";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/app" element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="agent" element={<AgentChatPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="inbox/new" element={<NewInboxPage />} />
        <Route path="inbox/:id" element={<InboxDetailPage />} />
        <Route path="daily" element={<DailyTasksPage />} />
        <Route path="radar" element={<RadarPage />} />
        <Route path="radar/:id" element={<OpportunityDetailPage />} />
        <Route path="trust" element={<TrustPage />} />
        <Route path="trust/:id" element={<TrustReportPage />} />
        <Route path="growth" element={<GrowthPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}