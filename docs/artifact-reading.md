# Reading and delivering reports

Artifact cards and links open a full-window reader before their details. The shared overlay keeps the originating canvas, list, session or agent pane mounted. Back to details (or Escape) opens the same artifact's metadata, source and links. Read report returns to the document. Close, or Escape from details, restores the originating view and focused control without moving the canvas, list or conversation. An unsent agent reply stays in its composer.

Browser Back follows the same reader → details → origin history. A direct artifact URL has no previous Joyride view to restore, so closing it returns to its artifact list. Pull requests and preserved sessions retain their existing details-first behavior. The reader does not require the browser Fullscreen API.

The toolbar stays visible while the document scrolls. HTML retains its own styling in the existing isolated iframe. Markdown renders as a document with comfortable margins, tables and wrapping code blocks; the entire cached original is used rather than the summary or the older truncated text endpoint. At narrow widths the title and actions wrap without reducing the report to a small nested panel. Tab stays in the overlay; the existing HTML keyboard bridge forwards Escape and the final forward Tab to its toolbar.

## Available content and security

The reader uses the artifact's registered, content-addressed snapshot. Registration and Firstmate scanning continue to resolve local sources through the existing allowlist and snapshot policy. Reading and download endpoints read only a validated snapshot hash; they never read a supplied local path or fetch a remote page as a substitute.

| Registered source form | Reading behavior |
| --- | --- |
| HTML with an available snapshot | Full-window isolated HTML, preserving authored CSS and document scripts |
| Markdown with an available snapshot | Full rendered original; no raw-source default or summary substitution |
| Supported text, image or PDF snapshot | Existing isolated preview, or image display |
| Remote link with no available snapshot | Explanation, explicitly labeled saved summary and Open original |
| Missing snapshot blob | Explanation and instructions to re-register the local file |
| Unsupported snapshot MIME type | Explanation plus Download source and available original link |

The iframe and HTTP response retain `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`, with no `allow-same-origin`. Artifact scripts cannot access the parent document or its local storage. The expanded preview adds only the existing keyboard bridge. Markdown is rendered with React text nodes; unsafe link schemes are not made clickable. Source downloads are attachments with `nosniff`. No source allowlist or CSP was relaxed.

The snapshot contains the registered file. Relative sibling files are not a recursively captured website. Self-contained HTML is the reliable report format. An expired or login-protected remote-only link cannot become a complete original locally; export and register the document to retain it. Reports without a saved original are never presented as complete reports.

## HTML report preference and registration

Agent-facing preference lives in `guidance/captain.md` and the matching installer source `install/guidance/captain.md`. Requested reports should be self-contained HTML with a discoverable artifact link. Markdown remains suitable for supporting source or a durable internal index.

For a report outside Firstmate's automatic discovery path, use the existing artifact registration API:

```sh
joyride api POST /api/artifacts '{"local_source":"/absolute/path/report.html","kind":"report","title":"Report title","mission":"idea-slug","session":"codex:session-id"}'
joyride map link artifact:<returned-id> --idea idea-slug
```

Use the artifact link returned by registration in the agent's reply. Session and agent panes show their registered artifacts. Registered provider report URLs in rendered conversation/document links enter the same reader; explicit Open original and review actions remain external.

Firstmate discovery prefers a readable, nonempty `data/<task>/report.html`, including HTML-only tasks. It falls back to `report.md`. The canonical task/report identity remains stable when HTML appears or disappears, preserving the card's id, associations and existing review URL. Both formats participate in the watcher signature and backlog references. Supporting Markdown is preserved.

The scanner also updates an already attached source when it selects a sibling format for that same canonical report. Discovery rank still protects a manually chosen title. The regression covers an attached Markdown source becoming HTML and an attached empty HTML source falling back to Markdown, retaining the original id, title, creation date, notes and review URL.

## Firstmate report regression and Lavish

`tests/fixtures/artifact-reader/startup-guide.{md,html}` is a fictional Firstmate task report (a made-up "Ledger" startup guide) with terminals that size to their commands, copy buttons, a reflowing table and tall content. The regression attaches the Markdown source first, then the HTML sibling, and checks that the same card upgrades to HTML without losing its title or review history, and falls back to Markdown when the HTML goes empty.

After deploying an attached-source correction, the existing scan endpoint refreshes Firstmate cards without migrating their metadata or registering duplicates:

```sh
joyride api POST /api/artifacts/firstmate/scan '{}'
joyride api GET /api/artifacts/<artifact-id>/reading
```

The reading response should be `{"kind":"html"}`, and details should name the task's `data/<task>/report.html`. When a report has a Lavish review board, details label it Review in Lavish and explain that Lavish is an optional annotation/change-request window. Its feedback chat is separate from report content. Reading a report does not create or force a review window.

## Proof and source coverage

`tests/e2e/artifact-reader.spec.ts` exercises the actual home/list, canvas, session, agent, task and transcript entry points, browser Back, Escape, tab navigation, preserved focus/canvas transform/conversation position/unsent draft, tall content, 1440-pixel and 390-pixel windows, and truthful missing/remote states. The existing artifact and Firstmate specs cover their changed journeys. Unit coverage proves original bytes, complete long Markdown, stable Firstmate identity, HTML-only discovery, unchanged isolation headers and unsupported/missing cases.

The read-only live-source inventory is `docs/checkpoints/C6/artifact-reader/source-inventory.json`. At the recorded observation, cached source tags were Claude (16 HTML, 1 Markdown), Firstmate (2 HTML, 16 Markdown), and agent (31 Markdown). There were 49 cards without an available blob or content type. No locally indexed Codex or Grok source tag was found. Provider-independent cache loading is tested for all four source labels; Codex/Grok browser examples are explicitly static fixtures. No live provider generation was invoked.

The startup-guide fixture is fictional. `docs/reports/new-freeform.html` is a local proof report (gitignored); without it the spec uses a small committed stand-in. Screenshots, proof records and a transfer manifest live in `docs/checkpoints/C6/artifact-reader/`. The implementation report is `docs/reports/artifact-reader.html`. This is a local branch delivery: primary-checkout refresh and snapshot transfer require Firstmate's guarded landing instructions.
