// DEVPROOF.AI proofmark — checkmark + Q.E.D. tombstone inside a tessellating
// hexagon. Uses brand CSS tokens so it adapts to light/dark.
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <polygon points="30,9 70,9 91,50 70,91 30,91 9,50"
        fill="none" stroke="var(--blue)" strokeWidth="4" strokeLinejoin="round" />
      <polygon points="38,25 62,25 75,50 62,75 38,75 25,50"
        fill="none" stroke="var(--blue)" strokeWidth="1.6" strokeLinejoin="round" opacity=".3" />
      <path d="M35,51 L46,63 L67,37"
        fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="64.5" y="33.5" width="6.5" height="6.5" rx="1.2" fill="var(--accent)" />
      <rect x="43" y="71.5" width="14" height="2.6" rx="1.3" fill="var(--blue)" opacity=".6" />
    </svg>
  );
}
