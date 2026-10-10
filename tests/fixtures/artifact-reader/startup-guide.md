# Reports workspace startup guide

HTML: [report.html](report.html). A fictional fixture for the artifact reader: Ledger, a made-up reporting app, started locally in two terminals or as an offline preview.

## Startup commands

API terminal:
```sh
cd ~/code/ledger/api
# Uses ./scratch.db unless LEDGER_DB points somewhere else.
python -m ledger.server --host 127.0.0.1 --port 8011
```

Frontend terminal:
```sh
cd ~/code/ledger/web
LEDGER_PORT=4320 npm run build && \
LEDGER_PORT=4320 LEDGER_API_URL=http://127.0.0.1:8011 \
npm run serve
```

Open http://127.0.0.1:4320/reports or /reports/<id>. Start the API first, then the frontend. Stop each with Ctrl+C and restart with the same commands. Rebuild after code or port changes.

Offline preview:
```sh
cd ~/code/ledger/web
LEDGER_PORT=4321 npm run preview
```

Open http://127.0.0.1:4321/?sample=quarterly and add &dark=1 for dark mode. No API, database or key is needed.

## Prerequisites

- Python 3.12 or later and Node 20 or later; dependencies come from the public registries.
- `LEDGER_DB` picks the API's database file and defaults to `./scratch.db`. Use a scratch file: the connected mode writes to it.
- `python -m ledger.seed` fills a scratch database with three example reports.

## What was verified

This is a fixture, so nothing was launched. It exists to exercise the reader: tall content, terminals that size to their commands, copy buttons and a table that reflows at phone width.
