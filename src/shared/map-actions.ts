// Agent commands describe requests to the same routes the map uses.
import { z } from "zod";
import { LIST_TITLE, SCOPE_HELP, listItem, noteScope as scopeOf, parseListItem, parseNoteScope } from "./notes.ts";
import { linkLine, linkTarget } from "./board.ts";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use an idea or group id from map show.");
const text = z.string().trim().min(1).max(500);
const groupTitle = text.max(80);
const mapKey = z.string().regex(/^[A-Za-z0-9:._@-]{1,200}$/);
const task = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const session = z.string().regex(/^(claude|codex):[^\s]+$/, "Use a session key such as claude:<id>.");
const noteText = z.string().trim().min(1);
const noteScope = z.string().refine((value) => parseNoteScope(value) !== null, SCOPE_HELP);
const href = z.string().trim().refine((value) => linkTarget(value) !== null, "Use a web address (https://…), a PDF's address or path, artifact:<id>, or a Claude artifact link.");
/** Where a board item goes: --scope, or --group / --idea for short (one of them). Unfiled (global) when none. */
const place = { scope: noteScope.optional(), group: id.optional(), idea: id.optional() };
const placed = (a: { scope?: string; group?: string; idea?: string }, fallback = "global") => scopeOf({ scope: a.scope, group: a.group, idea: a.idea }, fallback);
const placeFlags = { scope: "scope", group: "group", idea: "idea" };
const items = z.array(noteText.refine((value) => parseListItem(`${value} `).text.trim().length > 0, "A checklist item needs text.")).min(1);
const checkbox = (value: string) => { const item = parseListItem(value); return listItem(item.text, item.done); };
const commit = z.string().regex(/^[0-9a-f]{7,40}$/, "Use the commit returned by the edit or map history.");
const group = z.union([id, z.literal("none")]);
/** A group as the map charts it (lens:<id>, repo:<path>, unfiled:<project>), or a bare group id from map show. */
const mapGroup = z.string().min(1).max(300).regex(/^[^\n\r]+$/, "Use a group id from map show, such as reporting or repo:/path/to/repo.");
const coord = z.coerce.number().finite().min(-1e6).max(1e6);
export const MapActor = z.object({
  kind: z.literal("agent"),
  id: z.string().regex(/^[A-Za-z0-9:._/-]{1,128}$/),
  via: z.enum(["cli", "mcp"]),
}).strict();
export type MapActor = z.infer<typeof MapActor>;
export type MapRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown };
type CliFields = { positional: string[]; flags: Record<string, string>; rest?: string };

function action<S extends z.ZodRawShape>(name: string, description: string, shape: S, cli: CliFields, request: (args: z.infer<z.ZodObject<S>>) => MapRequest) {
  const schema = z.object(shape).strict();
  return { name, description, schema, cli, availability: "ready" as const, prepare: (args: unknown) => request(schema.parse(args)) };
}
const move = (body: unknown): MapRequest => ({ method: "POST", path: "/api/missions/move", body });
const target = (value: string) => value === "none" ? null : value;
export const MAP_ACTIONS = [
  action("show", "Read the current groups and ideas, with authored task and session links, as JSON.", {}, { positional: [], flags: {} }, () => ({ method: "GET", path: "/api/missions/map" })),
  action("history", "Read map edits, agent attribution and Undo state as JSON.", {}, { positional: [], flags: {} }, () => ({ method: "GET", path: "/api/missions/move/history" })),
  action("move-idea", "Move an idea to a group. Use none to return to its repo group; from-group defaults to its current group.", { idea: id, to_group: group, from_group: group.optional() }, { positional: ["idea"], flags: { "to-group": "to_group", "from-group": "from_group" } }, (a) => move({ mission: a.idea, ...(a.from_group === undefined ? {} : { from: target(a.from_group) }), to: { lens: target(a.to_group) } })),
  action("move-task", "Move a Firstmate task to an idea. Tasks always belong to an idea.", { task, to_idea: id }, { positional: ["task"], flags: { "to-idea": "to_idea" } }, (a) => move({ task: a.task, to: { mission: a.to_idea } })),
  action("file-session", "File a session into an idea, or use none to leave it Unfiled.", { session, to_idea: z.union([id, z.literal("none")]) }, { positional: ["session"], flags: { "to-idea": "to_idea" } }, (a) => move({ session: a.session, to: { mission: target(a.to_idea) } })),
  action("move-session", "Move a session directly into a group, leaving its idea or previous group.", { session, to_group: id }, { positional: ["session"], flags: { "to-group": "to_group" } }, (a) => move({ session: a.session, to: { lens: a.to_group } })),
  action("new-group", "Create an empty group, or move an idea into the new group with --idea.", { title: groupTitle, idea: id.optional() }, { positional: ["title"], flags: { idea: "idea" } }, (a) => a.idea ? move({ mission: a.idea, to: { new_lens: a.title } }) : ({ method: "POST", path: "/api/lenses/create", body: { title: a.title } })),
  action("new-empty-group", "Create an empty group to file ideas or sessions into.", { title: groupTitle }, { positional: ["title"], flags: {} }, (a) => ({ method: "POST", path: "/api/lenses/create", body: { title: a.title } })),
  action("new-session-group", "Create a group by moving a session into it.", { title: groupTitle, session }, { positional: ["title"], flags: { session: "session" } }, (a) => move({ session: a.session, to: { new_lens: a.title } })),
  action("rename-group", "Rename an authored group, preserving its id and members.", { group: id, title: groupTitle }, { positional: ["group", "title"], flags: {} }, (a) => ({ method: "POST", path: "/api/lenses/rename", body: { lens: a.group, title: a.title } })),
  action("rename-repo-group", "Name a repo group, keeping its ideas in the new authored group. An empty repo means No repo.", { repo: z.string(), title: groupTitle }, { positional: ["repo", "title"], flags: {} }, (a) => ({ method: "POST", path: "/api/lenses/rename", body: { repo: a.repo, title: a.title } })),
  action("rename-unfiled-group", "Name an Unfiled project group, keeping its sessions and workers together. An empty project means no project.", { project: z.string(), title: groupTitle }, { positional: ["project", "title"], flags: {} }, (a) => ({ method: "POST", path: "/api/lenses/rename", body: { unfiled: a.project, title: a.title } })),
  action("delete-group", "Delete a group; its members fall back to their other groups or Unfiled. Undo restores it.", { group: id }, { positional: ["group"], flags: {} }, (a) => ({ method: "POST", path: "/api/lenses/delete", body: { lens: a.group } })),
  action("merge-group", "Merge a group and all its members into another group. Undo restores both groups.", { group: id, into: id }, { positional: ["group"], flags: { into: "into" } }, (a) => ({ method: "POST", path: "/api/lenses/merge", body: { lens: a.group, into: a.into } })),
  action("move-group", "Move a group on the canvas to x, y (near units: 1 unit is 1px at Near zoom; map show lists placed groups under layout), or back to its usual spot with --reset. Groups never overlap: one placed on another moves to the nearest free spot. Undo restores the previous arrangement.", { group: mapGroup, x: coord.optional(), y: coord.optional(), reset: z.boolean().optional() }, { positional: ["group"], flags: { x: "x", y: "y", reset: "reset" } }, (a) => {
    if (!a.reset && (a.x === undefined || a.y === undefined)) throw new Error("Give both --x and --y, or --reset.");
    return { method: "POST", path: "/api/missions/map/layout", body: a.reset ? { group: a.group, reset: true } : { group: a.group, x: a.x, y: a.y } };
  }),
  action("hidden", "Read the session and worker keys set aside on the map, with their timestamps.", {}, { positional: [], flags: {} }, () => ({ method: "GET", path: "/api/missions/hidden" })),
  action("hide", "Set a session or worker aside until it does something new. It remains on the Agents page.", { key: mapKey }, { positional: ["key"], flags: {} }, (a) => ({ method: "POST", path: "/api/missions/hide", body: { key: a.key } })),
  action("unhide", "Undo setting a session or worker aside, returning it to the map.", { key: mapKey }, { positional: ["key"], flags: {} }, (a) => ({ method: "POST", path: "/api/missions/unhide", body: { key: a.key } })),
  action("add-note", "Save anchored note bullets on a group, idea, task, session or globally. Newlines separate bullets.", { text: noteText, scope: noteScope.optional() }, { positional: ["text"], flags: { scope: "scope" } }, (a) => ({ method: "POST", path: "/api/notes", body: { text: a.text, scope: a.scope ?? "global" } })),
  action("edit-note", "Replace an anchored note's bullets, optionally moving its scope.", { note: id, text: noteText, scope: noteScope.optional() }, { positional: ["note", "text"], flags: { scope: "scope" } }, (a) => ({ method: "PUT", path: `/api/notes/${encodeURIComponent(a.note)}`, body: { text: a.text, ...(a.scope ? { scope: a.scope } : {}) } })),
  action("archive-note", "Archive an anchored note, keeping its history.", { note: id }, { positional: ["note"], flags: {} }, (a) => ({ method: "POST", path: `/api/notes/${encodeURIComponent(a.note)}/archive`, body: {} })),
  action("restore-note", "Restore an archived anchored note, as in the map's note drawer.", { note: id }, { positional: ["note"], flags: {} }, (a) => ({ method: "POST", path: `/api/notes/${encodeURIComponent(a.note)}/restore`, body: {} })),
  action("note", "Save a board item: a note card in Unfiled (on the hub), or --group <id> / --idea <id> / --scope to place it. Newlines separate lines; a line can be a checkbox ([ ] or [x]) or a link, for a mixed card.", { text: noteText, title: text.optional(), ...place }, { positional: ["text"], flags: { title: "title", ...placeFlags } }, (a) => ({ method: "POST", path: "/api/notes", body: { text: a.text, scope: placed(a), ...(a.title ? { title: a.title } : {}) } })),
  action("list", "Save a checklist card in Unfiled, a group or an idea. Each CLI argument is an item; [x] marks a completed item.", { items, title: text.optional(), ...place }, { positional: [], rest: "items", flags: { title: "title", ...placeFlags } }, (a) => ({ method: "POST", path: "/api/notes", body: { bullets: a.items.map(checkbox), title: a.title ?? LIST_TITLE, scope: placed(a) } })),
  action("link", "Save a link card: a web page, a PDF (address or path), artifact:<id> or a Claude artifact link, with an optional readable title. Several links make one card.", { links: z.array(href).min(1), title: text.optional(), ...place }, { positional: [], rest: "links", flags: { title: "title", ...placeFlags } }, (a) => ({ method: "POST", path: "/api/notes", body: { bullets: a.links.map((l) => linkLine(l.trim(), a.links.length === 1 ? a.title : undefined)), ...(a.links.length > 1 && a.title ? { title: a.title } : {}), scope: placed(a) } })),
  action("edit-list", "Replace a checklist's items to tick, rename, add or remove them. Keep [x] on completed items. Archive a list to delete it; restore-note undoes deletion.", { note: id, items, title: text.optional(), ...place }, { positional: ["note"], rest: "items", flags: { title: "title", ...placeFlags } }, (a) => ({ method: "PUT", path: `/api/notes/${encodeURIComponent(a.note)}`, body: { bullets: a.items.map(checkbox), ...(a.title ? { title: a.title } : {}), ...(a.scope || a.group || a.idea ? { scope: placed(a) } : {}) } })),
  action("move-note", "Move a board item (note, list or link) to a group, an idea or Unfiled: --group <id>, --idea <id>, --scope, or --unfiled. Move it back the same way to undo.", { note: id, ...place, unfiled: z.boolean().optional() }, { positional: ["note"], flags: { ...placeFlags, unfiled: "unfiled" } }, (a) => {
    if (!a.unfiled && !a.scope && !a.group && !a.idea) throw new Error("Say where it goes: --group <id>, --idea <id>, --scope <scope> or --unfiled.");
    return { method: "PUT", path: `/api/notes/${encodeURIComponent(a.note)}`, body: { scope: scopeOf({ scope: a.scope, group: a.group, idea: a.idea, global: a.unfiled }) } };
  }),
  action("board", "Read every board item (notes, lists, links) with its place, as JSON. Use --group, --idea or --scope to read one place.", { ...place }, { positional: [], flags: placeFlags }, (a) => {
    const where = a.scope || a.group || a.idea ? parseNoteScope(placed(a))! : null;
    const q = !where ? "" : where.kind === "global" ? "?global=1" : `?${where.kind === "mission" ? "idea" : where.kind}=${encodeURIComponent(where.id)}`;
    return { method: "GET", path: `/api/notes${q}` };
  }),
  action("undo", "Undo a map commit, restoring exactly its changed files. Use --housekeeping for a tidy commit.", { commit, housekeeping: z.boolean().optional() }, { positional: ["commit"], flags: { housekeeping: "housekeeping" } }, (a) => ({ method: "POST", path: a.housekeeping ? "/api/ideas/undo" : "/api/missions/move/undo", body: { commit: a.commit } })),
];
export const mapAction = (name: string) => {
  const entry = MAP_ACTIONS.find((a) => a.name === name);
  if (!entry) throw new Error(`Unknown map action ${name}. Use joyride map --help.`);
  return entry;
};
export const MAP_TOOLS = MAP_ACTIONS.map((a) => ({
  name: `map_${a.name.replaceAll("-", "_")}`, description: a.description,
  inputSchema: z.toJSONSchema(a.schema.extend({ agent: MapActor.shape.id.optional() })),
}));
