---
name: whittle
tagline: Token-saving techniques for coding agents, each one a switch
description: >-
  A toolkit that puts the proven ways to cut what a coding agent reads and writes behind one
  switchboard — code-graph retrieval, shell-output filtering, a fixed-prefix audit — enabled per
  repository, measured against your own setup, and wired from user-level config so it writes
  nothing into the repositories it serves.
category: developer-tools
websiteUrl: https://whittle.aylith.com/home/
status: building
icon: scissors
---

whittle collects token-saving techniques for coding agents into one CLI and turns each into a
lever you enable per repository. Retrieval answers "where is this and who calls it" from a code
graph instead of whole-file reads. Shell output is filtered before the agent sees it. A prefix
audit shows what rides along on every turn before you type anything.

Three rules shape it. Nothing is written into a repository: wiring lives in the harness's user
config, state and caches under the XDG directories, and `whittle footprint` lists every path it has
ever touched. Nothing leaves the machine: no telemetry, no hosted service in the request path. And
no number is taken on trust: `whittle measure` runs the same task with a lever on and off against
your own configuration, so a lever shows its measured effect — or says it is unmeasured.
