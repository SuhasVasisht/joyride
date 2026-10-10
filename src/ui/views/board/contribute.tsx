// The Board: every note, list and link on the map, tracked off the canvas (#/board).
import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { useAllNotes } from "../../components/notes/notes";
import { hasOpenTodo } from "./model";
import { BoardPage } from "./BoardPage";

/** Items with todos still open, on the nav link. */
function BoardBadge() {
  const { data } = useAllNotes();
  const n = (data ?? []).filter(hasOpenTodo).length;
  return n ? <span className="nav-badge quiet" aria-label={`${n} with open todos`} title={`${n} ${n === 1 ? "item has" : "items have"} todos still open`}>{n}</span> : null;
}

export default function contribute(): Contribution {
  return {
    routes: [{ name: "board", component: BoardPage }],
    nav: [{ id: "board", title: "Board", href: "#/board", order: 20, badge: BoardBadge }],
    commands: () => [
      { id: "go-board", title: "Go to board", group: "Navigate", keywords: "board notes lists todos checklists links pdf artifacts bookmarks", run: () => go("board") },
      { id: "board-open-todos", title: "Open todos on the board", group: "Board", keywords: "todos checklist unchecked open tasks lists", run: () => go("board?open=1") },
      { id: "board-links", title: "Links on the board", group: "Board", keywords: "links pdf artifacts urls bookmarks", run: () => go("board?type=link") },
    ],
  };
}
