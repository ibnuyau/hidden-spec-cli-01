# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ibnuyau/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ibnuyau/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` reads a patch and applies it
to a tree of text files, all or nothing.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. `PATCH` is the patch file;
when it is absent, or is `-`, the patch comes from standard input.

## Formats

Four, auto-detected by default (`--format=auto`):

- `unified` — a unified diff, even one whose line numbers are wrong. Hunks
  are matched to the nearest occurrence of their old lines.
- `search-replace` — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, each with the file path on the nearest line above it.
- `v4a` — a `*** Begin Patch` / `*** End Patch` patch with Add, Delete and
  Update File sections, anchors, and end-of-file chunks.
- `json` — text-editor tool calls as JSON: one array of edit objects, or one
  object per line (`create`, `str_replace`, `insert`).

## Matching

Each edit names old lines that are found at the first of three tiers that
has a match: exact, then ignoring trailing whitespace, then ignoring leading
and trailing whitespace. `--strict` uses the exact tier only.

## Atomicity

Every edit is applied to an in-memory copy of the tree first. If any edit
fails, nothing is written and the failures are listed. On success the
changed paths are written and listed (`A` added, `D` deleted, `M` modified,
`R old -> new` moved), followed by `ok: <n> files`.

`--check` does everything but write: same output and exit code, no file
created, changed or deleted.

## Exit codes

- `0` — the patch applied.
- `1` — one or more edits failed (`failed: <k> of <n> edits`); nothing written.
- `2` — a usage error, an unreadable patch file, an undetected format, or a
  patch that cannot be read in its format.

Node 22, standard library only. No network, no randomness, deterministic.
