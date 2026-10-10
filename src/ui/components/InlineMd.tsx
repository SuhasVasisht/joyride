// Minimal, safe inline markdown for agent text: `code` and **bold** only.
// Produces React nodes (never HTML strings), so transcript content can't inject markup.
import { Fragment } from "react";

const TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

export function InlineMd({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        if (p.startsWith("`")) return <code key={i} className="md-code">{p.slice(1, -1)}</code>;
        return <strong key={i}>{p.slice(2, -2)}</strong>;
      })}
    </>
  );
}
