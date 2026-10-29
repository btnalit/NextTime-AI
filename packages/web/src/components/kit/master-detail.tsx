import { type ReactNode, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './sheet.js';

/** ≤1179px: list only, the detail opens in a `kit/sheet`; ≥1180px: two-pane master-detail. Chosen
 *  so Playwright's default 1280×720 viewport (journeys) and the 1440px gate screenshot both land
 *  in the wide layout, and the 768px gate screenshot lands in the narrow one (console redesign
 *  P3-4, V6 "待我审批" — the same checkpoint approvals shipped first, now shared). `useMediaQuery`
 *  degrades to `false` (not narrow) where `matchMedia` is unavailable — jsdom in a test with no
 *  mock — so the default, everywhere this hasn't been explicitly mocked to the contrary, is the
 *  wide layout. */
export const NARROW_MASTER_DETAIL_QUERY = '(max-width: 1179px)';

/** Whether the detail pane would only say "pick one on the left" while the left side offers nothing
 *  to pick — still loading, refused for this role, failed, or empty. Such a pane renders nothing
 *  instead (an auditor on 审批 used to read 「选择左侧一条审批请求」 next to "your role does not see
 *  the queue", #554 acceptance P3). */
export function nothingToPick(
  listStatus: 'loading' | 'ready' | 'error',
  rowCount: number,
  selectedId: string | undefined,
): boolean {
  return selectedId === undefined && !(listStatus === 'ready' && rowCount > 0);
}

export interface MasterDetailProps {
  /** The list pane's own content — a page decides what renders there (rows, tabs, its own
   *  loading/empty/error states); this component only supplies the pane shell. */
  readonly list: ReactNode;
  /** The selected item's detail — rendered once, reused as both the wide pane's body and the
   *  narrow sheet's content, so a page's own detail-vs-placeholder branching runs once regardless
   *  of layout. `null` means there is nothing to pick yet (an empty list, nothing selected): the
   *  wide layout then shows the list card alone instead of a second, contradictory empty card. */
  readonly detail: ReactNode;
  /** An optional sibling of the list pane's body (not wrapped further) — the approvals queue's own
   *  expiry note is the first example; the caller supplies its own `.md-pane-footer`-classed
   *  element (or omits this entirely). */
  readonly footer?: ReactNode;
  /** Whether something is selected — drives the narrow layout's `kit/sheet` (`open`); the wide
   *  layout's detail pane is always mounted regardless (its own `detail` content already covers
   *  "nothing selected" via a `kit/empty-state`). */
  readonly open: boolean;
  /** The sheet was dismissed (Escape, overlay click, or its close affordance) — narrow layout
   *  only; the caller clears its own selection (`onSelect(null)`). */
  readonly onClose: () => void;
  /** The narrow sheet's own header title — the wide layout has no equivalent chrome (the detail
   *  pane's own content carries its title). */
  readonly sheetTitle: ReactNode;
  /** `data-testid` shared by both hosts (the wide pane and the sheet content) — a page's tests
   *  find "the detail, however it is currently mounted" through this one id. */
  readonly detailTestId: string;
}

/**
 * components/kit/master-detail (console redesign P3-4 part B): the two-pane list/detail mechanics
 * `ApprovalQueuePage` (P3-4 part A, V6) first built for 待我审批, extracted so 任务 Tasks (the
 * second consumer) does not hand-roll the same layout again. A page still owns its own list
 * content, tabs, and detail content/placeholder branching — this component only supplies the
 * shell: a two-pane grid at ≥1180px (list card | detail card, each scrolling on its own via
 * `.md-pane-body`'s own `overflow-y`), or the list alone with the detail in a `kit/sheet` below
 * that width.
 *
 * Legacy 480: the detail renders once, into one host element that moves between the wide pane and
 * the sheet — crossing the breakpoint moves what is open (a disclosure, the lines unfolded in a
 * comparison, a half-filled form) instead of mounting the detail afresh in the other place.
 */
export function MasterDetail({
  list,
  detail,
  footer,
  open,
  onClose,
  sheetTitle,
  detailTestId,
}: MasterDetailProps) {
  const isNarrow = useMediaQuery(NARROW_MASTER_DETAIL_QUERY);
  const [host] = useState(createDetailHost);
  // A slot takes the host when it mounts; the slot left behind needs nothing (the host has moved).
  const attachHost = useCallback(
    (slot: HTMLElement | null) => {
      if (slot !== null && host !== null && host.parentNode !== slot) slot.appendChild(host);
    },
    [host],
  );
  const showDetail = isNarrow ? open : detail !== null;

  return (
    <>
      <div className={`md-layout md-layout--${isNarrow || detail === null ? 'narrow' : 'wide'}`}>
        <div className="md-pane md-list-pane">
          <div className="md-pane-body">{list}</div>
          {footer}
        </div>

        {!isNarrow && detail !== null ? (
          <div className="md-pane md-detail-pane" data-testid={detailTestId}>
            <div className="md-pane-body" ref={attachHost} />
          </div>
        ) : null}
      </div>

      {isNarrow ? (
        <Sheet
          open={open}
          onOpenChange={(next) => {
            if (!next) onClose();
          }}
        >
          <SheetContent data-testid={detailTestId}>
            <SheetHeader>
              <SheetTitle>{sheetTitle}</SheetTitle>
            </SheetHeader>
            <div className="contents" ref={attachHost} />
          </SheetContent>
        </Sheet>
      ) : null}

      {showDetail && host !== null ? createPortal(detail, host) : null}
    </>
  );
}

/** The detail's host: layout-transparent (`display: contents`), so the detail lays out as a direct
 *  child of whichever slot holds it, as it did before it had a host. */
function createDetailHost(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  const host = document.createElement('div');
  host.style.display = 'contents';
  return host;
}
