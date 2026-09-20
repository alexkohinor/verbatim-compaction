# Benchmark: does the assistant still know what it needs after compaction?

Run on 2026-09-20, Claude Code 2.1.278, case `bench/case-parser`
(a sandbox repository with known ground truth, rebuilt from `setup.sh` before
every session, so anyone can reproduce this).

**Headline: ten runs, four arms, 140 probe-instances each. The rules recalled
86% of what was asked, the built-in summary 77%, an uncompacted control 99%,
and an arm configured to destroy everything 30%. The summary keeps far less
context than the rules do — ~10 KB against 56 KB — so this is not "better
compaction", it is "more kept, more remembered, and kept exactly".**

An earlier version of this file reported the opposite (76% against 83%) from a
harness with a defect; what that was and how it was caught is in *Three
harnesses that measured nothing*, below.

## What is measured

One session does a fixed ten-step task in the sandbox (read a constraints
file, a config, a CODEOWNERS grep, a 70 KB frozen file, a 113 KB build log,
run a failing test, read the parser, fix it, read it again, re-run the test)
and is told to work silently, so facts live in tool output rather than in its
own words. Then the session is compacted and asked 14 probes with **every tool
disabled**: the answers can only come from what compaction left behind.

Four arms:

| arm | treatment |
| --- | --- |
| A | `/compact` with this plugin, default options |
| B | `/compact` without it — Claude Code's built-in summary |
| C | no compaction (control, upper bound) |
| D | `/compact` with the plugin's options set to destroy everything (budget 0, no head, no tail, no pinning) |

Arm D is the sensitivity check. Without it the benchmark cannot be trusted:
if a scheme that deletes everything still scores like the control, the probes
are not measuring retention.

## Result, ten runs, 14 probes each

| arm | probes recalled | |
| --- | --- | --- |
| C | 138/140 | **99%** no compaction |
| A | 120/140 | **86%** verbatim rules |
| B | 108/140 | **77%** built-in summary |
| D | 42/140 | **30%** rules set to destroy |

All 40 sessions passed the edit gate, and no probe was dropped as retold, so
every one of the 140 instances per arm was honestly scorable.

Per probe (`+` recalled in all ten runs, `-` in none, a percentage in between):

| # | what it asks for | A | B | C | D |
| --- | --- | --- | --- | --- | --- |
| 1 | contract number in the constraints | + | + | + | - |
| 2 | coverage threshold | + | + | + | - |
| 3 | port in config.json | + | + | + | - |
| 4 | CODEOWNERS owner | + | 90% | + | + |
| 5 | error code of the failing run | + | + | + | 20% |
| 6 | constant at the head of a 70 KB file | + | 70% | + | - |
| 7 | sha at the tail of a 113 KB log | + | 50% | + | - |
| 8 | which function it edited | + | + | + | - |
| 9 | which file it edited | + | + | + | + |
| 10 | coverage the runner printed | + | + | + | + |
| 11 | a line in the middle of the log | - | - | 80% | - |
| 12 | another line in the middle of the log | + | - | + | - |
| 13 | a marker in the middle of the frozen file | - | 70% | + | - |
| 14 | what the code did before the edit | + | + | + | + |

The shape is what the design predicts rather than a flat win: the rules keep
every exact string they kept at all (no partial columns except where the text
was cut away entirely), and lose exactly the two probes buried in the middle of
bulk output. The summary is the mirror image — it can carry a fact out of the
middle of a 70 KB file (probe 13, 70%) because a summariser reads the whole
thing, but it paraphrases, so an exact sha survives only half the time.

## How much context each scheme left

Measured on one base transcript of this case (130 KB of messages, 126 KB of it
tool output):

| scheme | context left | time | cost |
| --- | --- | --- | --- |
| verbatim rules | 56 KB (−57%) | 33 ms | none |
| built-in summary | ~10 KB summary | ~60 s | one summarisation request |

So the summary keeps a fifth of what the rules keep — and answers nine points
fewer probes. Which of the two is the better trade depends on what the
remaining context is for: exact strings and commands, or the gist.

## Known defects of this benchmark — read before quoting it

1. **Each arm runs its own session.** Only the treatment is meant to differ,
   but the sessions do the work independently, so ordinary run-to-run
   variation lands inside the arm difference. Two gates now bound the damage:
   every session's edit is verified against a hash of the file (40 of 40
   landed in this round), and any probe whose answer the assistant had already
   retold in its own words is dropped unscored (none needed dropping).
2. **One synthetic case, ten runs.** The 9-point gap is nine points on this
   case, not a general property of either scheme.
3. **The two schemes are not compared at equal size.** The rules kept 56 KB
   and the summary ~10 KB. Read the result as "keeping five times more
   context, verbatim, bought nine points", not as "summarising is worse per
   byte".
4. **Probes 11–13 sit in the middle of bulk output.** No scheme that shrinks
   anything keeps them; they are here so the case cannot be read as designed
   around head-and-tail truncation.
5. The case says nothing about the long, messy sessions the 28.9% figure in
   the README came from.

## Three harnesses that measured nothing

Kept here because the failures are the useful part.

**Fork and resume.** The first harness ran the task once, then forked the
session three ways with `--fork-session` and compacted each fork. All arms
scored identically — including, in a later variant, the arm whose options
destroyed everything. A resumed session reloads its log, so a hook's
compaction never reached the probe turn: the treated arms were the control
wearing a different name. The live harness (`bench/live.sh`) sends task,
`/compact` and probes as three turns into one running process instead.

**Probes the assistant had already retold.** In the first live attempt the
assistant narrated what it found ("the port is 7412"), and no compaction
scheme edits assistant text, so those probes were answerable with zero tool
output. Two fixes: the task now demands silence, and the scorer drops any
probe whose answer appears in the pre-compaction narration.

**A sandbox inside the plugin directory.** The first live harness put the
sandbox repository under the plugin folder, and Claude Code refuses edits
inside a `--plugin-dir` as sensitive. The refusal hit only the two arms that
load the plugin, so in those arms the task often stopped at step 8 and the
mutation probes scored as forgotten. That is where the earlier 76%-against-83%
came from. The sandbox now lives in `~/.cache/verbatim-compaction-bench/repo`,
outside the plugin, and the edit gate makes a repeat of this visible instead of
silent.

All three failures share one shape: *the treatment had not actually happened,
and the numbers looked fine anyway.* Twice it was an arm built to fail that
caught it, once a gate that checks the world rather than the transcript.

## Reproducing

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 bench/live.sh 10   # ~70 min, 40 sessions
python3 bench/score.py bench/case-parser/probes.json bench/out-live
```
