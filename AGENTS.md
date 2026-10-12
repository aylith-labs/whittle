# whittle — Claude Code guidance

<!-- aylith-handbook:start -->
> **📖 Aylith handbook (authoritative).** This repo is part of the `aylith-labs` lab. Before any
> cross-repo, catalog, design-system, CI/runner, or data-flow work you **must** consult the org
> handbook — the single source of truth for these conventions:
> https://github.com/aylith-labs/aylith-handbook (locally `../aylith-handbook/`, skill `aylith-labs`).
<!-- aylith-handbook:end -->


## Project Overview

A CLI that turns token-saving techniques for coding agents into levers you enable per repository.
It writes nothing into the repositories it serves: harness wiring goes into user-level config, state
and caches live under the XDG directories. TypeScript on Bun (tests, dev) and Node (the shipped
binary), biome, `typescript` at latest.

## Commands

- `bun install` — install dependencies
- `bun run lint` — biome, read-only
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — the suite, including the e2e tests under `test/e2e/`
- `bun run build` — emit `dist/` (the shipped entry point is `dist/bin.js`)

## Architecture

- `src/bin.ts` — the entry point. Its hook branch dynamically imports only the dispatcher, so an
  unregistered repository loads no lever code; `test/import-discipline.test.ts` enforces that.
- `src/hook/` — the dispatcher: one `whittle hook <event>` per harness event, fail-open, always
  exit 0, per-lever time caps.
- `src/harness/` — per-harness adapters (Claude Code, Codex): event names, timeout units, output
  shapes, and where each writes its hook entries.
- `src/config-writer.ts` — the only code that edits a harness config file. It never writes
  `statusLine`, `subagentStatusLine`, `permissions`, `footerLinksRegexes` or `env`.
- `src/levers/` — one directory per lever, each with a descriptor declaring its layer, shape,
  dependency and how it is measured.
- `src/config.ts`, `src/repo.ts`, `src/ledger.ts` — config and repository registry, repo identity
  (worktrees of one checkout share an id), and the record of every path whittle has written.
- `website/` — the static homepage (plain HTML/CSS). `.github/workflows/homepage.yml` publishes it
  with the packed CLI under `/downloads/` to GitHub Pages at whittle.aylith.com; bump the tarball
  name in `website/index.html` when the version changes (the workflow fails otherwise).

## Conventions

- A lever is off until a repository opts in. `install` only wires the harness.
- Nothing is written inside a repository, ever. `test/e2e/footprint.test.ts` asserts it with a
  negative control that fails when a stray file appears.
- No network calls at runtime, no telemetry, no install-time scripts.
- A measured number is reported with what produced it; an unmeasured lever says so rather than
  quoting a vendor's figure.
