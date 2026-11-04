# Changelog

## 0.2.0 — 2026-11-04

Makes compaction work on sessions that write a lot, and fixes a defect that
cost the model the results of parallel tool calls.

### Added

- **Rule 4, input budget** (`inputBudgetChars`, default `20000`; `0` in the
  plugin's settings, `Infinity` in the library, keeps every input whole). Call
  inputs are kept verbatim newest first; an older call keeps its record — tool,
  path, every short field — and only string fields longer than `keepUnderChars`
  (a file's content, edit strings, a heredoc) are cut to head and tail with a
  note, at any depth (MultiEdit `edits`). The record of a write is still never
  deleted.
- `CallDecision.inputChars`, `inputAction` (`keep` | `truncate_input`),
  `inputSavedChars`; `stats.inputsTruncated`; `cutInput`, `responseStarts`,
  `pinnedTailStart` exported. The decision log and `scripts/measure.ts` report
  input cuts as `input_over_budget`.
- `bench/case-writes`, `bench/case-writes-seq` and `bench/live-writes.sh`: a
  live benchmark of what a session still knows about a large file it wrote,
  with arms for 0.1.0, a keep-everything hook and a destroy-everything hook.
  Results in `bench/RESULTS-writes.md`.

### Fixed

- **Parallel tool calls lost after compaction.** The engine hands the hook one
  message per transcript entry, and the calls of one model response arrive as
  several entries, sometimes with results between them. A rebuilt entry got a
  new message id while its untouched siblings kept the old one, so the response
  was split out of order and the model could no longer read the siblings'
  results. The hook now hands back whole responses: once anything is rewritten,
  the region between the first message and the pinned tail is rebuilt as one
  assistant message per response with all its calls, then one message with all
  their results (a call seen while another is unanswered belongs to the open
  response); thinking-only entries there are dropped; and the pinned tail
  starts at a response start.

### Measured

- 18 real compactions of a write-heavy project: 25% removed by 0.1.0, 42% by
  0.2.0; compactions that fell back to the built-in summary: 6 → 0.
- Live, Claude Code 2.1.318, write-heavy case: 0.2.0 recalls 80% in every run,
  with sequential and with parallel calls (the ceiling of the case); the
  built-in summary 60–67%; 0.1.0 fell back to the summary in 3 of 3 sessions.

### Changed

- The default behaviour changes: inputs of older calls are now cut. Set
  `inputBudgetChars` to `0` in the plugin's settings for the 0.1.0 behaviour.
- Typechecks against the API Claude Code 2.1.318 writes; tested live on 2.1.318.

## 0.1.0 — 2026-09-20

First release: rules 1–3 (pinned, superseded, result budget), the
`session.compact` hook with fallback to the built-in summary below
`minReductionRatio`, the library API, and the `bench/case-parser` benchmark
(86% recalled against 77% for the built-in summary).
