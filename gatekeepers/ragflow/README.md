# gatekeepers/ragflow

Preset `http`-kind Gatekeeper 接入包 (design doc §7.5, §7.10; docs/development-tasks.md S2.5) for
a RAGFlow deployment's REST API.

## Which build (task brief: "a small TS package … or a config-only instance … say which")

A small TS package with its own `src/index.ts`, **not** `@nexttime/gatekeeper-base`'s env-driven
`main()`. `main()`'s `http` path is otherwise exactly what this gate needs (`HttpTransport` +
`SharedEnvCredentialResolver`) — the reason it isn't reused verbatim is env var *naming*, not
transport logic: `main()` always reads `GATE_TARGET_BASE_URL` for the base URL and always
constructs `SharedEnvCredentialResolver({env})` (no `name` option — always
`GATE_CREDENTIAL_DEFAULT`). This task's own env contract names them `RAGFLOW_BASE_URL` /
`GATE_CREDENTIAL_RAGFLOW_API_KEY` instead, so `secrets/gatekeeper-ragflow.env` is self-documenting
without relying on a generic `GATE_CREDENTIAL_DEFAULT` name that would look identical across any
other gate reusing `main()`. `src/index.ts` composes `GatekeeperBase` + `createGatekeeperServer` +
`HttpTransport` + `SharedEnvCredentialResolver({name: 'RAGFLOW_API_KEY'})` directly — the same
"anything more specific" escape hatch the base package's own README documents, applied here only
to parameterize env var names, not to change transport behavior.

## Manifest (`manifest.json`)

REST API shapes below were verified against RAGFlow's public HTTP API reference (`docs/references/
http_api_reference.md`, upstream `infiniflow/ragflow`), not written from memory.

| Operation | mode | blast_radius | auto_approvable | HTTP | notes |
|---|---|---|---|---|---|
| `kb.list` | observe | low | true | `GET /api/v1/datasets` | → `KnowledgeBase` facts |
| `kb.documents` | observe | low | true | `GET /api/v1/datasets/{dataset_id}/documents` | → `Document` facts |
| `retrieve` | observe | low | true | `POST /api/v1/retrieval` | read-only despite the HTTP verb — no side effects |
| `document.upload` | execute | medium | **false** | `POST /api/v1/datasets/{dataset_id}/documents?type=empty` | see "known limitation" below |
| `document.parse` | execute | low | **false** | `POST /api/v1/datasets/{dataset_id}/chunks` | starts an async parse job |

Every response follows RAGFlow's own `{code, data}` envelope; `result_mapping.jmes_path` is
written against the whole response (`data[*]` / `data.docs[*]`), not just its `data` field.

### Known limitation: `document.upload` cannot send real file content

RAGFlow's real "upload a file" mode (`?type=local`) is `multipart/form-data`
(`file=@path/to/file`). `@nexttime/gatekeeper-base`'s `HttpTransport` only ever sends a JSON body
(`kinds/http.ts` — every non-path param goes into `JSON.stringify(remaining)`), so it cannot
express a multipart request. This gate's `document.upload` therefore only supports RAGFlow's
`?type=empty` mode — creating a named placeholder Document with **no** file content — not a real
file upload. A real multipart upload would need either multipart support added to
`@nexttime/gatekeeper-base`'s `HttpTransport` (a base-package change, out of this task's scope) or
a custom `Transport` for this gate (the way `gatekeepers/docker` has one) that does its own
`fetch` with a `FormData` body. Do not claim this operation uploads real files without that
follow-up.

### Known limitation: RAGFlow's own `{code, data}` error envelope is invisible to the protocol

`HttpTransport` only treats a non-2xx HTTP status as an error; RAGFlow signals its own
application-level errors with `code != 0` inside a `200 OK` body. A failed call (e.g. an unknown
`dataset_id`) therefore comes back as a *successful* `observe`/`apply` with `data.code` non-zero
and (for the mapped operations) an empty `observedFacts` array — see
`src/result-mapping.test.ts`'s "error response … produces no facts" case. A caller must inspect
the raw `data.code`/`data.message` itself; the gate protocol does not surface it as an error.

## Credentials

`SharedEnvCredentialResolver({name: 'RAGFLOW_API_KEY'})` reads `GATE_CREDENTIAL_RAGFLOW_API_KEY`
from the gate's own env (`docker-compose.yml`'s `env_file: … secrets/gatekeeper-ragflow.env`) and
treats it as an opaque bearer token — `HttpTransport` sends
`Authorization: Bearer <GATE_CREDENTIAL_RAGFLOW_API_KEY>`, RAGFlow's own auth convention.

## Env

| Var | Required | Notes |
|---|---|---|
| `RAGFLOW_BASE_URL` | yes | e.g. `http://ragflow:9380` — never hardcoded, never committed |
| `GATE_CREDENTIAL_RAGFLOW_API_KEY` | yes | RAGFlow API key |
| `GATE_DATA_DIR` | no (`./data`) | idempotency store JSON file |
| `GATE_MANIFEST_FILE` | no (bundled `manifest.json`) | override without rebuilding the image |
| `GATE_PORT` | no (`8083`) | |
| `GATE_BIND_ADDR` | no (`0.0.0.0`) | |

## Testing

`src/manifest.test.ts` validates `manifest.json` against `OperationSchema` and the classification
table above. `src/result-mapping.test.ts` maps sample RAGFlow API responses through this
manifest's own `result_mapping` declarations via `@nexttime/gatekeeper-base`'s
`applyResultMapping` — no network. `src/index.test.ts` covers `buildRagflowGate`'s wiring
(missing `RAGFLOW_BASE_URL` throws; `describe_operations` lists every Operation).
