# Notices

Shiro-Tau is a fork of **Pi** by Mario Zechner and Earendil.

- Upstream repository: https://github.com/earendil-works/pi
- Forked from commit `b4899f5` (Pi 1.5.2)
- License: MIT, Copyright (c) 2025 Mario Zechner. The full text is in [LICENSE](LICENSE).

Everything outside the paths listed below is upstream Pi code. Shiro-Tau is not an official Pi
release and is not affiliated with or endorsed by Earendil.

## What Shiro-Tau adds

New code, Copyright (c) 2026 Shiro-Tau contributors, MIT:

- `packages/coding-agent/src/shiro/` and `packages/coding-agent/test/shiro/`
- `docs/shiro/`

## What Shiro-Tau changes in upstream files

- `packages/coding-agent/package.json`: command name `shiro`, config directory `.shiro`, product version.
- `packages/coding-agent/src/main.ts`: loads the Shiro runtime; adds the `policy` command.
- `packages/coding-agent/src/config.ts`: product version label; a switch that lets Pi's tests run with Pi's names.
- `packages/coding-agent/src/core/trust-manager.ts`, `src/core/project-trust.ts`: a project that brings
  permission rules or hooks needs a trust decision.
- `packages/coding-agent/src/cli/args.ts`: the `policy` command in the help text.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: no update notices from Pi's release feed.
- `packages/coding-agent/vitest.config.ts`, `test/package-distribution.test.ts`: test setup for the above.
- `package-lock.json`, `packages/coding-agent/install-lock/package-lock.json`: the renamed command.
- `.github/`: upstream's project automation (issue gates, package publishing, binaries) is removed;
  one build, check and test workflow remains.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`: rewritten for this project.

## Compatibility with other tools

Shiro-Tau reads configuration written for Claude Code (`settings.json` permissions and hooks) and
OpenAI Codex (`.rules` files and `hooks.json`). These formats were implemented from the tools'
public documentation. No source code from Claude Code was used. No source code from Codex or
DeepSeek Harness is included in this version.

Claude Code is a product of Anthropic. Codex is a product of OpenAI. The names are used only to
say which configuration formats are understood.
