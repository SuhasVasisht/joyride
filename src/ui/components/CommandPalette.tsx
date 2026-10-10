import { useEffect, useMemo, useRef, useState } from "react";
import { allCommands, type CommandDef } from "../lib/registry";

function score(c: CommandDef, q: string) {
  if (!q) return 1;
  const hay = `${c.title} ${c.keywords ?? ""} ${c.group ?? ""}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) { const i = hay.indexOf(w); if (i < 0) return 0; s += i === 0 ? 3 : 1; }
  return s;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [cmds, setCmds] = useState<CommandDef[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { allCommands().then(setCmds); input.current?.focus(); }, []);
  const list = useMemo(() => cmds.map((c) => [c, score(c, q)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([c]) => c), [cmds, q]);
  useEffect(() => setSel(0), [q]);
  const run = async (c?: CommandDef) => { if (!c) return; onClose(); await c.run(); };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette sheet" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="palette-input" placeholder="Jump to an idea, session or view — or type a command" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, list.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); run(list[sel]); }
          }} />
        <ul className="palette-list" role="listbox">
          {list.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === sel} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span>{c.title}</span>
              {c.hint ? <span className="meta">{c.hint}</span> : null}
            </li>
          ))}
          {!list.length && <li className="muted">No matches. Try an idea name, a repo, or “agents”.</li>}
        </ul>
      </div>
    </div>
  );
}
