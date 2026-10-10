#!/usr/bin/env python3
"""Build a self-contained review artifact from recorded New-box results."""
import base64
import html
import io
import json
import os
import re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "docs/reports"
esc = lambda s: html.escape(str(s), quote=True)
load = lambda p: json.loads((REPORTS / p).read_text())
proofs = load("new-freeform-browser.json")
evaluation = load("new-freeform-jev.json")
real = load("new-freeform-real-agent.json")
corpus = json.loads((ROOT / "tests/fixtures/new-corpus.json").read_text())
inventory = [line.strip().strip("|").split("|") for line in (REPORTS / "new-freeform-inventory.md").read_text().splitlines() if line.startswith("| ")][2:]

def picture(file):
    image = Image.open(file).convert("RGB")
    image.thumbnail((960, 600))
    buf = io.BytesIO()
    image.save(buf, format="WEBP", quality=76)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()

inventory_proofs = {
    "Create an empty group": ["Create a group called"],
    "Create a group containing an idea": ["Make a group Sandbox with"],
    "Create a group containing a session": ["Make a group Session sandbox"],
    "Rename authored": ["Rename New Research", "Rename alpha", "Rename beta"],
    "Merge groups": ["Merge New Research"],
    "Delete a group": ["Delete group New Research"],
    "Position or reset": ["Move group New Core", "Reset group New Core"],
    "Move an idea": ["Move OAuth login flow", "Move Make the nightly sync"],
    "Move a task": ["Move task jr-csv-export"],
    "File a session": ["Move Idempotent sync job"],
    "Hide and unhide": ["Hide Idempotent", "Unhide Idempotent"],
    "Undo a map": ["Undo the last change"],
    "Create an empty idea": ["Create an empty idea"],
    "Rename an idea": ["Rename idea OAuth"],
    "Edit an idea goal": ["Set OAuth login flow goal", "Choose clearer evidence"],
    "Pause, resume": ["Pause idea", "Resume idea", "Drop idea", "Finish idea", "Archive idea", "Unarchive idea"],
    "Create notes": ["note: freeform", "Note: Friday"],
    "Create named lists": ["Make a release list"],
    "Add link cards": ["artifact:rep-launch", "Link: https://claude.ai", "Link: https://example.com/report.pdf"],
    "Edit note bullets": ["Edit note Openable", "Edit list Release"],
    "Check, uncheck": ["Tick build", "Untick test", "Add item docs", "Rename item tag", "Remove item tag", "Reorder Agent priority"],
    "Move a note": ["Move list Release"],
    "Delete and restore": ["Delete list Release", "Restore list Release"],
    "Save a note and tell": ["Tell Firstmate about"],
    "Open a note drawer": ["Open Openable canvas note"],
    "Navigate to Map": ["Open Map", "Go to Board", "Open Agents", "Open Settings", "Open Artifacts", "Open Search", "Open Setup", "Open Usage", "Open Evidence", "Open Guide"],
    "Open idea, task": ["Open OAuth", "Open task", "Open worker", "Open session"],
    "Focus an idea": ["Focus New Core", "Focus OAuth", "Clear focus", "Fit the map", "Zoom far", "Zoom mid", "Zoom near"],
    "Pan the map": ["Pan map left", "Group related sessions"],
    "Show or hide archived": ["Show archived", "Hide archived"],
    "Open or close the rail": ["Hide the rail", "Show the rail"],
    "Filter agents": ["Show running", "Show idle", "Show done", "Show yours", "Show crew", "Show needs you", "Show at my helm", "Show suggested"],
    "Change idea/recent": ["Sort agents", "Show agents in"],
    "Search knowledge": ["Search for export", "Open New report"],
    "Select and triage": ["Accept proposal", "Reject proposal", "Triage suggestions"],
    "Reopen a suggestion": ["Reopen proposal", "Scan for suggested"],
    "Read proposal context": ["Summarize suggestion new-context"],
    "Reply to or steer": ["Reply to worker local:w2:p1:", "Steer task"],
    "Answer worker prompts": ["Allow prompt", "Answer decision:"],
    "Finish or release": ["Answer hold:"],
    "Recheck an ask": ["Recheck ask"],
    "Acknowledge attention": ["Acknowledge Freeform", "Undo acknowledgement", "Snooze Freeform"],
    "Approve or deny": ["Deny approval", "Allow prompt"],
    "Read attention history": ["Open the evidence for this task"],
    "Hand a worker back": ["Hand back", "Exclude", "Include"],
    "Propose preserving": ["Save and close"],
    "Focus a Herdr pane": ["Focus pane", "Move to Herdr local:pid:"],
    "Switch worker chat": ["Open terminal tab", "Open chat tab", "Open context tab"],
    "Type terminal": ["Type in worker", "Reply to worker local:w2:p1 with image"],
    "Start a session in": ["Start a session here", "Start a session in New Core", "Start a session in /tmp"],
    "Resume a saved": ["Resume session"],
    "Configure harness": ["Start Codex with my Codex account"],
    "Create a Firstmate task": ["Task:"],
    "Send Firstmate an update": ["Firstmate:"],
    "Start Firstmate": ["Start Firstmate", "Switch Firstmate"],
    "Read, nudge": ["Nudge request", "Dismiss request"],
    "Open, register": ["Register artifact:", "Edit artifact New report", "Open New report"],
    "Curate artifact": ["File this report"],
    "Scan artifacts": ["Scan artifacts"],
    "Reverify evidence": ["Reverify OAuth"],
    "Edit Jev/default": ["Set Jev model", "Set default model", "Choose a better default model", "Use Codex with my Codex account"],
    "Enable notifications": ["Disable notifications", "Enable notifications", "Set notification level", "Test notification"],
    "Read guard policy": ["Inspect guard policy", "Remove remembered rule"],
    "Read guidance": ["Open Firstmate captain.md", "Open Settings", "Open Guide"],
    "Install components": ["Install hooks", "Sign in to GitHub", "Focus GitHub login"],
    "Dismiss Setup": ["Dismiss setup hints", "Mark setup claude-login"],
    "Read usage": ["Refresh my usage"],
    "Open the palette": ["Open command palette", "Close this sheet"],
    "Create an artifact through": ["Link the artifact about exports here"],
}

def match(action):
    keys = [key for key in inventory_proofs if action.startswith(key)]
    assert len(keys) == 1, f"Inventory action has no explicit proof mapping: {action}"
    prefixes = inventory_proofs[keys[0]]
    for prefix in prefixes:
        assert any(p["text"].startswith(prefix) for p in proofs), f"Missing browser proof: {prefix}"
    return [i for i, p in enumerate(proofs) if any(p["text"].startswith(prefix) for prefix in prefixes)]

notes = {
    "Read proposal context": "The browser job reads and refreshes the actual proposal context owner, asserts a ready session summary and saves it on the canvas. The owner model is fake in this test.",
    "Configure harness": "The browser job selects a Codex account, launches with an explicit folder/prompt/model, files the child session in the idea and verifies Undo without replacing its own job identity. The real job proof uses Haiku; every provider/account combination was not run.",
    "Curate artifact": "Artifact idea filing is asserted through the recorded owner. Metadata/source edits use the existing artifact owner; local source privacy and tombstones remain enforced.",
    "Focus a Herdr pane": "Pane focus and private dummy-process migration succeed through the sandbox owner. An already-Herdr worker is refused. Real lifecycle calls use only the named guarded lab.",
    "Resume a saved": "The saved folder, harness and session id are retained. The index does not record the originating account; an explicit account request falls back to an agent rather than guessing.",
    "Read guidance": "Exact canonical file names open through the native-file owner. Absent files fail visibly. Guidance, component and metric pages are also reachable through Settings, Setup, Guide and Usage.",
    "Edit Jev/default": "Simple model edits execute immediately. Structured effort settings are asserted through a recorded agent action; provider authentication remains with its existing owner.",
    "Add link cards": "Artifact refs, Claude artifact URLs and PDF link cards are exercised. Downloads and remote embedding retain the artifact owner’s network and content-type rules.",
    "Undo a map": "Textual map Undo and receipt Undo are exercised. Housekeeping uses its existing recorded undo owner; an inferred housekeeping request goes to an agent.",
    "Search knowledge": "New opens Joyride result/source sheets and artifact previews. External original-source links still need the browser's link action: the daemon has no browser-tab owner, and an asynchronous classifier has no popup activation.",
}

rows = []
for n, parts in enumerate(inventory, 1):
    action, example, route = [s.strip().replace("`", "") for s in parts]
    matches = match(action)
    i = matches[0]
    proof = proofs[i]
    r = proof["receipt"]
    limit = next((v for k, v in notes.items() if action.startswith(k)), "")
    related = ''.join(f'<li><a href="#proof-{j}">{esc(proofs[j]["text"])}</a></li>' for j in matches)
    rows.append(f'<tr data-search="{esc(action + " " + example + " " + route)}"><td>{n:02d}</td><td><strong>{esc(action)}</strong><p class="example">{esc(example)}</p><small>{esc(limit)}</small></td><td>{esc(route)}</td><td><a href="#proof-{i}">{esc(proof["text"])}</a><p>{esc(r["route"])} · {esc(r["state"])}</p><small>{esc(r["message"])}</small></td><td><a href="#proof-{i}">Screenshot and test ↗</a><p><code>new-freeform.spec.ts</code></p><details><summary>{len(matches)} matching executions</summary><ul>{related}</ul></details></td></tr>')

cards = []
for i, p in enumerate(proofs):
    r = p["receipt"]
    initial = (REPORTS / p["screenshot"].replace("-result.png", ".png")).resolve()
    start = f'<details><summary>Agent spin-up</summary><img loading="lazy" src="{picture(initial)}" alt="Initial agent job on the canvas"></details>' if p["screenshot"].endswith("-result.png") else ""
    cards.append(f'<details id="proof-{i}" class="proof" data-search="{esc(p["text"] + " " + p["test"] + " " + r["route"])}"><summary><span class="badge">{esc(r["route"])}</span> {esc(p["text"])}</summary><p>{esc(r["message"])}</p><p class="meta">State: {esc(r["state"])} · Animation: {esc(r["animation"])} / computed CSS {esc(p["animation"])} · Undo: {str(r["undo"]).lower()}</p><p class="meta">Test: {esc(p["test"])}</p><img loading="lazy" src="{picture((REPORTS / p["screenshot"]).resolve())}" alt="Sandbox screenshot after {esc(p["text"])}">{start}<details><summary>Owner receipt</summary><pre>{esc(json.dumps(r, indent=2))}</pre></details><details><summary>Captured screen context</summary><pre>{esc(json.dumps(p.get("context"), indent=2))}</pre></details></details>')

metrics = "".join(f'<tr><td>{esc(route)}</td><td>{m["tp"]}</td><td>{m["fp"]}</td><td>{m["fn"]}</td><td>{m["precision"]:.1%}</td><td>{m["recall"]:.1%}</td></tr>' for route, m in evaluation["metrics"].items())
misses = "".join(f'<tr><td>{esc(p["text"])}</td><td>{esc(p["expected"])}</td><td>{esc(p["predicted"])}</td><td>{p["confidence"]}</td></tr>' for p in evaluation["rows"] if p["expected"] != p["predicted"])
labels = "".join(f'<details data-search="{esc(p["text"])}"><summary>{esc(p["text"])}</summary><pre>{esc(json.dumps({"context":p["context"], "expected":p["expected"]}, indent=2))}</pre></details>' for p in corpus)

# Read the actual attested evidence events, keeping the latest record per named check.
evidence = {}
event_dirs = {ROOT / ".joyride/events"}
if os.environ.get("NEW_EVIDENCE_DIR"): event_dirs.add(Path(os.environ["NEW_EVIDENCE_DIR"]))
for file in sorted(file for directory in event_dirs for file in directory.glob("*.jsonl")):
    for line in file.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get("data", {}).get("item", {})
        if event.get("type") == "evidence.added" and item.get("cwd") == str(ROOT) and item.get("mission") == "build-joyride" and item.get("name", "").startswith("New "):
            if item.get("created", "") > evidence.get(item["name"], {}).get("created", ""):
                evidence[item["name"]] = item
checks = "".join(f'<tr><td>{esc(e["name"])}</td><td><code>{esc(e["id"])}</code></td><td>{esc(e.get("exit_code"))}</td><td>{esc(e.get("assertions"))}</td></tr>' for e in evidence.values())
verdict_file = REPORTS / "new-freeform-verdict.json"
verdict = json.loads(verdict_file.read_text()) if verdict_file.exists() else None
verdict_html = f'<p>Isolated real Jev evidence verdict: <strong>{esc(verdict["verdict"])}</strong> · <code>{esc(verdict["id"])}</code></p>' if verdict else '<p>The final evidence verdict is pending until the recorded checks finish.</p>'

real_closeups = "".join(f'<details><summary>{esc(name)}</summary><img style="max-width:100%" src="{picture(ROOT / "docs/checkpoints/new-freeform" / name)}" alt="Actual completed real-agent result"></details>' for name in real.get("screenshots", []) if name in ["real-agent-card.png", "real-agent-receipt.png"])

animation_css = "\n".join(line for line in (ROOT / "src/ui/views/new/new.css").read_text().splitlines() if line.startswith("@keyframes"))
animation_names = ["note", "list", "link", "move", "group", "idea", "view", "reply", "attention", "settings", "firstmate", "agent"]
animations = "".join(f'<button class="demo" data-animation="{name}"><span>{name}</span><small>Replay</small></button>' for name in animation_names)
out = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Freeform New — review report</title>
<style>
:root {{ --paper:#f3f3ed; --ink:#15233e; --review:#526d8c; --rule:#d4d7ce; --paper-sunk:#e7e9e0; }}
*{{box-sizing:border-box}} body{{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,sans-serif}} main{{max-width:1180px;margin:auto;padding:48px 28px}} h1,h2{{font-family:Georgia,serif;font-weight:400;line-height:1.15}} h1{{font-size:52px;max-width:850px}} h2{{font-size:32px;margin-top:54px}} p{{max-width:880px}} a{{color:#285d83}} code,pre{{font-size:12px}} pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#e8ebe3;padding:15px}} table{{border-collapse:collapse;width:100%;font-size:14px}} th,td{{text-align:left;padding:12px;border-bottom:1px solid var(--rule);vertical-align:top}} th{{font-weight:500;background:#e7e9e0}} .example{{font-family:Georgia,serif;font-style:italic;margin:8px 0}} small,.meta{{font-size:12px;color:#53627a}} .kicker{{letter-spacing:.12em;font-size:12px}} .routes,.animations{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}} .route,.demo{{border:1px solid var(--rule);padding:18px;background:#fafbf5;text-align:left}} .route b{{display:block;font-family:Georgia,serif;font-size:25px;font-weight:400}} .badge{{font-size:11px;background:#e2e7e3;padding:4px 8px;border-radius:3px}} input{{width:100%;font:inherit;padding:12px;border:1px solid #748498;background:#fff}} details{{border-top:1px solid var(--rule);padding:12px 0}} summary{{cursor:pointer}} .proof img{{width:100%;height:auto;border:1px solid var(--rule);margin:14px 0}} .proof:target{{background:#e7ece5}} .demo{{font:inherit;color:var(--ink);cursor:pointer;min-height:86px}} .demo span,.demo small{{display:block}} .demo.play span{{animation:var(--anim) 850ms ease}} .note{{border-left:3px solid #6a7f92;padding-left:18px}} [hidden]{{display:none!important}}
{animation_css}
@media(prefers-reduced-motion:reduce){{.demo.play span{{animation:none}}}} @media(max-width:700px){{main{{padding:24px 14px}}h1{{font-size:36px}}.routes,.animations{{grid-template-columns:1fr}}td,th{{padding:8px}}table{{font-size:12px}}}}
</style></head><body><main>
<p class="kicker">Joyride / build-joyride / local review</p><h1>Type what you want.<br>Jev finds the route.</h1>
<p>The right-hand New box has one text area and Send. It can save content, change the map or view, send a task directly to Firstmate, or start a small agent with the current screen context. This report connects the UI inventory to owner results, screenshots and tests.</p>
<div class="routes"><div class="route"><b>Do it now</b><p>A complete UI action judged by Jev executes through its existing owner. Canvas changes and view changes have Undo.</p></div><div class="route"><b>Send to Firstmate</b><p>The original words go directly to <code>create_task</code>. Mission and request markers survive. No intermediate heavy model rewrites them.</p></div><div class="route"><b>Start a small job</b><p>Judgement, search and uncertain targets start a visible Haiku session. Normal Joyride CLI writes are recorded under the job and land on the canvas.</p></div></div>
<p class="note">Here and this use the current idea/group, selected and hovered element. Jobs receive the route, map view, focus, element details and visible items. A low-confidence decision never opens a picker.</p>
<h2>What you can do</h2><p>{len(inventory)} inventory rows, covering {len(set(p['item'] for p in corpus))} labelled action families. Examples describe the intended route; the execution links show the actual sandbox words and owner outcome. When Jev is uncertain, the same request takes the agent route.</p>
<label for="filter">Find an action, example or test</label><input id="filter" type="search" placeholder="Try notes, Firstmate, settings or Undo">
<table><thead><tr><th>#</th><th>UI action and example</th><th>Route</th><th>Observed result</th><th>Proof</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
<h2>Feedback you can replay</h2><p>The app has twelve distinct effects: dropped notes, revealed lists, attached links, movement, group formation, new ideas, view changes, replies, attention, settings, Firstmate flight and an agent resolving. These buttons replay the app's keyframes for review; the screenshots below are actual UI captures. Reduced motion is tested separately.</p><div class="animations">{animations}</div>
<h2>Routing measurements</h2><p>{evaluation['samples']} labelled phrases evaluated with real Jev at {esc(evaluation['at'])}. No unavailable responses. Precision and recall are one-versus-rest at the shipped 0.8 confidence threshold. The pure parser tests separately assert routes and literal parameters.</p><table><thead><tr><th>Route</th><th>True positive</th><th>False positive</th><th>False negative</th><th>Precision</th><th>Recall</th></tr></thead><tbody>{metrics}</tbody></table>
<p>All {evaluation['metrics']['deterministic']['fn']} missed deterministic cases became agent jobs. This lowers agent precision because more work than necessary is delegated. The corpus is synthetic, includes polite variants, and overlaps the prompt-calibration sample; it is not an independent human-labelled holdout or a production accuracy claim.</p><details><summary>Every routing miss</summary><table><tr><th>Words</th><th>Label</th><th>Observed</th><th>Confidence</th></tr>{misses}</table></details><details><summary>All {len(corpus)} route and parameter labels</summary>{labels}</details>
<h2>A real agent, from words to canvas</h2><p>Model: <code>{esc(', '.join(real['models']))}</code>. The real session found a seeded artifact by title using Joyride, saved its <code>artifact:</code> reference in the current idea, completed its callback, and the browser verified both the visible card and Undo. Session <code>{esc(real['session'])}</code>, isolated Herdr session <code>{esc(real['labSession'])}</code>.</p><p>{esc(real['receipt']['message'])}</p><img style="width:100%" alt="Real Haiku result on the Joyride canvas" src="{picture(ROOT / 'docs/checkpoints/new-freeform/real-agent-result.png')}">
<details><summary>Real agent spin-up</summary><img style="width:100%" alt="Real Haiku job spinning up in Joyride" src="{picture(ROOT / "docs/checkpoints/new-freeform/real-agent-start.png")}"></details><p class="meta">The real agent test uses deterministic fake Jev for repeatable route selection; the routing table above uses real Jev. The agent, its transcript model, CLI actions, canvas result and Undo are real. The sandbox quota rail uses a recorded usage fixture, not a live account check. General browser tests use fake models/Herdr with actual daemon APIs and UI. Structured agent action tests submit reviewed owner actions; they do not claim that a real agent independently solved every judgement example. External web research and every provider/account combination were not separately exercised.</p>
{real_closeups}
<h2>Recorded checks</h2>{verdict_html}<table><thead><tr><th>Check (latest by name)</th><th>Evidence id</th><th>Exit</th><th>Assertions</th></tr></thead><tbody>{checks}</tbody></table><p class="meta">Earlier failed runs stay in the evidence trail. Required checks are named explicitly. The final integration includes ExpandedArtifact and native report return navigation. The full unit suite, typecheck, build and affected browser specs were rerun after rebasing onto local main. Unit, typecheck, build and affected e2e runs use nice. No whole e2e suite, live daemon or live Firstmate home was used.</p>
<h2>Limits and recovery</h2><ul>
<li>Undo restores authored canvas data and browser state. It cannot unsend a reply, reverse a permission answer, unstart a process, undo external login or retract a notification. Receipts say when there is no reversible change.</li>
<li>Undo refuses to overwrite files changed later. A job's recorded effects are checked together before restoration. Owner-level runtime actions retain their own eligibility checks.</li>
<li>Ambiguous targets become agent jobs. If the agent cannot resolve them, it leaves a visible note describing the missing detail rather than guessing.</li>
<li>Job completion requires a callback. A positively ended worker without one becomes a visible failure with Undo for recorded changes. A disconnected or unknown worker stays running; Open agent is the recovery path. Jobs cannot be undone while still running.</li>
<li>New jobs use the ordinary map, notes and API commands. The CLI blocks host administration, and the recorded API blocks permission/held-decision answers, terminal input, installation and login by an agent. An explicit captain submission can use the existing owner.</li>
<li>Typing cannot identify an unprovided local file, infer credentials or operate the browser's clipboard/history. Stored upload paths, artifact references and registered local reports are supported. File pickers, external authentication and opening original-source links in another browser tab remain with their owners.</li>
<li>Tab-local history keeps the last 30 receipt ids. Durable receipts and effects live in the daemon. Fleet/session visibility is retained, including the agent job sessions.</li>
<li>External web research, PDF downloads and every account/harness configuration were not run end to end; their recorded owners remain available. Proposal context/summary refresh, one configured Codex launch and task/account settings are exercised with fake models and Herdr. The refusal and route behavior are covered where shown.</li>
</ul>
<h2>Execution catalogue</h2><p>{len(proofs)} New-box submissions with actual route, result, computed animation, screenshot and named browser test. Expand a row to inspect the receipt. The real-agent proof is separate above.</p>{''.join(cards)}
<h2>Register this report</h2><p>This HTML embeds its screenshot thumbnails, styles and interactions. It can be snapshotted as a Joyride artifact without a server or relative image files. Firstmate registers it after landing.</p><pre>joyride api POST /api/artifacts '{{"local_source":"&lt;landed checkout&gt;/docs/reports/new-freeform.html","title":"Freeform New — review report","mission":"build-joyride"}}'</pre>
</main><script>
document.querySelector('#filter').addEventListener('input', e => {{const term=e.target.value.toLowerCase();document.querySelectorAll('[data-search]').forEach(row=>row.hidden=!row.dataset.search.toLowerCase().includes(term));}});
document.querySelectorAll('.demo').forEach(button=>button.addEventListener('click',()=>{{button.classList.remove('play');void button.offsetWidth;button.style.setProperty('--anim','nb-'+button.dataset.animation);button.classList.add('play');}}));
function revealHash(){{const el=document.querySelector(location.hash||'#none');if(el&&el.tagName==='DETAILS'){{el.hidden=false;el.open=true;el.scrollIntoView();}}}}
addEventListener('hashchange',revealHash);revealHash();
</script></body></html>'''
file = REPORTS / "new-freeform.html"
file.write_text(out)
assert file.stat().st_size < 25 * 1024 * 1024, "Report exceeds artifact snapshot size."
print(f"Report: {len(inventory)} inventory rows, {len(proofs)} executions, {file.stat().st_size:,} bytes")
