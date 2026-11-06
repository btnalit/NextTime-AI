import type {
  AdminProposalPackExportProblemWire,
  AdminProposalPackExportWire,
  AdminProposalSegmentWire,
  AdminProposalWire,
} from '@nexttime/shared';
import { EXPORTED_PACK_NOTES_MAX_LENGTH, EXPORTED_PACK_SUMMARY_MAX_LENGTH } from '@nexttime/shared';
import { useEffect, useRef, useState } from 'react';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { HttpError } from '../../../lib/http-client.js';
import { type Translate, useT } from '../../../lib/i18n.js';
import { TarPathError, downloadTar } from '../../../lib/tar.js';
import { Button } from '../../kit/button.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../kit/dialog.js';
import { Field, describedBy } from '../../kit/field.js';
import { InlineError } from '../../kit/inline-error.js';
import { Notice } from '../../kit/notice.js';
import { Textarea } from '../../kit/textarea.js';

/**
 * components/platform/admin-proposals/ExportPack (S11 AA5d-3): a workspace part of an admin
 * proposal, applied and verified where it was applied, exported as version 1 of a pack named by
 * the proposal's source name (`export_admin_proposal_pack`, docs/runbooks/operations.md §14.11) —
 * downloaded as one `.tar` a maintainer unpacks into the host's `config/packs/` (§14.10). Then
 * the workspace it was applied to has that pack up to date, and any other installs it from
 * Catalog · Packs.
 *
 * Exporting writes nothing, so there is no confirmation tier: the dialog asks for what workspace
 * owners read before installing (`summary`, started from the proposal's title; `notes`, started
 * with the Operation changes a pack does not carry), exports, and offers the download. A refusal
 * (409 `admin_proposal_pack_not_exportable`) lists every reason, each in the console's words with
 * where it is; a suspected credential is named by where it is, never by its value (the kernel
 * never sends one).
 */
export function ExportPack({
  http,
  proposal,
  segment,
  testIdPrefix,
}: {
  readonly http: CapabilityCaller;
  readonly proposal: AdminProposalWire;
  readonly segment: AdminProposalSegmentWire;
  readonly testIdPrefix: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const prefix = `${testIdPrefix}-export`;
  return (
    <>
      <Button
        variant="secondary"
        size="s"
        onClick={() => setOpen(true)}
        data-testid={`${prefix}-trigger`}
      >
        {t('导出成能力包…', 'Export as a pack…')}
      </Button>
      {open ? (
        <ExportPackDialog
          http={http}
          proposal={proposal}
          segment={segment}
          prefix={prefix}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The notes a pack starts with: what of the part it does not carry. */
export function omittedNotes(segment: AdminProposalSegmentWire, t: Translate): string {
  const operations = segment.items.flatMap((item) =>
    item.kind === 'operation_version' ? [`- ${item.gateId} · ${item.name}`] : [],
  );
  if (operations.length === 0) return '';
  return [
    t(
      '这个能力包不带下面这些 Operation 改动；装到别的工作区后，那些门保持各自的设置：',
      'This pack does not carry these Operation changes; installed elsewhere, those gates keep their own settings:',
    ),
    ...operations,
  ].join('\n');
}

/** What a refusal's reason means, in the console's words (the kernel's `message` is English). */
export function exportProblemText(
  problem: AdminProposalPackExportProblemWire,
  t: Translate,
): string {
  switch (problem.code) {
    case 'segment_not_applied':
      return t(
        '这个工作区部分还没应用，或者已经撤销了。',
        'This workspace part is not applied, or it was rolled back.',
      );
    case 'not_verified':
      return t(
        '它应用的东西在那个工作区里最近一次核验没通过（比如之后又改过）。请那里的所有者在「安装历史」里重新核验，通过后再导出。',
        'What it applied did not pass its latest verification in that workspace (it may have changed since). Ask that workspace’s owner to verify it again under Install history, then export once it passes.',
      );
    case 'suspected_credentials':
      return t(
        '这里有一处像是凭证，能力包里不能带。把它从提案里去掉（或从简介、说明里删掉）后再导出。',
        'Something here looks like a credential, which a pack cannot carry. Take it out of the proposal (or out of the summary or notes), then export again.',
      );
    case 'component_name_invalid':
      return t(
        '这个 Skill 或 Worker 的名字不能做能力包的组成部分（只能用小写字母、数字和连字符，以字母开头）。',
        'A pack cannot have a Skill or Worker by this name (lowercase letters, digits and hyphens only, starting with a letter).',
      );
    case 'worker_skill_outside':
      return t(
        '这个 Worker 挂了一个不在这个部分里的 Skill，能力包里找不到它。',
        'This Worker mounts a Skill that is not in this part, so the pack would not have it.',
      );
    case 'component_owned':
      return t(
        '它改的是本部署另一个能力包已有的组成部分。',
        'It changes a part another pack of this deployment already has.',
      );
    case 'pack_name_taken':
      return t(
        '本部署已经有一个同名、内容不同的能力包：这个来源名导出过别的内容，或者这份提案上次导出时的简介、说明和这次不同。要换掉上次导出的那份，先把主机 config/packs/ 里同名的目录移走，在「平台 · 模块」点「重新读取」，再导出。已经有工作区装了那份的，别换掉它，按 operations.md §14.1 加一个新版本。',
        'This deployment already has a different pack by this name: this source name was exported with other content, or this proposal with another summary or notes. To replace the pack exported before, move the directory of that name out of the host’s config/packs/, choose Read again on Platform · Modules, then export again. If a workspace has installed it, keep it and add a new version instead (operations.md §14.1).',
      );
    case 'no_components':
      return t(
        '这个部分只有 Operation 改动，能力包里没有可带的东西。',
        'This part only changes Operations, so a pack would have nothing in it.',
      );
    case 'not_a_valid_pack':
      return t(
        '生成的文件读回来不是一个有效的能力包，或者和应用时的内容对不上。',
        'The files made do not read back as a valid pack, or differ from what was applied.',
      );
  }
}

function problemsOf(error: unknown): readonly AdminProposalPackExportProblemWire[] | null {
  if (!(error instanceof HttpError) || error.code !== 'admin_proposal_pack_not_exportable') {
    return null;
  }
  const problems = error.details?.problems;
  return Array.isArray(problems) ? (problems as AdminProposalPackExportProblemWire[]) : null;
}

function ExportPackDialog({
  http,
  proposal,
  segment,
  prefix,
  onClose,
}: {
  readonly http: CapabilityCaller;
  readonly proposal: AdminProposalWire;
  readonly segment: AdminProposalSegmentWire;
  readonly prefix: string;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [summary, setSummary] = useState(() =>
    proposal.title.trim().slice(0, EXPORTED_PACK_SUMMARY_MAX_LENGTH),
  );
  const startingNotes = omittedNotes(segment, t);
  const [notes, setNotes] = useState(() => startingNotes.slice(0, EXPORTED_PACK_NOTES_MAX_LENGTH));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pack, setPack] = useState<AdminProposalPackExportWire | null>(null);
  // Why the download did not happen: the browser cannot download, or a path the tar cannot hold.
  const [downloadFailed, setDownloadFailed] = useState<
    null | { readonly kind: 'unsupported' } | { readonly kind: 'path'; readonly path: string }
  >(null);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pack !== null) resultRef.current?.focus();
  }, [pack]);

  const problems = problemsOf(error);
  const blank = summary.trim() === '';

  async function exportPack(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const trimmedNotes = notes.trim();
      setPack(
        await http.call<AdminProposalPackExportWire>('export_admin_proposal_pack', {
          segmentId: segment.id,
          summary: summary.trim(),
          ...(trimmedNotes !== '' ? { notes: trimmedNotes } : {}),
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const filename = pack !== null ? `${pack.name}-${pack.version}.tar` : '';

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg" data-testid={`${prefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{t('导出成能力包', 'Export as a pack')}</DialogTitle>
          <DialogDescription>
            {t(
              `把这个部分应用的本体、Skill 和 Worker 导出成能力包「${proposal.sourceName}」的版本 1。放进主机的附加能力包目录后，它应用过的工作区里这个包就是「已是最新」，别的工作区可以在「能力目录 · 能力包」里安装。导出不改动任何东西。`,
              `Exports the ontology, Skills and Workers this part applied as version 1 of the pack “${proposal.sourceName}”. Once it is in the host’s extra packs directory, the workspace it was applied to has the pack up to date, and any other workspace can install it under Catalog · Packs. Exporting changes nothing.`,
            )}
          </DialogDescription>
        </DialogHeader>
        {pack === null ? (
          <div className="stack">
            <Field
              id={`${prefix}-summary`}
              label={t('简介', 'Summary')}
              hint={t(
                '一句话说明这个能力包是什么，工作区所有者安装前读。',
                'One sentence on what the pack is, for workspace owners before they install it.',
              )}
              required
            >
              <Textarea
                id={`${prefix}-summary`}
                value={summary}
                maxLength={EXPORTED_PACK_SUMMARY_MAX_LENGTH}
                disabled={busy}
                onChange={(event) => setSummary(event.target.value)}
                aria-label={t('简介', 'Summary')}
                aria-describedby={describedBy(`${prefix}-summary`, true, false)}
                data-testid={`${prefix}-summary`}
              />
            </Field>
            <Field
              id={`${prefix}-notes`}
              label={t('说明', 'Notes')}
              hint={
                startingNotes === ''
                  ? t(
                      '选填，写进能力包，给工作区所有者看。',
                      'Optional, kept in the pack for workspace owners.',
                    )
                  : t(
                      '选填，写进能力包，给工作区所有者看。已经写好了它不带的 Operation 改动，可以改。',
                      'Optional, kept in the pack for workspace owners. It starts with the Operation changes the pack does not carry; edit as you like.',
                    )
              }
            >
              <Textarea
                id={`${prefix}-notes`}
                value={notes}
                maxLength={EXPORTED_PACK_NOTES_MAX_LENGTH}
                disabled={busy}
                onChange={(event) => setNotes(event.target.value)}
                aria-label={t('说明', 'Notes')}
                minRows={4}
                aria-describedby={describedBy(`${prefix}-notes`, true, false)}
                data-testid={`${prefix}-notes`}
              />
            </Field>
            {problems !== null ? (
              <div role="alert" className="field-error stack-s" data-testid={`${prefix}-problems`}>
                <strong>{t('没有导出，原因：', 'Not exported, because:')}</strong>
                <ul className="stack-s">
                  {problems.map((problem, index) => (
                    <li
                      // A problem has no id; two may share a code and a path.
                      // biome-ignore lint/suspicious/noArrayIndexKey: the list is shown as returned.
                      key={index}
                      data-testid={`${prefix}-problem-${problem.code}`}
                    >
                      {exportProblemText(problem, t)}
                      {problem.path !== undefined ? (
                        <span className="mono text-small">
                          {' '}
                          {t('位置：', 'At: ')}
                          {problem.path}
                        </span>
                      ) : null}
                      {problem.code === 'not_a_valid_pack' ? (
                        <span className="block text-3 text-small wrap-anywhere">
                          {problem.message}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <InlineError error={error} testId={`${prefix}-error`} />
            )}
          </div>
        ) : (
          <div className="stack" ref={resultRef} tabIndex={-1} data-testid={`${prefix}-result`}>
            <Notice testId={`${prefix}-done`}>
              {t(
                `已导出 ${pack.name} v${pack.version}，共 ${pack.files.length} 个文件。下载后传到主机，按 operations.md §14.10 解到 config/packs/。`,
                `Exported ${pack.name} v${pack.version}, ${pack.files.length} files. Download it, copy it to the host and unpack it into config/packs/ as operations.md §14.10 says.`,
              )}
            </Notice>
            <ul className="stack-s mono text-small" data-testid={`${prefix}-files`}>
              {pack.files.map((file) => (
                <li key={file.path} className="wrap-anywhere">
                  {file.path}
                </li>
              ))}
            </ul>
            {pack.omitted.length > 0 ? (
              <p className="text-small" data-testid={`${prefix}-omitted`}>
                {t('没有带的 Operation 改动：', 'Operation changes not carried: ')}
                {pack.omitted.map((item) => `${item.gateId} · ${item.name}`).join(t('、', ', '))}
              </p>
            ) : null}
            <span className="text-3 text-small mono wrap-anywhere">{pack.digest}</span>
            {downloadFailed?.kind === 'unsupported' ? (
              <Notice tone="warn" testId={`${prefix}-download-failed`}>
                {t(
                  '这个浏览器下载不了文件。上面列出的就是全部文件。',
                  'This browser cannot download files. The files listed above are all of it.',
                )}
              </Notice>
            ) : downloadFailed?.kind === 'path' ? (
              <Notice tone="warn" testId={`${prefix}-download-failed`}>
                {t(
                  `有一个文件的路径放不进 tar：${JSON.stringify(downloadFailed.path)}。没有下载任何东西；上面列出的就是全部文件，可以照 operations.md §14.11 写成文件。`,
                  `One file's path cannot go in a tar: ${JSON.stringify(downloadFailed.path)}. Nothing was downloaded; the files listed above are all of it, and operations.md §14.11 says how to write them out.`,
                )}
              </Notice>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {pack === null ? (
            <Button
              variant="primary"
              size="s"
              disabled={busy || blank}
              title={blank && !busy ? t('先写一句简介', 'Write a summary first') : undefined}
              aria-busy={busy || undefined}
              onClick={() => void exportPack()}
              data-testid={`${prefix}-submit`}
            >
              {t('导出', 'Export')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="s"
              onClick={() => {
                try {
                  setDownloadFailed(
                    downloadTar(filename, pack.files) ? null : { kind: 'unsupported' },
                  );
                } catch (err) {
                  if (!(err instanceof TarPathError)) throw err;
                  setDownloadFailed({ kind: 'path', path: err.path });
                }
              }}
              data-testid={`${prefix}-download`}
            >
              {t(`下载 ${filename}`, `Download ${filename}`)}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="s" disabled={busy}>
              {pack === null ? t('取消', 'Cancel') : t('关闭', 'Close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
