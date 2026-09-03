import type { ReactNode } from 'react';

/** components/ui/Kbd: a key cap, for shortcut hints ("Enter to send"). */
export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
