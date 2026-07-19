import Link from "next/link";
import { wsGet } from "./lib/api";
import { CreateApiKey } from "./api-keys/create";
import { Icon } from "./lib/icons";
import { DashboardUsage } from "./dashboard-usage";

export const dynamic = "force-dynamic";

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export default async function Dashboard() {
  const [deployments, sessions, catalog, settings] = await Promise.all([
    wsGet<{ deployments: any[] }>("/v1/deployments").catch(() => ({ deployments: [] })),
    wsGet<{ sessions: any[] }>("/v1/sessions").catch(() => ({ sessions: [] })),
    wsGet<{ models: any[] }>("/v1/catalog").catch(() => ({ models: [] })),
    wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null),
  ]);
  const localServing = settings?.serving?.localEnabled !== false;
  const ready = deployments.deployments.filter((d: any) => d.phase === "Ready");
  const tokens = sessions.sessions.reduce((a: number, s: any) => a + Number(s.tokens_in) + Number(s.tokens_out), 0);
  const failed = sessions.sessions.filter((s: any) => s.status === "failed").length;
  const hour = new Date().getHours();
  const stat = (href: string, label: string, big: string, hint: string) => (
    <Link className="card" href={href}>
      <h3>{label}<span className="arrow">→</span></h3>
      <div className="big">{big}</div><div className="hint">{hint}</div>
    </Link>
  );
  return (
    <>
      <div className="pagehead">
        <h1>Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}</h1>
        <div style={{ display: "flex", gap: 10 }}>
          <CreateApiKey label="Generate an API key" ghost icon />
          <Link className="btn" href="/agents"><Icon.agent /> Build an agent</Link>
        </div>
      </div>
      <p className="sub">Your AI platform at a glance.</p>
      <div className="cards">
        {stat("/deployments", "Models serving", String(ready.length), `${deployments.deployments.length} deployment(s)`)}
        {stat("/sessions", "Agent sessions", String(sessions.sessions.length), `${failed} failed`)}
        {stat("/usage/sessions", "Session tokens", fmt(tokens), "in + out, all sessions")}
        {localServing && stat("/catalog", "Catalog", String(catalog.models?.length ?? 0), "curated models")}
      </div>
      <DashboardUsage deployments={deployments.deployments.map((d: any) => d.name)} />
    </>
  );
}
