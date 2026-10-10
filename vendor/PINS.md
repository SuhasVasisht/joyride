# Vendored dependencies (pinned; clones are gitignored)

Re-create with `./bin/joyride vendor [name...]` or the commands below. A checkout with uncommitted changes is left alone.

| name | source | pin | purpose |
|---|---|---|---|
| firstmate | https://github.com/kunchenguid/firstmate | fede6197556c188dd2f451809d17851760d1ef46 (2026-10-03) | orchestration distro (crews, delegation); run with FM_HOME=.joyride/firstmate. Joyride's local patches in install/firstmate-patches (patches.json lists them, `pin` there must match) go on top with `git am` and are never pushed upstream. `joyride install firstmate` checks the pin plus those patches (also `FIRSTMATE_PIN` in src/modules/firstmate/seed.ts) and seeds FM_HOME |
| cursor-plugins (pstack only, sparse) | https://github.com/cursor/plugins (path `pstack`) | e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a (2026-10-03) | canonical P-Stack skills (poteto); adapted by `joyride install pstack` with install/pstack-patches/patches.json (`pin` there must match) |
| evals-skills | https://github.com/ai-evals-course/evals-skills | 80d5f7b0127c7572ed9e9339937adbfd7240ffeb (2026-09-24) | the nine evals skills; `joyride install evals` links write-code-eval into ~/.claude/skills and all nine into ~/.codex/skills (pin also `EVALS_PIN` in src/cli/install.ts) |
| backpass | https://github.com/kunchenguid/backpass | 0268201c3896f45d3002de0d439b6cefccb39063 (v0.1.32) | transcript-evidence instruction hill-climbing (pin also `VENDOR` in src/cli/vendor.ts) |

```sh
git clone https://github.com/kunchenguid/firstmate vendor/firstmate && git -C vendor/firstmate checkout fede6197556c188dd2f451809d17851760d1ef46 && git -C vendor/firstmate am "$PWD"/install/firstmate-patches/*.patch
git clone --filter=blob:none --no-checkout https://github.com/cursor/plugins vendor/cursor-plugins && git -C vendor/cursor-plugins sparse-checkout set pstack && git -C vendor/cursor-plugins checkout e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a
git clone https://github.com/kunchenguid/backpass vendor/backpass && git -C vendor/backpass checkout 0268201c3896f45d3002de0d439b6cefccb39063
git clone https://github.com/ai-evals-course/evals-skills vendor/evals-skills && git -C vendor/evals-skills checkout 80d5f7b0127c7572ed9e9339937adbfd7240ffeb
```
