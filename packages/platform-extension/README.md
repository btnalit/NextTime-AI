# @nexttime/platform-extension

The single shared pi extension (design doc §7.4). `NEXTTIME_MODE` picks the behavior; S1 only
implements `entry`.

## Env vars

| Var | Required | Meaning |
|-----|----------|---------|
| `NEXTTIME_MODE` | yes | `entry`\|`worker`\|`interactive`. Only `entry` runs in S1; the others throw a clear "not implemented in S1" error on activation. |
| `KERNEL_URL` | entry | Base URL of the kernel, no trailing slash. |
| `CAPABILITY_HANDLE` | entry | Bearer credential (S1.9 JWT); never logged. |
| `WORKSPACE_ID` | entry | Informational; the kernel derives the real workspace from the Handle. |
| `NEXTTIME_TURN_ID` | no | Seeds the turn id before the first `input` event supplies a fresher one. |

## Modes

- **entry**: registers the S1 graph observe tools (`get_object`/`traverse`/`search`/`explain`/
  `get_task`, from `@nexttime/shared`'s registry); injects context via pi's `context` event
  (`get_entry_context`); correlates each pi run with a platform Turn (`agent_start`/`agent_end`/
  `agent_settled`) and reports it (`report_turn`) once settled. `find_workers`/`invoke_worker`
  land in S2.7/S2.4. Per-prompt turn id: the caller prefixes the prompt text with
  `<!--nexttime:turn_id=<id>-->\n`, which the `input` event strips (the RPC `prompt` command has
  no metadata field).
- **worker** / **interactive**: not implemented yet (S2.9 / S3.6).

## HTTP convention

`POST /api/cap/<name>` (`capabilityRoute`, `packages/shared/src/http.ts`), JSON body,
`Authorization: Bearer <CAPABILITY_HANDLE>` → `{ok:true,result}`/`{ok:false,error:{code,message}}`.
