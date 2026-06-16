# IRaB Agent Evaluation Harness

IRaB stands for Investment Research Agent Benchmark. This repository packages a
Pi-based agent harness for evaluating how models perform investment-research
tasks with controlled tools, source-grounded answers, and auditable artifacts.

This README is for external evaluators and readers who want to understand how to
run experiments, prepare task data, inspect outputs, and validate citations. The
underlying Pi agent monorepo notes are kept separately in
[docs/pi-agent-upstream.md](docs/pi-agent-upstream.md).

## What This Repository Provides

- A local Pi launcher configured for IRaB benchmark runs: [pi-test.sh](pi-test.sh).
- An IRaB finance-tools extension with five benchmark tools:
  [packages/irab-finance-tools](packages/irab-finance-tools).
- Runtime citation guidance for source-aware answers:
  [.pi/APPEND_SYSTEM.md](.pi/APPEND_SYSTEM.md).
- An optional guided research prompt preset for workflow-standardized runs:
  [.pi/IRAB_GUIDED_RESEARCH.md](.pi/IRAB_GUIDED_RESEARCH.md).
- A JSONL batch runner that stores answers, generated files, raw events,
  copied tool artifacts, and citation-source mappings:
  [scripts/irab-batch-example.mjs](scripts/irab-batch-example.mjs).
- A small example task set:
  [examples/irab-batch-tasks.jsonl](examples/irab-batch-tasks.jsonl).

For benchmark goals, tool definitions, and replay policy, see
[docs/irab-benchmark-spec.md](docs/irab-benchmark-spec.md).

## Access and Token Application

External evaluators need an IRaB gateway token. The public client repository
does not contain gateway admin endpoints, approval tooling, internal source
credentials, or token-management secrets.

To request access, submit the public token application form:

```text
http://irab.rabyte.cn/irab/apply
```

The application asks for:

- Name, organization, and contact email.
- Evaluation purpose.

After admin review, approved requests receive a one-time claim link by email.
Rejected requests receive a status update email. Open an approved claim link
once and store the displayed environment variables:

```bash
IRAB_GATEWAY_URL=http://irab.rabyte.cn/irab
IRAB_TOKEN=irab_...
```

For hosted evaluation, `IRAB_TOKEN` is the only required client-side secret.
`IRAB_GATEWAY_URL` is optional unless the claim page shows a non-default gateway
or you are using a local/self-hosted gateway.

Tokens are intended for controlled benchmark runs only. Do not commit `.env`,
tokens, raw recordings, or unsanitized tool outputs.

## Local Setup

Install dependencies without lifecycle scripts:

```bash
npm install --ignore-scripts
```

Create local environment configuration:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
IRAB_TOKEN=irab_...
# Optional for local/self-hosted gateway override:
IRAB_GATEWAY_URL=
IRAB_TOOL_TIMEOUT_MS=30000
IRAB_ARTIFACT_DIR=
```

Configure the model provider you want to evaluate through Pi. The recommended
path is to bring your own provider configuration, API key, or endpoint supported
by Pi, then verify that the model appears locally:

```bash
./pi-test.sh --list-models
```

Run one interactive benchmark session with the model under evaluation:

```bash
./pi-test.sh --model <provider>/<model>
```

Some evaluation tokens may also expose hosted Rabyte-compatible models. If that
scope is enabled, they appear under the `rabyte` provider and can be selected in
the same `provider/model` form:

```bash
./pi-test.sh --list-models | rg rabyte
./pi-test.sh --model rabyte/wangsu-claude-opus-4-6
```

`pi-test.sh` defaults `PI_SKIP_VERSION_CHECK=1` so benchmark startup output stays
pinned to the checked-out Pi version and does not show update notifications.

## Available IRaB Tools

The benchmark tools are exposed through the IRaB extension and route through the
gateway with `IRAB_TOKEN`.

| Tool | Purpose |
| --- | --- |
| `search_research_corpus` | Semantic search over approved unstructured investment-research materials such as reports, announcements, meeting notes, commentary, and authorized user-provided materials. |
| `search_global_market_data` | Retrieve structured global-market data for HK/US equities, indices, ETFs, FX, crypto, commodities, filings, and related data. |
| `search_china_market_data` | Retrieve China macro, rates, industry, A-share, and domestic index data. |
| `search_public_web` | Search public web sources when public or current evidence is needed. |
| `read_public_webpage` | Fetch and read a specific URL returned by search or supplied by a task. |

Tool results expose visible citation markers such as `[source:3]`. The answer
must copy these markers inline after the supported claim.

## Citation and Report Contract

Benchmark answers must be source-grounded:

- Use `[source:x]` exactly as shown by the tool result.
- Place citations directly after the sentence, bullet, or table cell they
  support.
- Do not invent source IDs.
- If evidence is unavailable, say the claim is unsupported by available
  evidence.
- For complex questions or longer analysis, the agent should write a Markdown
  report file in the current working directory and keep the final chat reply
  brief, referencing that file. The report must preserve inline citations.

This behavior is enforced by [.pi/APPEND_SYSTEM.md](.pi/APPEND_SYSTEM.md).

The batch runner also supports prompt modes:

- `raw`: the default existing behavior. It loads only the base IRaB
  source-grounding prompt.
- `guided-research`: additionally loads
  [.pi/IRAB_GUIDED_RESEARCH.md](.pi/IRAB_GUIDED_RESEARCH.md), which standardizes
  retrieval depth, date/definition handling, cross-checking, calculations,
  table usage, and self-contained final answers.

## Prepare Task Data

Batch input is JSONL: one task per line. Each line must be a JSON object.

Required fields:

- `id`: stable task id. Used as the result directory name after sanitization.
- `prompt`: raw benchmark question sent to the agent. Keep this as the user
  question being evaluated, not as harness instructions.

Optional fields:

- `model`: per-task model override, for example `<provider>/<model>`.
- `name`: Pi session display name.
- `promptMode`: optional per-task prompt mode override, either `raw` or
  `guided-research`.
- `appendSystemPrompt`: extra task-specific instructions appended after the
  default IRaB source-grounding prompt. Use this only for task-local protocol
  changes that are not already covered by `.pi/APPEND_SYSTEM.md`.

Example:

```jsonl
{"id":"cn-brokerage-policy","prompt":"最近影响中国券商板块估值的主要政策因素是什么？"}
{"id":"hk-tech-earnings","model":"<provider>/<model>","prompt":"港股互联网龙头最近一轮业绩中，市场最关注的增长和利润率问题是什么？"}
```

Task-writing recommendations:

- Keep the task prompt in its natural user-question form.
- Do not repeat harness-level instructions such as "use IRaB tools", "retrieve
  evidence", or "cite each fact with `[source:x]`"; these are injected by
  `.pi/APPEND_SYSTEM.md`.
- Include answer-format requirements only when they are part of the benchmark
  question being evaluated, for example asking for a memo or comparison table.
- Keep one evaluation question per task unless multi-hop reasoning is being
  measured intentionally.
- Do not include secrets or raw private source material in prompts.
- Keep benchmark task files under source control only if they are safe to share.
  Private task sets can be passed by absolute or relative path outside the repo.

## Run a Batch

Basic run:

```bash
node scripts/irab-batch-example.mjs --input examples/irab-batch-tasks.jsonl
```

Choose a model:

```bash
node scripts/irab-batch-example.mjs \
  --input examples/irab-batch-tasks.jsonl \
  --model <provider>/<model>
```

Set output directory, concurrency, and timeout:

```bash
node scripts/irab-batch-example.mjs \
  --input examples/irab-batch-tasks.jsonl \
  --out tmp/irab-batch-runs/review-run \
  --concurrency 10 \
  --timeout-ms 900000
```

Run with the workflow-standardized guided research prompt:

```bash
node scripts/irab-batch-example.mjs \
  --input examples/irab-batch-tasks.jsonl \
  --model <provider>/<model> \
  --prompt-mode guided-research
```

Dry-run command construction and output layout without calling Pi:

```bash
node scripts/irab-batch-example.mjs \
  --input examples/irab-batch-tasks.jsonl \
  --out tmp/irab-batch-runs/dry-run \
  --dry-run
```

Batch defaults:

- Default model: the runner's hosted-model convenience default. For external
  evaluation, pass `--model` explicitly so the run records the intended
  provider/model.
- Default concurrency: `10`.
- Default prompt mode: `raw`.
- Default output directory: `tmp/irab-batch-runs/<timestamp>`.
- Each task runs in an isolated workspace under its result directory.
- The runner explicitly loads the repo IRaB extension and
  `.pi/APPEND_SYSTEM.md`, even though the task working directory is isolated.
- In `guided-research` mode, the runner appends
  `.pi/IRAB_GUIDED_RESEARCH.md` after `.pi/APPEND_SYSTEM.md`. Task-level
  `appendSystemPrompt` content is appended last.

## Inspect Results

The batch runner writes:

```text
tmp/irab-batch-runs/<timestamp>/
  run.json
  tasks/
    <task-id>/
      answer.md
      result.json
      events.jsonl
      sources.json
      workspace/
      generated-files/
      artifacts/
        raw/
        files/
```

Top-level files:

- `run.json`: input path, model, concurrency, dry-run flag, task count, and
  output layout. It also records the default prompt mode used for the run.

Per-task files:

- `answer.md`: final assistant text from Pi JSON mode.
- `events.jsonl`: raw Pi JSON events captured from stdout.
- `result.json`: task metadata, command argv, exit code, stderr, generated-file
  list, referenced generated files, parse errors, prompt mode, and source/tool
  counts.
- `sources.json`: citation evidence map for visible `[source:x]` markers.
- `workspace/`: task working directory used while Pi runs.
- `generated-files/`: files the agent wrote in the task workspace, such as
  Markdown reports.
- `artifacts/raw/`: tool artifacts written during the run.
- `artifacts/files/`: copied artifact files referenced from `sources.json`.

If a task fails quickly, start with `result.json`:

- `exitCode`: non-zero means Pi or the task process failed.
- `stderr`: startup, model, gateway, or runtime errors.
- `jsonParseErrors`: non-empty means stdout contained non-JSON lines that could
  not be parsed as Pi events.
- `sourceCount` and `toolCallCount`: quick check that IRaB tool results were
  parsed.

## Validate Citation Trustworthiness

Use `sources.json` to validate whether citations in the answer can be traced
back to gateway evidence.

For each cited marker in `answer.md` or a generated report:

1. Find the matching entry in `sources.json` under `citations[]`.
2. Check `citation`, for example `[source:7]`.
3. Check `evidenceSourceId`, which maps the visible marker back to the gateway
   record's `source_id`.
4. Inspect `record` for title, date, publisher, URL, content, table, and
   metadata.
5. If `copiedArtifactFile` is present, open the copied artifact under
   `artifacts/files/`.
6. If a report file is referenced in `answer.md`, inspect the copy under
   `generated-files/`.

Useful quick checks:

```bash
# Show task status and source counts.
node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log({exitCode:r.exitCode, sourceCount:r.sourceCount, toolCallCount:r.toolCallCount, generatedFiles:r.generatedFiles?.length});' \
  tmp/irab-batch-runs/<timestamp>/tasks/<task-id>/result.json

# Print citation markers and source ids.
node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const c of s.citations) console.log(c.citation, c.evidenceSourceId, c.title);' \
  tmp/irab-batch-runs/<timestamp>/tasks/<task-id>/sources.json
```

## Reproducibility and Data Safety

The current public harness is live-gateway first. Static replay fixtures are not
enabled because benchmark replay must be generated from recorded live runs only
after explicit review and sanitization.

Rules for evaluation data:

- Do not commit raw live recordings, `.env`, tokens, gateway responses, copied
  proprietary artifacts, or unsanitized run outputs.
- Keep raw runs under ignored local paths such as `tmp/irab-batch-runs/` or
  `tmp/irab-recordings/`.
- Public reproduction packages should use sanitized fixtures only after a
  maintainer-approved export step.
- Preserve visible `[source:x]` markers in sanitized fixtures so citation
  behavior remains measurable.

## Troubleshooting

Expected model does not appear in `--list-models`:

- Check the provider API key or endpoint configuration used by Pi.
- If using hosted Rabyte-compatible models, check that `.env` contains an
  `IRAB_TOKEN` with model scope.
- Run from this repo or use `pi-test.sh`, which loads the local checkout.
- In batch mode, use the provided runner so repo extensions are loaded
  explicitly for isolated workspaces.

`Model "..." not found`:

- Run `./pi-test.sh --list-models`.
- Use the `provider/model` form shown by the model list.
- Check `result.json` for the actual argv used by the batch task.

Task output is empty:

- Inspect `tasks/<id>/result.json`.
- If `exitCode` is non-zero and `events.jsonl` is empty, the failure happened
  before Pi emitted JSON events.
- `stderr` usually contains the model, token, gateway, or startup error.

Tool calls fail or time out:

- Check `IRAB_TOOL_TIMEOUT_MS`.
- Confirm the token has access to the requested tool scope.
- Lower `--concurrency` if the gateway quota is tight.

Unexpected Pi update notification:

- `pi-test.sh` and the batch runner default `PI_SKIP_VERSION_CHECK=1`.
- If needed, export `PI_SKIP_VERSION_CHECK=1` explicitly in the shell.

## Repository Map

| Path | Purpose |
| --- | --- |
| `.pi/APPEND_SYSTEM.md` | Runtime source-grounding and report-writing guidance. |
| `.pi/IRAB_GUIDED_RESEARCH.md` | Optional guided research prompt preset. |
| `.pi/extensions/irab-finance-tools/index.ts` | Project-local Pi extension entrypoint. |
| `packages/irab-finance-tools/src/index.ts` | IRaB model/tool registration and gateway client. |
| `examples/irab-batch-tasks.jsonl` | Minimal JSONL batch input example. |
| `scripts/irab-batch-example.mjs` | Batch runner and result collector. |
| `docs/irab-benchmark-spec.md` | Benchmark goals, access model, replay policy, and citation contract. |
| `docs/pi-agent-upstream.md` | Upstream Pi monorepo notes moved out of the IRaB-focused README. |

## Development Checks

After code changes, run:

```bash
npm run check
```

For local package installation, always use:

```bash
npm install --ignore-scripts
```

## License

MIT
