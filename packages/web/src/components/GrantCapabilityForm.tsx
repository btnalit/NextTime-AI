import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import type { GrantRow, PrincipalRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select } from './ui/Field.js';

export interface GrantCapabilityFormProps {
  readonly http: CapabilityCaller;
  /** Populates a principal picker when available; falls back to a free-text id field otherwise
   *  (the same degrade `RegisteredSystemsSection`'s pre-existing "Grant to principal" form uses,
   *  since `list_principals` may not be deployed yet — see the module doc comment). */
  readonly principals?: readonly PrincipalRow[];
  readonly defaultPrincipalId?: string;
  readonly onDone: (grant: GrantRow) => void;
  readonly onCancel: () => void;
}

/**
 * components/GrantCapabilityForm: `grant_capability{principalId, resourceType, resourceId?,
 * scope?}` — the existing S2.x capability (docs/wire-contract-conventions.md §1 already renamed
 * its params from `capability`/`scope`-embedded-id to `resourceType`+`resourceId`), reused here as
 * the Access page's own "Grant" action. `resourceType` has no fixed enum in the registry yet (only
 * `'gatekeeper'` is used in practice today, per that same doc comment) — free text with a
 * suggestion, not a hard-coded `<Select>`, so this form does not silently reject a resource type
 * added on the kernel side after this PR ships.
 */
export function GrantCapabilityForm({
  http,
  principals,
  defaultPrincipalId,
  onDone,
  onCancel,
}: GrantCapabilityFormProps) {
  const t = useT();
  const [principalId, setPrincipalId] = useState(defaultPrincipalId ?? '');
  const [resourceType, setResourceType] = useState('gatekeeper');
  const [resourceId, setResourceId] = useState('');
  const [scopeText, setScopeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setScopeError(null);
    let scope: unknown;
    if (scopeText.trim()) {
      try {
        scope = JSON.parse(scopeText);
      } catch {
        setScopeError(t('Scope 必须是合法 JSON。', 'Scope must be valid JSON.'));
        return;
      }
      // C19: `GrantRow.scope` is read as a record everywhere (`Object.keys(row.scope)` on the
      // Access page, the kernel's own qualifier matching) — a bare string, number, `null` or an
      // array is valid JSON but not a scope, and used to be submitted verbatim.
      if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
        setScopeError(
          'Scope 必须是 JSON 对象，例如 {"actionKindTag":"…"}。 Scope must be a JSON object, e.g. {"actionKindTag":"…"}.',
        );
        return;
      }
    }
    if (!principalId.trim() || !resourceType.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const grant = await http.call<GrantRow>('grant_capability', {
        principalId: principalId.trim(),
        resourceType: resourceType.trim(),
        ...(resourceId.trim() ? { resourceId: resourceId.trim() } : {}),
        ...(scope !== undefined ? { scope } : {}),
      });
      onDone(grant);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="grant-capability-form"
    >
      <Field id="gc-principal" label={t('主体', 'Principal')} required>
        {principals && principals.length > 0 ? (
          <Select
            id="gc-principal"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
            disabled={submitting}
          >
            <option value="" disabled>
              选择成员… Choose a member…
            </option>
            {principals.map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName} ({row.role})
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id="gc-principal"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
            disabled={submitting}
            mono
            placeholder="principal id"
          />
        )}
      </Field>

      <Field
        id="gc-resource-type"
        label={t('资源类型', 'Resource type')}
        required
        hint={t("目前只有 'gatekeeper'。", "Today: 'gatekeeper'.")}
      >
        <Input
          id="gc-resource-type"
          value={resourceType}
          onChange={(event) => setResourceType(event.target.value)}
          disabled={submitting}
          list="resource-type-suggestions"
          mono
        />
        <datalist id="resource-type-suggestions">
          <option value="gatekeeper" />
        </datalist>
      </Field>

      <Field
        id="gc-resource-id"
        label={t('资源 id', 'Resource id')}
        hint={t(
          '门的 id；留空 = 授予该类型的全部资源。',
          "The gatekeeper's id. Leave empty to grant every resource of this type.",
        )}
      >
        <Input
          id="gc-resource-id"
          value={resourceId}
          onChange={(event) => setResourceId(event.target.value)}
          disabled={submitting}
          mono
        />
      </Field>

      <Field
        id="gc-scope"
        label={t('范围', 'Scope (JSON)')}
        error={scopeError}
        hint={t(
          '可选的附加限定，例如 {&quot;actionKindTag&quot;:&quot;docker.container_restart&quot;}。',
          'Optional extra qualifiers.',
        )}
      >
        <Input
          id="gc-scope"
          value={scopeText}
          onChange={(event) => setScopeText(event.target.value)}
          disabled={submitting}
          mono
          placeholder="{}"
        />
      </Field>

      {error !== null ? (
        <ErrorBanner error={error} title={t('无法授予', 'Could not grant this capability')} />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!principalId.trim() || !resourceType.trim()}
        >
          {t('授予', 'Grant')}
        </Button>
      </div>
    </form>
  );
}
