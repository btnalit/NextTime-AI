import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { prettyJson, redactSensitive } from '../lib/format.js';
import { Button } from './ui/Button.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';
import { PageHeader } from './ui/PageHeader.js';

export interface AuditPageProps {
  readonly http: CapabilityCaller;
}

interface LookupState {
  readonly busy: boolean;
  readonly error: unknown | null;
  readonly result: unknown | null;
}

const IDLE: LookupState = { busy: false, error: null, result: null };

/**
 * components/AuditPage: 审计 Audit (`/govern/audit`) — `explain`/`reconstruct` by id, plus a
 * filtered `audit_query` view (docs/development-tasks.md §S3.14: "explain / reconstruct by id +
 * the existing audit views if any"). All three capabilities already exist and are wired
 * (`packages/kernel/src/application/gateway/handlers.ts` — unlike the rest of S3.11, this is not
 * new surface, just previously not exposed in the console). `explain` is `minRole: 'member'`
 * (open to everyone); `reconstruct`/`audit_query`/`export_prov` are `minRole: 'auditor'` — this
 * page is the one governance page member-role sessions can partially use.
 *
 * Neither `explain` nor `reconstruct` has a fixed result shape published anywhere the web owns
 * (`explainByNodeId`/`reconstruct` return whatever their own domain module returns) — rendered as
 * redacted pretty-printed JSON rather than assumed fields, matching this page's own subject
 * matter: a raw provenance dump is the correct output for an audit tool, not a prettied guess.
 */
export function AuditPage({ http }: AuditPageProps) {
  return (
    <div className="page">
      <PageHeader
        title="审计 Audit"
        description="Provenance lookups (explain, reconstruct) and the audit log, by id or filter."
      />
      <ExplainCard http={http} />
      <ReconstructCard http={http} />
      <AuditQueryCard http={http} />
    </div>
  );
}

function ResultBlock({ result }: { readonly result: unknown }) {
  return <pre className="code-block pre-wrap">{prettyJson(redactSensitive(result))}</pre>;
}

function ExplainCard({ http }: { readonly http: CapabilityCaller }) {
  const [nodeId, setNodeId] = useState('');
  const [state, setState] = useState<LookupState>(IDLE);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = nodeId.trim();
    if (!trimmed || state.busy) return;
    setState({ busy: true, error: null, result: null });
    try {
      const result = await http.call('explain', { nodeId: trimmed });
      setState({ busy: false, error: null, result });
    } catch (err) {
      setState({ busy: false, error: err, result: null });
    }
  }

  return (
    <section className="section" aria-labelledby="explain-title">
      <div className="section-header">
        <h2 id="explain-title">Explain</h2>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => void handleSubmit(event)}
        data-testid="explain-form"
      >
        <Field id="explain-node-id" label="Node id" hint="A Fact, Decision, or Turn id.">
          <Input
            id="explain-node-id"
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
            disabled={state.busy}
            mono
          />
        </Field>
        <Button type="submit" variant="primary" loading={state.busy} disabled={!nodeId.trim()}>
          Explain
        </Button>
      </form>
      {state.error !== null ? (
        <ErrorBanner
          error={state.error}
          title="Could not explain this node"
          testId="explain-error"
        />
      ) : null}
      {state.result !== null ? <ResultBlock result={state.result} /> : null}
    </section>
  );
}

function ReconstructCard({ http }: { readonly http: CapabilityCaller }) {
  const [entityId, setEntityId] = useState('');
  const [state, setState] = useState<LookupState>(IDLE);
  const forbidden = state.error !== null && isForbiddenError(state.error);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = entityId.trim();
    if (!trimmed || state.busy) return;
    setState({ busy: true, error: null, result: null });
    try {
      const result = await http.call('reconstruct', { entityId: trimmed });
      setState({ busy: false, error: null, result });
    } catch (err) {
      setState({ busy: false, error: err, result: null });
    }
  }

  return (
    <section className="section" aria-labelledby="reconstruct-title">
      <div className="section-header">
        <h2 id="reconstruct-title">Reconstruct</h2>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => void handleSubmit(event)}
        data-testid="reconstruct-form"
      >
        <Field id="reconstruct-entity-id" label="Entity id" hint="A graph Object id.">
          <Input
            id="reconstruct-entity-id"
            value={entityId}
            onChange={(event) => setEntityId(event.target.value)}
            disabled={state.busy}
            mono
          />
        </Field>
        <Button type="submit" variant="primary" loading={state.busy} disabled={!entityId.trim()}>
          Reconstruct
        </Button>
      </form>
      {forbidden ? (
        <EmptyState icon="shield" title="需要 auditor 权限" testId="reconstruct-forbidden" />
      ) : state.error !== null ? (
        <ErrorBanner
          error={state.error}
          title="Could not reconstruct this entity"
          testId="reconstruct-error"
        />
      ) : null}
      {state.result !== null ? <ResultBlock result={state.result} /> : null}
    </section>
  );
}

function AuditQueryCard({ http }: { readonly http: CapabilityCaller }) {
  const [actorPrincipalId, setActorPrincipalId] = useState('');
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [state, setState] = useState<LookupState>(IDLE);
  const forbidden = state.error !== null && isForbiddenError(state.error);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state.busy) return;
    const filter: Record<string, string> = {};
    if (actorPrincipalId.trim()) filter.actorPrincipalId = actorPrincipalId.trim();
    if (action.trim()) filter.action = action.trim();
    if (resourceType.trim()) filter.resourceType = resourceType.trim();
    setState({ busy: true, error: null, result: null });
    try {
      const result = await http.call('audit_query', { filter });
      setState({ busy: false, error: null, result });
    } catch (err) {
      setState({ busy: false, error: err, result: null });
    }
  }

  return (
    <section className="section" aria-labelledby="audit-query-title">
      <div className="section-header">
        <h2 id="audit-query-title">Audit log</h2>
      </div>
      <form
        className="inline-form row-wrap"
        onSubmit={(event) => void handleSubmit(event)}
        data-testid="audit-query-form"
      >
        <Field id="audit-actor" label="Actor principal">
          <Input
            id="audit-actor"
            value={actorPrincipalId}
            onChange={(event) => setActorPrincipalId(event.target.value)}
            disabled={state.busy}
            mono
          />
        </Field>
        <Field id="audit-action" label="Action">
          <Input
            id="audit-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            disabled={state.busy}
            mono
          />
        </Field>
        <Field id="audit-resource-type" label="Resource type">
          <Input
            id="audit-resource-type"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value)}
            disabled={state.busy}
            mono
          />
        </Field>
        <Button type="submit" variant="secondary" loading={state.busy}>
          Query
        </Button>
      </form>
      {forbidden ? (
        <EmptyState icon="shield" title="需要 auditor 权限" testId="audit-query-forbidden" />
      ) : state.error !== null ? (
        <ErrorBanner
          error={state.error}
          title="Could not query the audit log"
          testId="audit-query-error"
        />
      ) : null}
      {state.result !== null ? <ResultBlock result={state.result} /> : null}
    </section>
  );
}
