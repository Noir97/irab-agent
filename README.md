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

To request access, contact the IRaB maintainers through the evaluation channel
provided for your collaboration. Include:

- Name, organization, and contact email.
- Evaluation purpose, expected publication or internal-use scope, and time
  window.
- Model families or endpoints you plan to evaluate.
- Expected task volume, concurrency, and rough budget.
- Whether you need hosted evaluation, live gateway access, or sanitized replay
  artifacts.

Approved evaluators receive:

- `IRAB_TOKEN`: required. A scoped, revocable gateway token.
- `IRAB_GATEWAY_URL`: optional. Only needed for local or self-hosted gateway
  overrides. Hosted evaluation usually uses the default gateway URL embedded in
  the client.

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

Verify that Rabyte models are visible:

```bash
./pi-test.sh --list-models | rg rabyte
```

Run one interactive benchmark session:

```bash
./pi-test.sh --model rabyte/wangsu-claude-opus-4-6
```

Useful alternative model example:

```bash
./pi-test.sh --model rabyte/kimi-k2.6-thinking
```

`pi-test.sh` defaults `PI_SKIP_VERSION_CHECK=1` so benchmark startup output stays
pinned to the checked-out Pi version and does not show update notifications.

## Available IRaB Tools

The benchmark tools are exposed through the IRaB extension and route through the
gateway with `IRAB_TOKEN`.

| Tool | Purpose |
| --- | --- |
| `search_paipai` | Search internal investment-research evidence such as reports, announcements, meeting notes, comments, and personal knowledge sources. |
| `search_global_data` | Retrieve structured global-market data for HK/US equities, indices, ETFs, FX, crypto, commodities, filings, and related data. |
| `search_cn_marketdata` | Retrieve China macro, rates, industry, A-share, and domestic index data. |
| `search_web` | Search public web sources when public or current evidence is needed. |
| `fetch_web` | Fetch and read a specific URL returned by search or supplied by a task. |

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

## Prepare Task Data

Batch input is JSONL: one task per line. Each line must be a JSON object.

Required fields:

- `id`: stable task id. Used as the result directory name after sanitization.
- `prompt`: benchmark prompt sent to the agent.

Optional fields:

- `model`: per-task model override, for example
  `rabyte/kimi-k2.6-thinking`.
- `name`: Pi session display name.
- `appendSystemPrompt`: extra task-specific instructions appended after the
  default IRaB source-grounding prompt.

Example:

```jsonl
{"id":"cn-brokerage-policy","prompt":"请使用 IRaB 工具检索并回答：最近影响中国券商板块估值的主要政策因素是什么？要求给出 3-5 条要点，并在每条事实后使用 [source:x] 行内引用。"}
{"id":"hk-tech-earnings","model":"rabyte/kimi-k2.6-thinking","prompt":"请使用 IRaB 工具检索并回答：港股互联网龙头最近一轮业绩中，市场最关注的增长和利润率问题是什么？请写成简短研究备忘录，并使用 [source:x] 行内引用。"}
```

Task-writing recommendations:

- Make the expected answer format explicit: bullets, memo, table, or report.
- Ask for inline `[source:x]` citations in the prompt when factual claims are
  required.
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
  --model rabyte/kimi-k2.6-thinking
```

Set output directory, concurrency, and timeout:

```bash
node scripts/irab-batch-example.mjs \
  --input examples/irab-batch-tasks.jsonl \
  --out tmp/irab-batch-runs/review-run \
  --concurrency 10 \
  --timeout-ms 900000
```

Dry-run command construction and output layout without calling Pi:

```bash
node scripts/irab-batch-example.mjs \
  --input examples/irab-batch-tasks.jsonl \
  --out tmp/irab-batch-runs/dry-run \
  --dry-run
```

Batch defaults:

- Default model: `rabyte/wangsu-claude-opus-4-6`.
- Default concurrency: `10`.
- Default output directory: `tmp/irab-batch-runs/<timestamp>`.
- Each task runs in an isolated workspace under its result directory.
- The runner explicitly loads the repo IRaB extension and
  `.pi/APPEND_SYSTEM.md`, even though the task working directory is isolated.

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
  output layout.

Per-task files:

- `answer.md`: final assistant text from Pi JSON mode.
- `events.jsonl`: raw Pi JSON events captured from stdout.
- `result.json`: task metadata, command argv, exit code, stderr, generated-file
  list, referenced generated files, parse errors, and source/tool counts.
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

No Rabyte models appear in `--list-models`:

- Check that `.env` contains `IRAB_TOKEN`.
- Run from this repo or use `pi-test.sh`, which loads the local checkout.
- In batch mode, use the provided runner so repo extensions are loaded
  explicitly for isolated workspaces.

`Model "..." not found`:

- Run `./pi-test.sh --list-models | rg rabyte`.
- Use the `provider/model` form shown by the runner examples, such as
  `rabyte/wangsu-claude-opus-4-6`.
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
