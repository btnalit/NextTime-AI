import type { CapabilityCaller } from '../../lib/clients.js';
import type { GrantRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../kit/sheet.js';
import { GrantGateForm } from './GrantGateForm.js';

export interface GrantGateDrawerProps {
  readonly http: CapabilityCaller;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Opened from a system card: fixes the gate, matching `GrantGateForm`'s own prop. */
  readonly lockedGatekeeper?: { readonly id: string; readonly name: string };
  readonly onGranted: (grants: readonly GrantRow[]) => void;
}

/**
 * components/access/GrantGateDrawer (S8 W2-U1, audit J6 "两处入口打开同一个抽屉"): the
 * `kit/sheet` shell around `GrantGateForm` — the one drawer both the Access page's primary action
 * and every system card's own "授权给成员" action open. `Sheet` (Radix Dialog) owns focus trap /
 * Escape / outside-click; `GrantGateForm` owns the actual picking and submission.
 */
export function GrantGateDrawer({
  http,
  open,
  onOpenChange,
  lockedGatekeeper,
  onGranted,
}: GrantGateDrawerProps) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="grant-gate-drawer">
        <SheetHeader>
          <SheetTitle>{t('授权给成员', 'Grant to a member')}</SheetTitle>
        </SheetHeader>
        {open ? (
          <GrantGateForm
            http={http}
            lockedGatekeeper={lockedGatekeeper}
            onGranted={onGranted}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
