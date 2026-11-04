# Benchmark: a write-heavy session (0.2.0 input budget vs 0.1.0)

Run on 2026-11-04, Claude Code 2.1.318, model `sonnet`, case `bench/case-writes`,
harness `bench/live-writes.sh`, three runs × five arms. All 15 sessions passed
the edit gate (`check.mjs`: the 800-row table was written correctly).

The session reads a brief, runs a generator (800 rows, 21 KB), **writes** the
rows into `src/table.ts` (35 KB of Write input), reads a 42 KB build log and two
small files, runs a check, then `/compact`, then 10 probes with every tool off.

| arm | treatment | how it compacted | recalled |
| --- | --- | --- | --- |
| C | no compaction | — | 30/30 **100%** |
| A | plugin 0.2.0, defaults | rules, 3 of 3 (90.7k → 22.8k tokens, ~25 ms) | 18/30 **60%** |
| B | plugin off | built-in summary (~10 s, one model call) | 18/30 **60%** |
| O | plugin 0.1.0, defaults | **built-in summary, 3 of 3** — rules freed < `minReductionRatio` | 16/30 **53%** |
| D | 0.2.0 set to destroy | rules | 6/30 **20%** |

| # | probe | A | B | C | D | O |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ticket in the brief | + | + | + | - | + |
| 2 | ROW_0001 (head of the write) | + | + | + | - | 67% |
| 3 | ROW_0200 (middle of the write) | - | - | + | - | - |
| 4 | ROW_0400 (middle of the write) | - | - | + | - | - |
| 5 | ROW_0800 (tail of the write) | + | + | + | - | 67% |
| 6 | which file it created | + | + | + | + | + |
| 7 | sha at the tail of the log | 33% | - | + | - | - |
| 8 | region in config.json | 33% | + | + | - | + |
| 9 | release train in notes | 33% | + | + | - | + |
| 10 | code the check printed | + | - | + | + | - |

## What it says

1. **0.1.0 does not compact a write-heavy session at all**: in every run the
   rules freed under 20% and the hook handed over to the built-in summary. This
   is the failure the input budget was made for, reproduced live.
2. **0.2.0 compacts it by rules** in every run, to a quarter of its size, in
   milliseconds and without a model call, and recalls as much as the summary
   (60% = 60%) with a different shape: exact strings at the head and tail of
   the write and the last result (probe 10: 3/3 against 0/3) survive; the middle
   of the write is lost — by both schemes, as designed.
3. **Probes 7–9 in arm A are a defect to look into, not a cut.** In all three A
   sessions the region, the release train and the sha were in the context after
   compaction (verified in the session logs: the 66-, 57- and 45 605-character
   results were kept whole), yet in two runs the model answered UNKNOWN. These
   three results came from three parallel calls; whether the engine reassembles
   parallel calls after a hook compaction in a way the model reads poorly is
   not established. Until it is, 60% for A is a lower bound.

## Limits

Three runs, one synthetic case, one model. Arm D and the edit gate held, so the
probes measure retention; the 7-point gap between A and O is O falling back to
the summary, not a property of the rules.
