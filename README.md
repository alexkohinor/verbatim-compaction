# verbatim-compaction

[![licence MIT](https://img.shields.io/badge/licence-MIT-1f6feb?style=flat-square)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-none-2f6f4e?style=flat-square)](package.json)
[![no network](https://img.shields.io/badge/network-never-2f6f4e?style=flat-square)](#what-and-why)
[![Claude Code 2.1.274+](https://img.shields.io/badge/Claude%20Code-2.1.274%2B-6b4fbb?style=flat-square)](#install-in-claude-code)
[![benchmark 86% vs 77%](https://img.shields.io/badge/benchmark-86%25%20vs%2077%25%20summary-8a6d1f?style=flat-square)](bench/RESULTS.md)

Claude Code plugin that compacts a session by **deleting stale tool output
instead of summarising it**. Everything kept is byte-for-byte what it was.
Rules only: no model, no network, no API key, nothing leaves the machine.
Also usable as an npm library.

## What and why

Built-in compaction asks a model to summarise old turns. A summary is lossy: a
file path, an exact error, a constraint, a command can disappear precisely
when it matters later. An alternative published approach (`fast-jev-compaction`)
keeps the text verbatim but asks a hosted third-party model, per tool call,
what to delete — which sends the whole conversation to that vendor on every
compaction and decides deletions by probability.

This plugin keeps the verbatim idea and drops both the vendor and the guess.
It deletes only what is provably redundant, by three rules that a person can
check, and it never deletes the record of anything that changed the world.

## The rules

1. **Pinned.** The first message and the newest `preserveRecentMessages` are
   untouched.
2. **Superseded.** A call whose subject a later call revisited is stale:
   - the same file read again, or written after being read;
   - or the very same call (same tool, same input) made again.

   A *read* is then removed whole — the later call carries the current truth.
   Anything that **changed** something keeps its record and loses at most its
   output.
3. **Budget.** What is left is kept verbatim, newest first, until
   `resultBudgetChars` is spent; older output is cut to its head and tail with
   a note in between.

A result no larger than `keepUnderChars` is never cut — cutting it saves
nothing. A result and its call are removed together, so no result is ever left
without its call. Message text — yours and the assistant's — is never removed,
shortened or rewritten.

### What counts as "changed something"

The call record of a side effect is the only evidence that it happened, so it
is never deleted:

- `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Task`, `Artifact`, `Skill`,
  `TodoWrite`, … — always writes;
- `Read`, `Grep`, `Glob`, `WebFetch`, … — reads;
- `Bash` — classified from the command: read-only only when every segment of
  the pipeline is a known reporting command (`ls`, `git log`, `grep`,
  `sed -n`, `docker ps`, …) with no writing redirection, no `$(…)`, no
  `tee`/`xargs`/`sudo`. Anything else is a write;
- an unknown tool, `mcp__*` included, is treated as a write.

Wrong guesses are one-sided by construction: an unrecognised read is merely
kept, an unrecognised write is never deleted.

## Usage as a library

```sh
npm i alexkohinor/verbatim-compaction
```

(installing from GitHub for now; the package is not on npm yet. The install
compiles `dist/` through the `prepare` script, so it needs nothing but Node 18+
and git.)

```ts
import { compact, reductionRatio, type Message } from 'verbatim-compaction';

const result = compact(transcript, { resultBudgetChars: 60_000 });
result.messages;   // the compacted transcript, untouched entries by identity
result.decisions;  // one row per call: action, reason, characters saved
result.stats;      // chars and rough tokens before/after, counts, ms
```

`compact` is pure and synchronous. `Message` is a subset of Claude Code's
`SessionMessage`, so a session transcript can be passed in as is; an outcome
stored on the `tool_use` instead of a `tool_result` is handled either way.
The building blocks are exported too: `collectToolCalls`, `planDecisions`,
`applyDecisions`, `classifyTool`, `classifyCommand`, `callTarget`,
`transcriptChars`, `estimateTokens`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `resultBudgetChars` | `60000` | Tool output kept verbatim, newest first |
| `keepUnderChars` | `600` | Results this small are never cut |
| `headChars` | `400` | Head kept from a cut result |
| `tailChars` | `200` | Tail kept from a cut result |
| `dropSupersededCalls` | `true` | Remove a superseded read entirely, not just its output |
| `readTools` / `writeTools` | `[]` | Force the classification of named tools (e.g. your MCP tools) |

Hook-only options: `minReductionRatio` (default `0.2` — below it the built-in
summary is used instead) and `compactAtPercent` (default `0` — the plugin does
**not** force compaction; Claude Code decides when, as it does without it).

## Install in Claude Code

Function hooks are an early-access feature (Claude Code 2.1.274+), so the flag
must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then, from a checkout:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

or as a marketplace:

```sh
claude plugin marketplace add alexkohinor/verbatim-compaction
claude plugin install verbatim-compaction@verbatim-compaction
```

From then on `/compact` (and auto-compaction) goes through the rules: the
toast reads `verbatim-compaction: kept N/M messages verbatim, no summary (…)`,
or `built-in summary instead (…)` when the rules could not free enough. Every
decision is written to `$.ui.log`, so what was deleted is always inspectable.

## Measured on real sessions

Eight of the author's own Claude Code transcripts, run through the default
options with `scripts/transcript_to_messages.py` + `scripts/measure.ts`
(everything local, nothing sent anywhere):

| session | messages | before | after | removed | calls | dropped whole | output cut |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 9341 | 11.79M | 8.68M | 26.4% | 3689 | 215 | 1189 |
| 2 | 1597 | 2.23M | 1.62M | 27.1% | 623 | 31 | 147 |
| 3 | 6141 | 8.30M | 4.90M | 40.9% | 2466 | 60 | 1041 |
| 4 | 6536 | 8.96M | 5.98M | 33.2% | 2634 | 142 | 981 |
| 5 | 4330 | 5.17M | 3.48M | 32.7% | 1727 | 54 | 597 |
| 6 | 4646 | 3.86M | 3.08M | 20.3% | 1791 | 6 | 522 |
| 7 | 2749 | 5.33M | 4.62M | 13.2% | 887 | 9 | 269 |
| 8 | 4001 | 3.38M | 2.49M | 26.3% | 1460 | 126 | 382 |

49.0M → 34.9M characters, **28.9% removed overall**, 13–41% per session, under
a second per session. Most of it comes from the budget rule (old tool output
beyond the verbatim budget); supersession adds 0.3–17% on top, and exact
duplicates are rare.

These are whole session logs, not single context windows, so read the figure
as "how much accumulated tool output is redundant", not as a context-window
saving.

### Verified in a live session

Claude Code 2.1.278, a headless session that read six files (one of them
twice), then `/compact`:

```
decisions: t1:Read:drop_call/superseded/-7246ch t2:Read:truncate_result/over_budget/-4592ch
           t3:…/-3861ch t4:…/-3885ch t5:…/-3463ch t6:…/-6515ch
verbatim-compaction: kept 15/17 messages verbatim, no summary
                     (71% smaller, ~10469→3076 tokens; 1 calls dropped, 5 results cut)
session.compact settled in 33.2ms
```

The duplicate read was removed whole, the rest keeps head and tail, and no
summary was generated. On a three-message session the same hook logs
`0% smaller` and hands the compaction back to the built-in summary, as it
should.

### A/B against the built-in summary

`bench/` runs the same task in a sandbox with known ground truth, compacts the
session four ways, then asks 14 probes with every tool disabled — the answers
can only come from what compaction left. Ten runs, Claude Code 2.1.278:

| arm | probes recalled | |
| --- | --- | --- |
| no compaction (control) | 138/140 | 99% |
| **these rules** | **120/140** | **86%** |
| built-in summary | 108/140 | 77% |
| rules set to destroy everything | 42/140 | 30% |

The last arm is the sensitivity check: without a treatment that must fail, a
benchmark cannot be trusted — three earlier versions of this one scored the
treated arms like the control because the treatment never reached the probes.
Two gates keep a run honest: every session's edit is verified against a file
hash (40 of 40 landed), and any probe the assistant had already answered in
its own words before compaction is dropped unscored.

**But they are not compared at equal size.** The rules kept 56 KB of a 130 KB
transcript; the summary kept ~10 KB. Keeping five times more context, exactly,
bought nine points — in 33 ms and for nothing, against ~60 s and a model call.
Where the summary loses is exactness: an exact sha survived it half the time.
Where the rules lose is depth: a fact in the middle of a 113 KB log is gone,
and a summariser can still carry it out.

Method, per-probe table, the three broken harnesses and the benchmark's own
defects: [`bench/RESULTS.md`](bench/RESULTS.md).

## Limitations — read these

- **The one A/B that exists is a single synthetic case.** 86% against 77% is
  nine points on that case, at five times the retained context, not a general
  property of either scheme. The 28.9% figure above is about size, not quality.
- The `Bash` classifier is a heuristic over command names. It errs towards
  "this changed something", which costs reduction, not correctness — but a
  read-only command it does not know is simply never cleaned up.
- "Superseded" is positional, not semantic: a second read of a file makes the
  first one stale, but the plugin does not know whether the assistant still
  needs a passage that only the earlier read contains. The head and tail of a
  cut result remain, and the file can be read again.
- Token figures in `stats` are an estimate from character classes, not a
  tokenizer. Nothing in the logic depends on them.
- The Claude Code hook surface is early access and `types/claude-code.d.ts`
  here is a hand-written minimal subset; it loads and runs on 2.1.278 and will
  need updating when that API moves.

## Development

```sh
npm install
npm run typecheck    # library + hook + tests
npm test             # vitest, no network by construction
npm run demo         # prints the decision table for a sample transcript
npm run build
```

## Licence

MIT. The plugin/hook layout and the `session.compact` integration follow the
MIT-licensed `tamaratran/fast-jev-compaction`; the decision logic here is
independent and deliberately model-free.
