// New (the one box for everything): the rail section above Approvals on every page, the palette command,
// and the N shortcut that puts the cursor in it from anywhere.
import { useEffect } from "react";
import type { Contribution } from "../../lib/registry";
import { openComposer } from "../../components/compose/ghost";
import { NewBox } from "./NewBox";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/** N anywhere (outside a text field) focuses New, opening the rail when it is closed. */
function NewShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey || e.repeat || typing(e.target)) return;
      if (document.querySelector("[aria-modal='true'], .palette")) return;
      e.preventDefault();
      openComposer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

export default function contribute(): Contribution {
  return {
    global: [NewShortcut],
    rail: [{ id: "new", order: 5, component: NewBox }],
    commands: () => [
      { id: "new", title: "New", hint: "Ask Firstmate, jot a note or list, move or group things", group: "Crew", keywords: "new task idea request firstmate ask compose note list checklist move group rename merge hide", run: () => openComposer() },
    ],
  };
}
