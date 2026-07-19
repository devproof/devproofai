"use client";
// Blueprint-styled markdown (spec 2026-07-09 sessions rework, item 4).
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Lightbox } from "./lightbox";

export interface MdImage { name: string; url: string; }

/** Agents rarely write ![](…) — they mention output files by name (backticks,
 *  headings). Insert each known image below the first line that mentions it,
 *  so charts render where they are described. */
function embedImages(text: string, images: MdImage[]): string {
  const lines = text.split("\n");
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.includes("![")) continue;   // author-embedded — don't duplicate
    for (const img of images) if (line.includes(img.name)) seen.add(img.name);
  }
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line.includes("![")) continue;
    for (const img of images) {
      if (seen.has(img.name) || !line.includes(img.name)) continue;
      seen.add(img.name);
      out.push("", `![${img.name}](${img.url})`, "");
    }
  }
  return out.join("\n");
}

/** onNavigate: when supplied, non-external links are intercepted and their href
 *  passed here instead of navigating the browser (the wiki loads the target page
 *  in-pane). Omitting it keeps default anchor behaviour (session messages). */
export function Markdown({ text, images, onNavigate }:
  { text: string; images?: MdImage[]; onNavigate?: (href: string) => void }) {
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  const prepared = useMemo(
    () => (images?.length ? embedImages(text, images) : text),
    [text, images]);

  // ![](dremio_timeline.png) or ![](/mnt/session/outputs/…) → file-content URL.
  const resolve = (src: string): string | null => {
    const byName = images?.find((i) => i.name === src.split("/").pop());
    if (byName) return byName.url;
    return /^(https?:|data:|\/api\/)/.test(src) ? src : null;
  };

  const components: Record<string, any> = {
    img: ({ src, alt }: any) => {
      const url = resolve(String(src ?? ""));
      if (!url) return <span className="muted">[image: {String(src)}]</span>;
      const label = alt || String(src).split("/").pop() || "image";
      return <img className="md-img" src={url} alt={label}
                  onClick={() => setZoom({ src: url, alt: label })} />;
    },
  };
  if (onNavigate) {
    components.a = ({ href, children }: any) => {
      const h = String(href ?? "");
      if (/^(https?:|mailto:|data:)/i.test(h)) {
        return <a href={h} target="_blank" rel="noopener noreferrer">{children}</a>;
      }
      return <a href={h} onClick={(e) => { e.preventDefault(); onNavigate(h); }}>{children}</a>;
    };
  }

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{prepared}</ReactMarkdown>
      {zoom && <Lightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </div>
  );
}
