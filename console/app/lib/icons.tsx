// Minimal inline-SVG icon set (no external deps — CSP/offline safe).
// 16px stroke icons in the Lucide style, currentColor.
import type { CSSProperties } from "react";

const S = ({ children, style }: { children: React.ReactNode; style?: CSSProperties }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, ...style }}>{children}</svg>
);

export const Icon = {
  dashboard: () => <S><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></S>,
  file: () => <S><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></S>,
  skill: () => <S><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21 8 14 2 9.4h7.6z" /></S>,
  agent: () => <S><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M9 4h6M8 14h.01M16 14h.01" /></S>,
  session: () => <S><path d="M4 5h16M4 12h16M4 19h10" /></S>,
  env: () => <S><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></S>,
  vault: () => <S><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></S>,
  memory: () => <S><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16M4 9h5M4 14h5" /></S>,
  wiki: () => <S><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v15H6.5A2.5 2.5 0 0 0 4 19.5z" /><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20v5H6.5A2.5 2.5 0 0 1 4 19.5z" /><path d="M8 7h8M8 11h5" /></S>,
  catalog: () => <S><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></S>,
  deploy: () => <S><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.9.7-2.2-.1-3a2.1 2.1 0 0 0-2.9 0z" /><path d="M12 15l-3-3a22 22 0 0 1 8-10c1.5 1.5 2 5 2 5a22 22 0 0 1-7 8z" /><path d="M9 12H4s.5-3 2-4h5M12 15v5s3-.5 4-2v-5" /></S>,
  routing: () => <S><path d="M3 12h5" /><path d="M8 12l6-6h7" /><path d="M8 12l6 6h7" /></S>,
  pool: () => <S><rect x="2" y="4" width="20" height="7" rx="1.5" /><rect x="2" y="13" width="20" height="7" rx="1.5" /><path d="M6 7.5h.01M6 16.5h.01" /></S>,
  cache: () => <S><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" /></S>,
  wrench: () => <S><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></S>,
  key: () => <S><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 20 3M17 6l2 2M15 8l2 2" /></S>,
  workspace: () => <S><rect x="2" y="7" width="20" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M2 13h20" /></S>,
  usage: () => <S><path d="M3 3v18h18" /><path d="M7 15l3-4 3 2 4-6" /></S>,
  coin: () => <S><circle cx="12" cy="12" r="10" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /><path d="M12 18V6" /></S>,
  gauge: () => <S><path d="M12 14l4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></S>,
  theme: () => <S><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></S>,
  settings: () => <S><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></S>,
  plus: () => <S><path d="M12 5v14M5 12h14" /></S>,
  edit: () => <S><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></S>,
  clip: () => <S><path d="M21.2 11.2l-8.4 8.4a5.6 5.6 0 0 1-7.9-7.9l8.4-8.4a3.7 3.7 0 0 1 5.3 5.3l-8.5 8.4a1.9 1.9 0 0 1-2.6-2.6l7.8-7.8" /></S>,
  sync: () => <S><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></S>,
  download: () => <S><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></S>,
  upload: () => <S><path d="M12 15V3M7 8l5-5 5 5M5 21h14" /></S>,
  trash: () => <S><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></S>,
  refresh: () => <S><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" /></S>,
  pause: () => <S><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></S>,
  play: () => <S><path d="M6 4l14 8-14 8z" /></S>,
};

export type IconName = keyof typeof Icon;
