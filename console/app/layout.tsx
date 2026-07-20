import "./globals.css";
import type { ReactNode } from "react";
import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed, IBM_Plex_Mono } from "next/font/google";
import { Nav } from "./nav";
import { wsGet, currentWorkspace } from "./lib/api";

// Self-hosted at build time — no runtime CDN (fits the sovereignty ethos).
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--f-sans", display: "swap" });
const cond = IBM_Plex_Sans_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--f-cond", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--f-mono", display: "swap" });

export const metadata = { title: "DEVPROOF.AI — Control Plane" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Both reads are independent and degrade separately, so they run in parallel:
  // workspaces falls back to the default list, theme falls back to "system"
  // (= the OS decides, i.e. the pre-2026-07-15 behaviour) when the control
  // plane is down. Server-rendered ⇒ no flash, no inline blocking script.
  const [wsRes, setRes, verRes] = await Promise.allSettled([
    wsGet<{ workspaces: any[] }>("/v1/workspaces"),
    wsGet<{ appearance?: { theme?: string; timeFormat?: string }; serving?: { localEnabled?: boolean } }>("/v1/settings"),
    wsGet<{ version: string }>("/v1/version"),
  ]);

  let workspaces = [{ id: "wrkspc_default", name: "Default workspace", status: "active" }];
  if (wsRes.status === "fulfilled" && wsRes.value?.workspaces?.length) workspaces = wsRes.value.workspaces;

  const theme = (setRes.status === "fulfilled" && setRes.value?.appearance?.theme) || "system";
  const timefmt = (setRes.status === "fulfilled" && setRes.value?.appearance?.timeFormat) || "browser";
  const localServing = setRes.status === "fulfilled" ? setRes.value?.serving?.localEnabled !== false : true;

  // Version footer (reproducible-builds spec 2026-07-18): CP version from the
  // API, console's own from the image env — both "dev" out-of-cluster.
  const version = {
    cp: (verRes.status === "fulfilled" && verRes.value?.version) || "dev",
    console: process.env.DEVPROOF_VERSION || "dev",
  };

  const cookie = await currentWorkspace();
  // Cookie may point at a deleting/deleted workspace — fall back to default.
  const current = workspaces.some((w) => w.id === cookie && w.status !== "deleting") ? cookie : "wrkspc_default";
  return (
    <html lang="en" data-theme={theme} data-timefmt={timefmt} className={`${sans.variable} ${cond.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <Nav workspaces={workspaces} current={current} version={version} localServing={localServing} />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
