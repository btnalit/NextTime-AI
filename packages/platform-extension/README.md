# @nexttime/platform-extension

The single shared pi extension (design doc §7.4). `NEXTTIME_MODE` picks the behavior: `entry`
(resident entry agent), `worker` (one-shot Worker container) and `interactive` (a pi client outside
the platform) are all implemented.

## Env vars

| Var | Required | Meaning |
|-----|----------|---------|
| `NEXTTIME_MODE` | yes | `entry`\|`worker`\|`interactive`; anything else throws on activation. |
| `KERNEL_URL` | all modes | Base URL of the kernel, no trailing slash. |
| `CAPABILITY_HANDLE` | interactive | Bearer credential (the member's `issue_handle` JWT); never logged. In an entry / worker container it is only the `source-bound` marker pi's `models.json` resolves, and this extension never reads it (see below). |
| `WORKSPACE_ID` | entry, worker | Informational; the kernel derives the real workspace from the Handle. Not read in `interactive`. |
| `TASK_ID` | worker | The Task this one-shot Worker runs (injected by worker-supervisor). |
| `NEXTTIME_CORRELATION_ID` | no (worker) | Correlation id inherited from the delegating call; the kernel mints one when absent. |
| `NEXTTIME_TURN_ID` | no (entry) | Seeds the turn id before the first `input` event supplies a fresher one. |

## Modes

- **entry**: registers the S1 graph observe tools (`get_object`/`traverse`/`search`/`explain`/
  `get_task`, from `@nexttime/shared`'s registry); injects context via pi's `context` event
  (`get_entry_context`); correlates each pi run with a platform Turn (`agent_start`/`agent_end`/
  `agent_settled`) and reports it (`report_turn`) once settled. `find_workers`/`invoke_worker`
  land in S2.7/S2.4. Per-prompt turn id: the caller prefixes the prompt text with
  `<!--nexttime:turn_id=<id>-->\n`, which the `input` event strips (the RPC `prompt` command has
  no metadata field).
- **worker** (`modes/worker.ts`): drives its own single turn inside a one-shot Worker container.
  On `session_start` it fetches the Handle's allowed Operations (`list_allowed_operations`) and
  registers one pi tool per Operation, injects the Task input and related Facts via `context`, and
  posts the result contract to the kernel (`report_task_result`, via the synchronous `report_result`
  tool) before exiting.
- **interactive** (`modes/interactive.ts`): the same tool set as `entry` for a pi / Claude-Code-like
  client outside the platform, holding a Handle minted by the human-channel `issue_handle`. No Turn
  correlation (no `report_turn`) and no `WORKSPACE_ID`.

## HTTP convention

`POST /api/cap/<name>` (`capabilityRoute`, `packages/shared/src/http.ts`), JSON body →
`{ok:true,result}`/`{ok:false,error:{code,message}}`. Interactive mode sends
`Authorization: Bearer <CAPABILITY_HANDLE>`. Entry and worker mode send **no credential**: the
container holds no Handle (design doc I19) — worker-supervisor binds it to the container's address
on the `workers` network, the kernel authenticates the request by that address, and it refuses a
request from that network that carries an `Authorization` header of its own.
