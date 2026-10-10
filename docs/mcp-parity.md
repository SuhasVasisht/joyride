# Shared MCP configuration

`config/mcp-manifest.json` is Joyride's source of truth for portable MCP connections and the connections still awaiting provisioning. This manifest deliberately contains no credentials. Each client owns its OAuth login; the installer never reads OAuth stores or copies a token between clients.

From the stable main checkout after merging:

```sh
./bin/joyride install mcp-parity --dry-run
./bin/joyride install mcp-parity
```

The installer targets `~/.claude.json`, `~/.codex/config.toml`, `~/.codex-2/config.toml` and `~/.cursor/mcp.json`, regardless of the current `CODEX_HOME`. Preview prints only server names, changed field names and provisioning notes, and writes nothing. It never connects to a server or starts a daemon.

Existing credentials, unknown servers and unrelated settings are preserved. Conflicting entries and duplicate aliases are left for review. The known retired Atlassian v1 endpoints are upgraded in place, preserving the existing alias and authentication.

Each applied batch backs up affected configs under `.joyride/backups/mcp-parity-*/` with private permissions and logs its actions in `GLOBAL_CHANGES.md`. Those private backups may contain the credentials already in a config. They must stay in the ignored runtime directory. Reinstalling an unchanged manifest makes no config, backup or state changes. No credential appears in the manifest, install state or log.

Undo with:

```sh
./bin/joyride uninstall mcp-parity --dry-run
./bin/joyride uninstall mcp-parity
```

Uninstall restores only unchanged fields Joyride replaced and removes only unchanged entries it created. If you subsequently added authentication or changed a server, it keeps that entry and reports it for review. It never revokes OAuth sessions. Backups remain available. JSON formatting and edited MCP table formatting can differ after undo; unrelated TOML and its comments are preserved. An inline TOML layout that cannot be edited safely is refused before any config changes.

The manifest has two modes: `install` renders a native connection; `review` records an outstanding requirement without creating a misleading connection. An installed URL is configuration parity, not proof of authorization or identical tool lists. Slack still requires an approved static OAuth client. Microsoft's remote Work IQ and several account-hosted connectors need tenant or client provisioning before they can be enabled. The task artifact records the inventory, login steps and recommendations.

Validation runs without any live-home or daemon changes:

```sh
./bin/joyride-evidence run --name "MCP parity unit tests" -- npm test -- tests/unit/mcp-parity.test.ts
./bin/joyride-evidence run --name "MCP parity browser integration" -- node_modules/.bin/playwright test --config tests/e2e/mcp-parity.config.ts
```

The browser integration test exercises the real installer in a disposable HOME and captures its verification receipt via `tests/e2e/shot.ts`. It runs without a web server or Herdr and does not represent an application UI change.
