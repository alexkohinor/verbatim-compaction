# verbatim-compaction

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
claude plugin marketplace add /path/to/verbatim-compaction
claude plugin install verbatim-compaction@verbatim-compaction
```

From then on `/compact` (and auto-compaction) goes through the rules: the
toast reads `verbatim-compaction: kept N/M messages verbatim, no summary (…)`,
or `built-in summary instead (…)` when the rules could not free enough. Every
decision is written to `$.ui.log`, so what was deleted is always inspectable.

## Limitations — read these

- **No evidence yet that it beats a summary on task outcome.** The rules are
  argued from first principles and covered by unit tests; there is no
  benchmark, no A/B against the built-in summary, no measured task-completion
  comparison. Do not claim otherwise.
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
  here is a hand-written minimal subset; it will need updating when that API
  moves.

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
