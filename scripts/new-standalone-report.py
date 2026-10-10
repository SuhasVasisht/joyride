#!/usr/bin/env python3
"""Render the standalone delivery report as one portable HTML file."""
from pathlib import Path
import base64
import html
import json
import re

root = Path(__file__).resolve().parent.parent
source = root / 'docs/reports/new-standalone.md'
proof = json.loads((root / 'docs/reports/new-standalone-native.json').read_text())
live = json.loads((root / 'docs/reports/new-standalone-live.json').read_text())

def inline(text):
    text = html.escape(text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    def link(match):
        label, target = match.groups()
        if target.startswith(('http://', 'https://')):
            return f'<a href="{target}" target="_blank" rel="noreferrer">{label}</a>'
        return f'{label} <span class="path">({target})</span>'
    return re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, text)

blocks = []
paragraph = []
rows = []
items = []

def flush():
    if paragraph:
        blocks.append('<p>' + inline(' '.join(paragraph)) + '</p>')
        paragraph.clear()
    if items:
        blocks.append('<ul>' + ''.join('<li>' + inline(item) + '</li>' for item in items) + '</ul>')
        items.clear()
    if rows:
        head, *body = rows
        blocks.append('<div class="table"><table><thead><tr>' + ''.join('<th>' + inline(cell) + '</th>' for cell in head) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + inline(cell) + '</td>' for cell in row) + '</tr>' for row in body) + '</tbody></table></div>')
        rows.clear()

for line in source.read_text().splitlines():
    if line.startswith('# '):
        flush()
    elif line.startswith('|'):
        if not re.fullmatch(r'[| :\-]+', line):
            rows.append([cell.strip() for cell in line.strip('|').split('|')])
    elif line.startswith('- '):
        items.append(line[2:])
    elif not line:
        flush()
    else:
        paragraph.append(line)
flush()

figures = []
for name, caption in [
    ('native-own-group', 'Recovery with Firstmate absent: a real gpt-6-luna session in its own Native recovery group.'),
    ('native-terminal', 'The launched session has an interactive terminal; its follow-up reached Codex.'),
    ('native-model-reload', 'A saved standalone model override survives reload.'),
    ('native-joined-group', 'A deep-work request joins the intended existing group with the saved gpt-5.6-luna selection.'),
    ('native-luna-job-result', 'A native gpt-6-luna small job records its result and completion callback.'),
    ('model-settings', 'Separate persisted choices for routing, small New jobs and standalone sessions.'),
    ('supported-choice', 'An unresolved repo or group receives a bounded supported choice while retaining the request.'),
]:
    image = root / f'docs/checkpoints/new-standalone/{name}.png'
    encoded = base64.b64encode(image.read_bytes()).decode()
    figures.append(f'<figure><img loading="lazy" src="data:image/png;base64,{encoded}" alt="{html.escape(caption)}"><figcaption>{html.escape(caption)}</figcaption></figure>')

startup = (root / 'docs/reports/new-standalone-startup-pointer.md').read_text()
page = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>New standalone sessions: implementation and proof</title><style>
:root{color-scheme:light;--paper:#f4f6f5;--ink:#15233e;--line:#ccd6db;--muted:#4f626e}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:44px 30px 72px}header{border-bottom:2px solid var(--ink);margin-bottom:30px;padding-bottom:24px}h1{font-size:clamp(32px,5vw,54px);line-height:1.1;letter-spacing:-.035em;margin:12px 0}h2{font-size:25px;margin:40px 0 16px}p{max-width:90ch}.eyebrow,.path,figcaption{color:var(--muted)}.eyebrow{font-size:14px}.roles{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:28px 0}.role{border:1px solid var(--line);padding:18px;background:white;border-radius:8px}.role strong{display:block}code{font:14px/1.5 ui-monospace,monospace;background:#e9eef0;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:15px}th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#e9eef0}figure{margin:24px 0;border:1px solid var(--line);background:white;border-radius:8px;overflow:hidden}img{display:block;width:100%;height:auto}figcaption{padding:14px 18px;font-size:15px}details{margin:24px 0;padding:16px;border:1px solid var(--line);border-radius:8px}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}footer{margin-top:36px;border-top:1px solid var(--line);padding-top:20px;font-size:14px;color:var(--muted)}@media(max-width:650px){main{padding:24px 16px 48px}.roles{grid-template-columns:1fr}th,td{padding:8px}}
</style></head><body><main><header><div class="eyebrow">Joyride · build-joyride · local branch delivery</div><h1>New standalone sessions</h1><p>Start your own repo session from New, choose its canvas group, and keep working when Firstmate is unavailable.</p></header><section class="roles" aria-label="New model roles"><div class="role"><strong>Routing and judgment</strong>Existing Jev default; configurable native model and account.</div><div class="role"><strong>Small New jobs</strong>Native Codex <code>gpt-6-luna</code> by default; explicit selections retained.</div><div class="role"><strong>Standalone sessions</strong>Native Codex <code>gpt-6-luna</code> by default; interactive, user-owned repo session.</div></section>'''
page += ''.join(blocks)
page += '<h2>Actual home → New → Settings</h2><p>Read-only live check on PID 10399, build <code>b5a950349bbf</code>, October 6, 2026 at 21:11 UTC. Existing settings and sessions were preserved.</p><ol>'
for name, title, caption in [
    ('live-home', 'Fresh home', 'The actual combined build exposes New and the standalone-session hint.'),
    ('live-new', 'Focus New', 'The visible N shortcut focuses the empty request box without sending it.'),
    ('live-settings-roles', 'Open Settings', 'More → Settings exposes routing, small-job and standalone models. Both execution roles display native Codex gpt-6-luna; Save stays disabled.'),
]:
    encoded = base64.b64encode((root / f'docs/checkpoints/new-standalone/{name}.png').read_bytes()).decode()
    page += f'<li><h3>{html.escape(title)}</h3><img loading="lazy" src="data:image/png;base64,{encoded}" alt="{html.escape(caption)}"><p>{html.escape(caption)}</p></li>'
page += '</ol><details><summary>Live UI fields and unchanged settings hashes</summary><pre>' + html.escape(json.dumps(live, indent=2)) + '</pre></details>'
shortcut = base64.b64encode((root / 'docs/checkpoints/new-standalone/shortcut-map.png').read_bytes()).decode()
page += '<h2>Shortcut focus regression</h2><p>Isolated fake sandbox after the minimal binding fix. N keeps New focused and the map at Far even with open asks. This is separate from the earlier live deployment proof.</p><img loading="lazy" src="data:image/png;base64,' + shortcut + '" alt="Isolated regression: New remains focused while the map stays at Far with open asks.">'
page += '<h2>Real New UI and model proof</h2>' + ''.join(figures)
page += '<details><summary>Native launch receipts and recorded model output</summary><pre>' + html.escape(json.dumps(proof, indent=2)) + '</pre></details>'
page += '<details><summary>Startup isolation and remaining coverage limit</summary><pre>' + html.escape(startup) + '</pre></details>'
page += '<footer>Self-contained HTML: styles, screenshots and native excerpts are embedded. Supporting source: docs/reports/new-standalone.md. Full private credentials and rollouts remain outside this report.</footer></main></body></html>'
output = root / 'docs/reports/new-standalone.html'
output.write_text(page)
print(f'{output}: {output.stat().st_size} bytes; {len(figures)} native/isolated, 3 live and 1 shortcut embedded screenshots')
