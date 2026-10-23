---
name: docker-triage
description: 排查 Docker 容器停止、反复重启、健康检查失败或行为异常：先查台账记录，再只读核实，给出原因和带证据的处理建议。
applicable:
  objectTypes:
    - Container
    - ComposeProject
---

# Docker container triage

Use this when your task is about a container that is down, restarting, unhealthy or misbehaving.

## 1. Start from what the workspace records

- `search` for the container, its Compose project or its host; `get_object` and `traverse` show
  the host, image, volumes, networks and endpoints around it.
- `list_facts` gives its recorded state (running or exited, restart count, health), and
  `graph_freshness` how old that record is. The host inventory collector writes these; a stale
  record is a reason to observe, never a conclusion.
- `state_at` answers "what changed, and when".

## 2. Observe the live system when you can

- `list_allowed_operations` lists the read-only operations you may call through
  `observe_operation` — for example a connected Docker system's container inspect or log tail.
  Prefer what they return over what the record says.
- Read the container's state, exit code, restart count, health check result and the end of its
  log. Look at the host's disk and memory when the log points there.

## 3. Diagnose

Name the most likely cause and the evidence that shows it. Common causes: the process exits on a
bad configuration or a missing environment variable; something it depends on (a database, another
container) is not up; the health check fails while the process runs; the host is out of disk or
memory; the image was replaced by an incompatible one. Say what you could not check.

## 4. Recommend; do not act

- If you hold an execute-class tool for this system, a restart or any other change goes through
  the approval flow as your instructions describe — a request, never a done action.
- Otherwise put the recommended action in `report_result`: what to do (restart the container,
  free disk on the host, fix a variable), why, what else it affects, and the evidence. The agent
  that invoked you turns it into a request a person approves.
- Record what you verified as `factsToAssert`, each with its `evidence`; leave out what you only
  suspect.
