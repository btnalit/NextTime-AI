-- scrub-raw-secrets preflight: read-only, safe to run before the release's images are pulled —
-- feed this file to psql on the platform database (`psql -U nexttime -d nexttime < <this file>`,
-- the host runbook's preflight SQL step).
-- Upper bounds by text match; `node dist/cli/scrub-raw-secrets.js` (no --yes: a dry run) gives the
-- exact counts and the row ids. The two address patterns (`://…:…@`, `[?#&;](…)=`) are
-- @nexttime/shared's ADDRESS_CREDENTIAL_SQL, the address rule the kernel refuses by;
-- scrub-raw-secrets.preflight.integration.test.ts fails if they drift apart.

-- 183 (rewritten): agent Turn reports and agent-recorded Decisions with a secret-looking value
select count(*) as turn_reports from activities
 where kind = 'agent_turn' and (metadata ? 'summary' or metadata ? 'decisions')
   and (metadata - 'model')::text ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |password|passwd|secret|token|api[_-]?key|-----begin)';
select count(*) as agent_decisions from decisions d
  join activities a on a.workspace_id = d.workspace_id and a.id = d.activity_id
 where a.kind = 'agent_turn'
   and d.summary ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |password|passwd|secret|token|api[_-]?key|-----begin)';

-- 185 (rewritten): stored tool-call results with a value under a secret-named JSON key
select count(*) as tool_call_records from chat_messages
 where role = 'tool' and content ->> 'kind' = 'tool_call'
   and content -> 'result' ->> 'text' ~* '"[^"]*(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)[^"]*"\s*:\s*("[^"\[]|[0-9])';

-- 184 (counted only): Task inputs that name a secret-looking field or value
select count(*) as task_inputs from tasks
 where input::text ~* '(password|passwd|secret|token|api[_-]?key|credential|-----begin)';

-- 186 (counted only): connection and gate addresses carrying a credential
select count(*) as connection_targets from connection_requests
 where target ~* '^[a-z][a-z0-9+.-]*://[^/?#@]*:[^/?#@]+@'
    or target ~* '[?#&;]([^=&#;?]*(password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|token|cookie|bearer|handle)[^=&#;?]*|sig|signature|x-amz-signature|x-goog-signature|key|pwd|pass|auth)=[^&#;]'
    or target ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |-----begin)';
select count(*) as gatekeeper_addresses from objects
 where object_type = 'Gatekeeper'
   and (properties ->> 'endpoint' ~ '://[^/]*@'
        or strpos(properties ->> 'endpoint', '?') > 0
        or strpos(properties ->> 'endpoint', '#') > 0
        or properties ->> 'target' ~* '^[a-z][a-z0-9+.-]*://[^/?#@]*:[^/?#@]+@'
        or properties ->> 'target' ~* '[?#&;]([^=&#;?]*(password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|token|cookie|bearer|handle)[^=&#;?]*|sig|signature|x-amz-signature|x-goog-signature|key|pwd|pass|auth)=[^&#;]'
        or properties ->> 'target' ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |-----begin)');
select count(distinct g.gate_id) as gate_instance_addresses from gate_instances g
 cross join lateral (values (g.target), (g.definition ->> 'target'), (g.definition ->> 'manifestSource')) as a(address)
 where g.endpoint ~ '://[^/]*@' or strpos(g.endpoint, '?') > 0 or strpos(g.endpoint, '#') > 0
    or a.address ~* '^[a-z][a-z0-9+.-]*://[^/?#@]*:[^/?#@]+@'
    or a.address ~* '[?#&;]([^=&#;?]*(password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|token|cookie|bearer|handle)[^=&#;?]*|sig|signature|x-amz-signature|x-goog-signature|key|pwd|pass|auth)=[^&#;]'
    or a.address ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |-----begin)';

-- 384 (rewritten): Gatekeeper names, and the name and target of the ConnectedSystem beside each,
-- carrying a credential (a self-connected gate is named after the target its owner typed)
select count(*) as gatekeeper_names from objects
 where object_type = 'Gatekeeper'
   and (properties ->> 'name' ~* '^[a-z][a-z0-9+.-]*://[^/?#@]*:[^/?#@]+@'
        or properties ->> 'name' ~* '[?#&;]([^=&#;?]*(password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|token|cookie|bearer|handle)[^=&#;?]*|sig|signature|x-amz-signature|x-goog-signature|key|pwd|pass|auth)=[^&#;]'
        or properties ->> 'name' ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |-----begin)');
select count(distinct o.id) as connected_systems from objects o
 cross join lateral (values (o.identity_key ->> 'name'), (o.properties ->> 'target'), (o.properties ->> 'name')) as a(address)
 where o.object_type = 'ConnectedSystem'
   and (a.address ~* '^[a-z][a-z0-9+.-]*://[^/?#@]*:[^/?#@]+@'
        or a.address ~* '[?#&;]([^=&#;?]*(password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|token|cookie|bearer|handle)[^=&#;?]*|sig|signature|x-amz-signature|x-goog-signature|key|pwd|pass|auth)=[^&#;]'
        or a.address ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |-----begin)');

-- Review of #549 B2 (counted only): Fact properties and observed / ingested Object properties
-- the graph store now scrubs (the Object types the kernel writes itself are left out)
select count(*) as fact_properties from links
 where properties <> '{}'::jsonb
   and properties::text ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |password|passwd|passphrase|secret|credential|authori[sz]ation|token|cookie|api[_-]?key|private[_-]?key|access[_-]?key|-----begin)';
select count(*) as object_properties from objects
 where properties <> '{}'::jsonb
   and object_type not in ('WorkerDefinition', 'Gatekeeper', 'Skill', 'Procedure', 'Operation')
   and properties::text ~* '(eyJ[A-Za-z0-9_-]{8,}\.|bearer |basic |password|passwd|passphrase|secret|credential|authori[sz]ation|token|cookie|api[_-]?key|private[_-]?key|access[_-]?key|-----begin)';

-- 187 (counted only, append-only): gate-output / failure-reason audit rows written before the fix
select action, count(*) from audit_records
 where action in ('action_request.complete', 'action_request.fail')
   and (payload ? 'resultMetadata' or payload ? 'reason')
   and not payload ? 'resultRedaction'
 group by action;
