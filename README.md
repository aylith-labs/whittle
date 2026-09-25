# whittle

Token-saving techniques for coding agents, each one a switch.

A coding agent spends tokens in layers: a fixed prefix on every turn, tool schemas, tool output,
code retrieval, its own output, and the history that carries all of it forward. whittle collects the
techniques that attack those layers, turns each into a **lever**, and lets you enable them per
repository.

Three rules shape it:

- **Nothing is written into a repository.** Harness wiring lives in user-level config, state and
  caches under the XDG directories. `whittle footprint` lists every path whittle has ever written.
- **Nothing leaves the machine.** No telemetry, no hosted service, no network calls at runtime.
- **No number is taken on trust.** A lever shows what was measured here, or says it is unmeasured.
  Published figures from elsewhere are labelled as someone else's.

## Install

```sh
npm install -g @aylith/whittle   # run the hook under node: it is the fastest start
whittle install                  # wire the hook into each detected harness
whittle enable                   # opt the current repository in
```

`install` only wires the harness — every lever stays off until a repository opts in. `whittle
uninstall` reverses it and reports whether each config file came back byte-identical to its backup.

## Levers

| Lever | Layer | What it does | State |
|---|---|---|---|
| `shell-output` | tool output | Rewrites allowlisted Bash commands through [rtk](https://github.com/rtk-ai/rtk), which filters their output before the agent reads it. Off by default. | needs the `rtk` binary; each filtered command is recorded in rtk's own `~/.local/share/rtk/history.db` |
| `prefix-audit` | fixed prefix | Ranks what rides along on every turn — memory files, rules, skill descriptions — in approximate tokens, and names what it did not measure. Reports only; injects nothing. | reporting only |
| `retrieval` | code retrieval | Answers "where is this, who calls it" from a code graph instead of whole-file reads, via [@aylith/graft](https://github.com/aylith-labs/graft). | not yet shipped |

## Commands

| Command | What it does |
|---|---|
| `whittle install` / `uninstall` | wire or unwire the hook; uninstall is a dry run unless `-y` |
| `whittle enable [path]` / `disable` | opt a repository in or out, or switch one lever for it |
| `whittle levers` | every lever with its layer, enforcement, dependency and measured effect |
| `whittle status [--json]` | harness wiring, repositories, footprint |
| `whittle doctor` | checks wiring, executables and the environment; exits 1 on a failure |
| `whittle footprint` | every path written outside repositories |
| `whittle prefix-audit [path]` | the per-turn prefix, ranked |

## Licence

MIT. Copyright (c) 2026 The Aylith Authors.
