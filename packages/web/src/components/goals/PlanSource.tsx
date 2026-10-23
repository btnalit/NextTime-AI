import type { PlanSourceProcedureWire } from '@nexttime/shared';
import { useCanOpen } from '../../hooks/useCanOpen.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';

/**
 * components/goals/PlanSource (S11 GO5d-2): 「由流程 X vN 生成」 — the published Procedure a goal's
 * plan was made from (`fromProcedure` on revision 1), its name a link to the Procedure in the
 * catalog for a reader who may open it.
 */
export function PlanSource({
  source,
  testId,
}: {
  readonly source: PlanSourceProcedureWire;
  readonly testId?: string;
}) {
  const t = useT();
  const canOpen = useCanOpen();
  const href = hrefs.catalog('procedures', source.procedureId);
  const name =
    canOpen(href) === false ? (
      <strong>{source.name}</strong>
    ) : (
      <a href={href} data-testid={testId ? `${testId}-link` : undefined}>
        {source.name}
      </a>
    );
  return (
    <span data-testid={testId}>
      {t(
        <>
          由流程 {name} v{source.version} 生成
        </>,
        <>
          Made from the Procedure {name} v{source.version}
        </>,
      )}
    </span>
  );
}
