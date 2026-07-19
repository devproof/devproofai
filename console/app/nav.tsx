"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./lib/icons";
import { Mark } from "./lib/mark";
import { WorkspacePicker } from "./lib/ws-picker";

const GROUPS: { title: string | null; collapsible?: boolean; items: [string, string, IconName][] }[] = [
  { title: null, items: [["Dashboard", "/", "dashboard"], ["API keys", "/api-keys", "key"]] },
  {
    title: "Managed Agents",
    items: [
      ["Agents", "/agents", "agent"],
      ["Skills", "/skills", "skill"],
      ["Sessions", "/sessions", "session"],
      ["Environments", "/environments", "env"],
      ["Credential vaults", "/vaults", "vault"],
      ["Files", "/files", "file"],
      ["Memory stores", "/memory-stores", "memory"],
      ["LLM wikis", "/wikis", "wiki"],
    ],
  },
  { title: "Serving", items: [["Model catalog", "/catalog", "catalog"], ["Deployments", "/deployments", "deploy"], ["Routings", "/routings", "routing"], ["Pools", "/pools", "pool"], ["Cache", "/cache", "cache"]] },
  { title: "Manage", collapsible: true, items: [["Usage - API", "/usage/api", "usage"], ["Usage - Sessions", "/usage/sessions", "usage"], ["Settings", "/settings", "settings"], ["Workspaces", "/workspaces", "workspace"]] },
];

export function Nav({ workspaces, current, version, localServing }: { workspaces: { id: string; name: string; status: string }[]; current: string; version: { cp: string; console: string }; localServing: boolean }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  // Collapsible groups: closed by default, forced open while a child route is
  // active (the active item must never be hidden). Plain state — survives
  // client-side navigation (Nav stays mounted), resets on hard reload.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // Lite install (serving.localEnabled=false): the Serving group keeps only
  // the surfaces that work without local serving.
  const groups = localServing ? GROUPS : GROUPS.map((g) =>
    g.title === "Serving"
      ? { ...g, items: g.items.filter(([, href]) => href === "/deployments" || href === "/routings") }
      : g);

  return (
    <nav className="sidebar">
      <Link href="/" className="brand">
        <Mark className="brand-mark" />
        <span className="brand-text">DEVPROOF<span className="ai">.AI</span><span className="cp">OWN YOUR SCALABLE AI</span></span>
      </Link>
      <div className="ws">
        <label>Workspace</label>
        <WorkspacePicker workspaces={workspaces} current={current} />
      </div>
      {groups.map((g, i) => {
        const expanded = !g.collapsible || !!openGroups[g.title!] || g.items.some(([, href]) => isActive(href));
        return (
          <div key={i}>
            {g.title && (g.collapsible ? (
              <button
                type="button"
                className="group group-toggle"
                aria-expanded={expanded}
                onClick={() => setOpenGroups((s) => ({ ...s, [g.title!]: !expanded }))}
              >
                {g.title}
                <span className={`group-chevron ${expanded ? "open" : ""}`} aria-hidden>▸</span>
              </button>
            ) : (
              <div className="group">{g.title}</div>
            ))}
            {expanded && g.items.map(([label, href, icon]) => {
              const I = Icon[icon];
              return (
                <Link key={href} href={href} className={`item ${isActive(href) ? "active" : ""}`}>
                  <I /><span>{label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
      <div className="nav-version" title={`control plane ${version.cp} · console ${version.console}`}>
        {version.cp}{version.console !== version.cp ? ` · ui ${version.console}` : ""}
      </div>
    </nav>
  );
}
