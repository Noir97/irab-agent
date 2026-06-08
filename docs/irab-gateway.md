# IRaB Evaluation Gateway

The gateway is the boundary between external evaluators and internal IRaB
sources. External users configure a single evaluator token:

```bash
IRAB_TOKEN=irab_...
```

The client extension uses that token for both the Rabyte-compatible model
provider and the five benchmark tools. Internal source credentials are deployed
only on the gateway service.

## Local MVP

Run the gateway from the repo root:

```bash
IRAB_GATEWAY_ADMIN_TOKEN=admin \
PAIPAI_BASE_URL=... \
PAIPAI_API_KEY=... \
GLOBAL_DATA_BASE_URL=... \
WEBSEARCH_SERVICE_URL=... \
RABYTE_BASE_URL=... \
RABYTE_API_KEY=... \
npm run irab:gateway
```

Optional deployment settings:

- `IRAB_GATEWAY_PORT`: HTTP port, default `7331`.
- `IRAB_GATEWAY_STATE_PATH`: token/application JSON state path.
- `IRAB_GATEWAY_AUDIT_PATH`: audit JSONL path.
- `IRAB_GATEWAY_RECORD_RAW=1`: write raw tool recordings.
- `IRAB_GATEWAY_RECORDING_DIR`: raw recording output directory.
- `IRAB_GATEWAY_DEFAULT_QPS`, `IRAB_GATEWAY_DEFAULT_CONCURRENCY`,
  `IRAB_GATEWAY_DEFAULT_TOTAL_REQUESTS`: default approved-token quota.

For local client testing against this service, set:

```bash
IRAB_TOKEN=irab_...
IRAB_GATEWAY_URL=http://127.0.0.1:7331
```

`IRAB_GATEWAY_URL` is a development override. Approved external evaluators
should normally only set `IRAB_TOKEN`.

## Token Flow

Create an application:

```bash
curl -sS http://127.0.0.1:7331/v1/token-applications \
  -H 'Content-Type: application/json' \
  -d '{
    "applicantName": "Evaluator",
    "email": "eval@example.com",
    "organization": "Example Fund",
    "purpose": "IRAB benchmark evaluation",
    "modelScope": ["allowed-model"],
    "toolScope": ["search_paipai", "search_global_data"],
    "taskSet": "task-1"
  }'
```

Approve it as an admin:

```bash
curl -sS http://127.0.0.1:7331/admin/token-applications/app_.../approve \
  -H 'Authorization: Bearer admin' \
  -H 'Content-Type: application/json' \
  -d '{
    "evaluatorId": "eval-1",
    "scopes": {
      "tools": ["search_paipai", "search_global_data"],
      "models": ["allowed-model"],
      "taskIds": ["task-1"]
    },
    "quota": {
      "qps": 2,
      "concurrency": 2,
      "totalRequests": 1000
    }
  }'
```

The approval response returns the plaintext `irab_...` token once. The gateway
stores only its hash.

## Gateway APIs

- `POST /v1/tools/search_paipai`
- `POST /v1/tools/search_global_data`
- `POST /v1/tools/search_cn_marketdata`
- `POST /v1/tools/search_web`
- `POST /v1/tools/fetch_web`
- `/v1/*` model proxy, including `/v1/chat/completions`

Tool responses return normalized evidence:

```json
{
  "tool": "search_paipai",
  "query": "BYD battery margin",
  "records": [
    {
      "source_id": "paipai-byd-margin",
      "title": "BYD 2025 Q4 margin review",
      "date": "2026-02-18",
      "publisher": "PaiPai Research",
      "url": "irab://source/paipai-byd-margin",
      "content": "...",
      "table": null,
      "metadata": {}
    }
  ],
  "source_ids": ["paipai-byd-margin"],
  "recording_id": "..."
}
```

## Audit and Recording

The gateway appends JSONL audit events for token applications, approvals,
revocations, model proxy calls, and tool calls. Tool-call audit includes token
id, evaluator id, tool name, query, source ids, and recording id.

Raw recordings are internal-only. When `IRAB_GATEWAY_RECORD_RAW=1`, tool calls
are written under `tmp/irab-recordings/raw/` by default. These files may contain
full source payloads and must not be committed or published. Public replay
fixtures must be produced by a separate sanitization/export step.
