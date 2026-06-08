# IRaB Benchmark Spec and Goals

IRaB stands for Investment Research Agent Benchmark. This repository is a
benchmark harness for measuring how well coding-capable models can operate as
financial research agents when they are given controlled research tools,
evidence, and citation requirements.

## Objectives

- Provide a minimal, open-source agent harness for financial research tasks.
- Integrate investment-research tools through a narrow extension layer instead
  of modifying Pi's core runtime.
- Require source-aware answers so benchmark outputs can be audited.
- Support reproducible benchmark runs for the IRaB technical report.
- Keep internal data services, credentials, and proprietary content outside the
  public repository.

## Target Tool Set

Tier 1 tools are the primary benchmark capabilities:

- `search_paipai`: search internal financial research evidence such as reports,
  announcements, meeting notes, comments, and personal knowledge sources.
- `search_global_data`: retrieve structured global-market data for HK/US
  equities, indices, ETFs, FX, crypto, commodities, filings, and related data.
- `search_cn_marketdata`: retrieve China macro, rates, industry, A-share, and
  domestic index data.

Tier 2 tools are supporting public-web capabilities:

- `search_web`: search public internet sources when internal evidence is
  insufficient or current public information is required.
- `fetch_web`: fetch and read a specific URL returned by search or supplied in a
  benchmark task.

## Architecture Direction

The preferred implementation is:

1. Keep Pi as the agent runtime, model interface, TUI, JSON mode, and session
   recorder.
2. Add an IRaB Pi extension package that registers the benchmark tools.
3. Route tool calls to a private tool gateway during internal runs.
4. Normalize every tool response into a stable evidence format:
   `source_id`, `title`, `date`, `publisher`, `url`, `content`, `table`, and
   `metadata`.
5. Keep live tool execution separate from reproducibility artifacts. Replay data
   must be generated from recorded live runs only after an explicit sanitization
   and export step.

## External Evaluation Access

IRaB should support external evaluation without exposing internal service keys
or raw private data services.

The preferred access model has three layers:

1. Controlled gateway mode: approved evaluators receive a short-lived,
   revocable IRaB gateway token after identity, organization, evaluation
   purpose, and model-scope review.
2. Hosted evaluation mode: for high-trust leaderboard, vendor, or paper
   collaborations, evaluators provide model endpoints, API keys, or containers,
   and IRaB runs the benchmark inside the project-controlled environment.
3. Sanitized replay mode: public or external reproducibility runs use exported
   fixtures created from raw live recordings after review and sanitization.

Gateway tokens must never be raw internal DeepTask, PaiPai, database, search, or
market-data credentials. They should only authorize calls through an IRaB
Evaluation Gateway with these controls:

- Tool whitelist limited to benchmark tools such as `search_paipai`,
  `search_global_data`, `search_cn_marketdata`, `search_web`, and `fetch_web`.
- Scope binding by evaluator, organization, benchmark task set, model family,
  and optional `task_id`.
- Expiration, quota, QPS, concurrency, and total-budget limits.
- Full audit logging for tool name, query, task id, evaluator id, returned
  source ids, and run metadata.
- Sensitive content redaction or summarized evidence output where full text
  export is not required.
- One-step token revocation.
- Raw recording and sanitized replay export support so live evaluation runs can
  be converted into reviewed reproducibility fixtures for reports.

Live gateway access is for controlled benchmarking only. Public technical
reports and reproducible artifacts must use sanitized fixtures, not direct live
recordings.

## Recording and Sanitized Replay

The current runtime does not ship static replay fixtures. Hand-authored replay
data is not sufficient for benchmark reproducibility, and direct live-output
replay can expose sensitive internal content.

The target workflow is:

1. Run live benchmark tasks against configured internal tools.
2. Save raw recordings locally under ignored paths such as
   `tmp/irab-recordings/raw/`. Raw recordings may include full tool responses,
   normalized records, request parameters, source metadata, generated CSV files,
   and image artifacts.
3. Treat raw recordings as internal-only evidence. They must not be committed,
   published, or sent to external evaluators.
4. Run an explicit sanitization/export step that converts raw recordings into
   reviewed replay fixtures.
5. Use sanitized fixtures for public replay, external evaluation packages,
   report reproduction, and CI regression tests.

The sanitizer should apply a whitelist policy:

- Replace internal URLs, article ids, request ids, account ids, user ids, and
  organization names with stable synthetic identifiers such as `irab://...`.
- Drop or redact `metadata.source_data` unless a field is explicitly approved.
- Summarize, rewrite, or trim long proprietary text while preserving the factual
  signal required by the benchmark task.
- Limit table rows and columns to the minimal task-relevant subset.
- Exclude CSV and image artifacts by default unless they pass manual review.
- Add provenance metadata such as `sanitized: true`, raw recording hash, export
  time, sanitizer version, and reviewer identity.
- Preserve the visible `[source:x]` citation markers and the agent-visible tool
  result shape so replay tests measure the same citation behavior.

## Citation Contract

All benchmark answers should cite evidence inline by copying the visible
`[source:x]` marker from tool output.

- The `x` value must be the numeric marker shown in the tool result.
- Citations must appear directly after the sentence, bullet, or table cell that
  uses the evidence.
- Sources should not be collected only at the end of the answer.
- When evidence is unavailable, the answer should say so explicitly instead of
  inventing a source.

## MVP Milestones

- Add baseline repo identity, spec, and citation prompt.
- Implement an `irab-finance-tools` Pi extension with the five target tools.
- Build a private HTTP tool gateway adapter.
- Add raw live-run recording under ignored local paths.
- Add a sanitizer/export pipeline for reviewed replay fixtures.
- Add sanitized fixture replay only after the export contract is defined.
- Add gateway-token access control for controlled external evaluation.
- Add a small task set covering company research, market data, event tracking,
  and source reconciliation.
- Add a batch runner using Pi JSON or RPC mode.
- Define initial metrics: task success, citation coverage, citation validity,
  tool selection quality, and answer faithfulness.

## Non-Goals

- Do not open-source private databases, credentials, raw proprietary content, or
  internal DeepTask/PaiWork service code.
- Do not commit raw live recordings or unsanitized tool outputs.
- Do not treat hand-authored fixtures as authoritative benchmark replay data.
- Do not fork Pi core unless the extension API cannot support a required
  benchmark behavior.
- Do not make the first version a full financial research product. The target is
  a reproducible benchmark harness.
