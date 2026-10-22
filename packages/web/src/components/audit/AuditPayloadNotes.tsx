import { useT } from '../../lib/i18n.js';

/** A non-negative whole number at `record[key]`, else `undefined`. */
function countAt(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * What an audit row's payload says about credentials, in words above the raw payload (legacy 159,
 * 178): the kernel's `credentialReview` (a person confirmed N suspected credentials — or, for a
 * call that asks nobody, such as an observation or `invoke_worker`, only recorded them) and
 * `redactedValues` (N values hidden in this audit copy of the params; the call itself got them as
 * sent). Legacy 168 ③: `revokedHandleCount` (how many Handles an upgrade revoked, on
 * `principal.container_handles_revoked` / `principal.auditor_handles_revoked`) too. Renders nothing
 * when the payload has none of them.
 */
export function AuditPayloadNotes({ payload }: { readonly payload: unknown }) {
  const t = useT();
  const record = asRecord(payload);
  if (record === undefined) return null;
  const review = asRecord(record.credentialReview);
  const reviewed = review !== undefined ? countAt(review, 'suspectedSecretValues') : undefined;
  const redacted = countAt(record, 'redactedValues');
  const revokedHandles = countAt(record, 'revokedHandleCount');
  if (reviewed === undefined && redacted === undefined && revokedHandles === undefined) return null;
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0.5 p-0 text-13 text-text-2"
      data-testid="audit-payload-notes"
    >
      {reviewed !== undefined ? (
        <li data-testid="audit-credential-review" data-confirmed={review?.confirmed === true}>
          {review?.confirmed === true
            ? t(
                `内容含 ${reviewed} 处疑似凭据，操作人已确认「已核对凭据」。`,
                `The content held ${reviewed} suspected credential value(s); the actor confirmed they were reviewed.`,
              )
            : t(
                `参数含 ${reviewed} 处疑似凭据，已记录（这类调用不经人确认）。`,
                `The parameters held ${reviewed} suspected credential value(s), recorded (this kind of call asks nobody to confirm).`,
              )}
        </li>
      ) : null}
      {redacted !== undefined ? (
        <li data-testid="audit-redacted-values">
          {t(
            `审计记录里隐藏了参数中的 ${redacted} 处疑似凭据（只隐藏这份记录，调用本身按原样执行）。`,
            `${redacted} suspected credential value(s) are hidden in this audit copy of the parameters (the call itself ran with them as sent).`,
          )}
        </li>
      ) : null}
      {revokedHandles !== undefined ? (
        <li data-testid="audit-revoked-handles">
          {t(`吊销了 ${revokedHandles} 个凭证（Handle）。`, `${revokedHandles} Handle(s) revoked.`)}
        </li>
      ) : null}
    </ul>
  );
}
