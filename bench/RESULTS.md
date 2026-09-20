# Benchmark: does the assistant still know what it needs after compaction?

Run on 2026-09-20, Claude Code 2.1.278, case `bench/case-parser`
(a sandbox repository with known ground truth, rebuilt from `setup.sh` before
every session, so anyone can reproduce this).

**Headline: this benchmark gives the plugin no claim to superiority. On this
case the built-in summary retained more of what was asked for than the rules
did, and it compressed harder. What the rules win is speed, cost, exactness
and the fact that nothing leaves the machine — measured separately, below.**

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

## Result, three runs, 14 probes each

| arm | probes recalled | |
| --- | --- | --- |
| C | 41/42 | **98%** no compaction |
| B | 35/42 | **83%** built-in summary |
| A | 32/42 | **76%** verbatim rules |
| D | 11/42 | **26%** rules set to destroy |

Per probe (`+` recalled in every run, `-` in none, `±` mixed):

| # | what it asks for | A | B | C | D |
| --- | --- | --- | --- | --- | --- |
| 1 | contract number in the constraints | + | + | + | - |
| 2 | coverage threshold | + | + | + | - |
| 3 | port in config.json | + | + | + | - |
| 4 | CODEOWNERS owner | + | + | + | + |
| 5 | error code of the failing run | + | + | + | ± |
| 6 | constant at the head of a 70 KB file | + | + | + | - |
| 7 | sha at the tail of a 113 KB log | ± | ± | + | - |
| 8 | which function it edited | ± | + | + | ± |
| 9 | which file it edited | ± | + | + | ± |
| 10 | coverage the runner printed | + | + | + | - |
| 11 | a line in the middle of the log | - | - | ± | - |
| 12 | another line in the middle of the log | ± | - | + | - |
| 13 | a marker in the middle of the frozen file | - | + | + | - |
| 14 | what the code did before the edit | + | + | + | ± |

## How much context each scheme left

Measured on one base transcript of this case (130 KB of messages, 126 KB of it
tool output):

| scheme | context left | time | cost |
| --- | --- | --- | --- |
| verbatim rules | 56 KB (−57%) | 33 ms | none |
| built-in summary | ~10 KB summary | ~60 s | one summarisation request |

So the summary kept a fifth of what the rules kept and still answered more
probes. That is the finding, and it is not the flattering one.

## Known defects of this benchmark — read before quoting it

1. **Each arm runs its own session.** Only the treatment is meant to differ,
   but the sessions do the work independently, so ordinary run-to-run
   variation lands inside the arm difference. One concrete instance: in run 1
   of arm A the edit was refused, so probes 8 and 9 there measured a failed
   task, not a lost memory. A fix — gate every run on "the file really
   changed" and drop the mutation probes when it did not — is not implemented
   yet.
2. **One case, three runs, 42 probe-instances per arm.** A gap of one probe is
   noise. The A-versus-B gap is three probes; treat it as "no evidence the
   rules retain more", not as a precise 7 points.
3. **Probes 11–13 sit in the middle of bulk output.** No scheme that shrinks
   anything keeps them; they are here so the case cannot be read as designed
   around head-and-tail truncation.
4. The case is synthetic. It says nothing about the long, messy sessions the
   28.9% figure in the README came from.

## Two earlier harnesses that measured nothing

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

Both failures share one shape: *the treatment had not actually happened, and
the numbers looked fine anyway.* A control arm that must fail is the only
thing that caught it.

## Reproducing

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 bench/live.sh 3    # ~20 min, 12 sessions
python3 bench/score.py bench/case-parser/probes.json bench/out-live
```
