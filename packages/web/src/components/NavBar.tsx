export type NavRoute = 'chats' | 'approvals' | 'tasks' | 'connections';

const ROUTES: readonly {
  readonly route: NavRoute;
  readonly label: string;
  readonly hash: string;
}[] = [
  { route: 'chats', label: 'Chats', hash: '#/chats' },
  { route: 'approvals', label: 'Approvals', hash: '#/approvals' },
  { route: 'tasks', label: 'Tasks', hash: '#/tasks' },
  { route: 'connections', label: 'Connections', hash: '#/connections' },
];

/** components/NavBar: the four top-level views (design doc §7.6; docs/development-tasks.md S2.10
 *  deliverables 3-5) — hash links, no router library (S1.8's own "no UI framework or router
 *  library" convention). */
export function NavBar({ active }: { readonly active: NavRoute }) {
  return (
    <nav className="nav-bar">
      {ROUTES.map(({ route, label, hash }) => (
        <a key={route} href={hash} className={route === active ? 'nav-active' : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
