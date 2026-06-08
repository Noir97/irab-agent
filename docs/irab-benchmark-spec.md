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
5. Record tool calls and normalized results so public benchmark examples can run
   in replay mode without exposing private services.

## External Evaluation Access

IRaB should support external evaluation without exposing internal service keys
or raw private data services.

The preferred access model has three layers:

1. Public replay mode: anyone can run the open-source harness against frozen
   fixtures and mock tool responses.
2. Controlled gateway mode: approved evaluators receive a short-lived,
   revocable IRaB gateway token after identity, organization, evaluation
   purpose, and model-scope review.
3. Hosted evaluation mode: for high-trust leaderboard, vendor, or paper
   collaborations, evaluators provide model endpoints, API keys, or containers,
   and IRaB runs the benchmark inside the project-controlled environment.

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
- Record/replay support so live evaluation runs can be converted into frozen
  reproducibility fixtures for reports.

For public technical reports and reproducible artifacts, frozen replay fixtures
are the default. Live gateway access is for controlled benchmarking only.

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
- Add record/replay mode for frozen benchmark fixtures.
- Add gateway-token access control for controlled external evaluation.
- Add a small task set covering company research, market data, event tracking,
  and source reconciliation.
- Add a batch runner using Pi JSON or RPC mode.
- Define initial metrics: task success, citation coverage, citation validity,
  tool selection quality, and answer faithfulness.

## Non-Goals

- Do not open-source private databases, credentials, raw proprietary content, or
  internal DeepTask/PaiWork service code.
- Do not fork Pi core unless the extension API cannot support a required
  benchmark behavior.
- Do not make the first version a full financial research product. The target is
  a reproducible benchmark harness.
