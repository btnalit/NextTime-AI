import {
  ATTEST_FACT_LINK_MAX_LENGTH,
  ATTEST_FACT_NOTE_MAX_LENGTH,
  type FactWire,
  type HumanAttestationWire,
} from '@nexttime/shared';
import { useEffect, useId, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../kit/dialog.js';
import { Field, describedBy } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { Textarea } from '../kit/textarea.js';

export interface AttestFactDialogProps {
  readonly http: CapabilityCaller;
  /** The Fact being attested; `null` keeps the dialog closed. */
  readonly fact: FactWire | null;
  /** How the row names this Fact to a person (link type → neighbour), shown under the title. */
  readonly factLabel: string;
  readonly onClose: () => void;
  /** After a successful `attest_fact` — the owner pushes the toast (`kit/*` never imports the
   *  legacy `ui/Toast` the app mounts, S8 risk ①). */
  readonly onAttested: (attestation: HumanAttestationWire) => void;
}

const HTTP_LINK = /^https?:\/\/\S+$/i;

/** Client-side mirror of `attest_fact`'s own `link` rule (the kernel validates it again). */
export function linkError(link: string): 'scheme' | 'length' | null {
  const trimmed = link.trim();
  if (trimmed === '') return null;
  if (trimmed.length > ATTEST_FACT_LINK_MAX_LENGTH) return 'length';
  return HTTP_LINK.test(trimmed) ? null : 'scheme';
}

/**
 * components/graph/AttestFactDialog (STATUS leftover 89, maintainer decision 2026-09-27): 附人工确认
 * — a person records their own confirmation of a Fact as Evidence of the separate, labelled kind
 * 人工确认 (`attest_fact`, human channel only). Note required, link optional (http(s) only). The
 * dialog says plainly that this is recorded as the person's own word and audited — it is never
 * shown as, or counted as, machine evidence — and that it lets 「验证」 go through afterwards.
 */
export function AttestFactDialog({
  http,
  fact,
  factLabel,
  onClose,
  onAttested,
}: AttestFactDialogProps) {
  const t = useT();
  const noteId = useId();
  const linkId = useId();
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [noteTouched, setNoteTouched] = useState(false);

  // A fresh form for every Fact the dialog opens on.
  const factId = fact?.id ?? null;
  useEffect(() => {
    if (factId === null) return;
    setNote('');
    setLink('');
    setError(null);
    setNoteTouched(false);
  }, [factId]);

  const noteMissing = note.trim() === '';
  const linkProblem = linkError(link);
  const canSubmit = !busy && !noteMissing && linkProblem === null;

  async function submit(): Promise<void> {
    if (!fact) return;
    setNoteTouched(true);
    if (noteMissing || linkProblem !== null) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedLink = link.trim();
      const attestation = await http.call<HumanAttestationWire>('attest_fact', {
        factId: fact.id,
        note: note.trim(),
        ...(trimmedLink === '' ? {} : { link: trimmedLink }),
      });
      onAttested(attestation);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const noteError =
    noteTouched && noteMissing ? t('请写下你确认了什么', 'Say what you confirmed') : null;
  const linkMessage =
    linkProblem === 'scheme'
      ? t('链接需以 http:// 或 https:// 开头', 'The link must start with http:// or https://')
      : linkProblem === 'length'
        ? t('链接过长', 'The link is too long')
        : null;

  return (
    <Dialog
      open={fact !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent data-testid="attest-fact-dialog">
        <DialogHeader>
          <DialogTitle>{t('附人工确认', 'Add a human attestation')}</DialogTitle>
          <DialogDescription className="mono">{factLabel}</DialogDescription>
        </DialogHeader>
        <div className="stack">
          <Notice testId="attest-fact-notice">
            {t(
              '这条确认会以你本人的名义记录为「人工确认」证据：与观测、执行结果、文档等机器证据分开标注，并写入审计。记录后即可对该事实「验证」。',
              'This is recorded as your own confirmation — a “human attestation”, labelled apart from machine evidence such as observations, results and documents — and written to the audit log. Afterwards the Fact can be verified.',
            )}
          </Notice>
          <Field
            id={noteId}
            label={t('确认说明', 'What you confirmed')}
            required
            hint={t(
              '你确认了什么、怎么确认的（例如：到机房核对过、与负责人确认过）。',
              'What you confirmed and how (e.g. checked on site, confirmed with the owner).',
            )}
            error={noteError}
          >
            <Textarea
              id={noteId}
              aria-label={t('确认说明', 'What you confirmed')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onBlur={() => setNoteTouched(true)}
              minRows={3}
              maxLength={ATTEST_FACT_NOTE_MAX_LENGTH}
              invalid={noteError !== null}
              aria-required
              aria-describedby={describedBy(noteId, true, noteError !== null)}
              disabled={busy}
              data-testid="attest-fact-note"
            />
          </Field>
          <Field
            id={linkId}
            label={t('参考链接（可选）', 'Reference link (optional)')}
            hint={t('工单、文档或截图的链接。', 'A ticket, document or screenshot.')}
            error={linkMessage}
          >
            <input
              id={linkId}
              className="input"
              type="url"
              inputMode="url"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://"
              maxLength={ATTEST_FACT_LINK_MAX_LENGTH}
              aria-invalid={linkMessage !== null || undefined}
              aria-describedby={describedBy(linkId, true, linkMessage !== null)}
              disabled={busy}
              data-testid="attest-fact-link"
            />
          </Field>
          <InlineError error={error} testId="attest-fact-error" />
        </div>
        <DialogFooter>
          <Button
            variant="primary"
            size="s"
            disabled={!canSubmit}
            aria-busy={busy || undefined}
            onClick={() => void submit()}
            data-testid="attest-fact-submit"
          >
            {t('记录人工确认', 'Record attestation')}
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="s" disabled={busy}>
              {t('取消', 'Cancel')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
