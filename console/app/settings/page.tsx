import { wsGet } from "../lib/api";
import type { CostSettings } from "../lib/currency";
import { SettingsForm, type MaintenanceSettings, type MaintenanceSummary } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await wsGet<{
    costs: CostSettings; limits: { maxWorkGb: number }; maintenance: MaintenanceSettings;
    appearance: { theme: string }; maintenanceLastRun: MaintenanceSummary | null;
  }>("/v1/settings").catch(() => null);
  return (
    <>
      <div className="pagehead"><h1>Settings</h1></div>
      <p className="sub">Platform-wide settings. Cost tracking and billing apply across all workspaces.</p>
      {s ? <SettingsForm initial={s.costs} initialLimits={s.limits} initialMaintenance={s.maintenance}
                         initialAppearance={s.appearance} lastRun={s.maintenanceLastRun} />
         : <div className="empty">Control plane unreachable.</div>}
    </>
  );
}
