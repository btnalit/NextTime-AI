import type { SVGProps } from 'react';

/**
 * components/ui/Icon: inline SVG icons (16px grid, 1.75 stroke). No icon font, no CDN — the
 * console is served on a LAN host with no internet (deploy/caddy/Caddyfile), so every glyph is a
 * path in this file. Decorative by default (`aria-hidden`); pass `label` for a standalone icon
 * that carries meaning on its own.
 */
export type IconName =
  | 'chat'
  | 'approvals'
  | 'tasks'
  | 'connections'
  | 'close'
  | 'copy'
  | 'check'
  | 'chevron-right'
  | 'alert'
  | 'info'
  | 'plus'
  | 'arrow-left'
  | 'arrow-down'
  | 'eye'
  | 'eye-off'
  | 'refresh'
  | 'stop'
  | 'send'
  | 'key'
  | 'inbox'
  | 'cpu'
  | 'link'
  | 'clock'
  | 'user'
  | 'users'
  | 'shield'
  | 'logout'
  | 'grid'
  | 'search'
  // S8 W1-A3 (audit S2 "图标重复"): every lib/nav.ts destination needs a visually distinct icon —
  // these five cover concepts nothing above already fit (智能体/Agent, 模型/Models, 平台用户/Platform
  // users, 模块/Modules, 平台设置/Settings); `menu` and `more` are the mobile top bar's hamburger
  // and the chat header's overflow-menu trigger (audit C3).
  | 'bot'
  | 'sparkle'
  | 'badge'
  | 'box'
  | 'settings'
  | 'menu'
  | 'more';

const PATHS: Readonly<Record<IconName, string>> = {
  chat: 'M4 5h16v10H9l-5 4V5z',
  approvals: 'M12 3l8 3v6c0 4.5-3.4 7.7-8 9-4.6-1.3-8-4.5-8-9V6l8-3zm-3.5 9 2.5 2.5 4.5-5',
  tasks: 'M4 6h16M4 12h16M4 18h10',
  connections: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0V7zm5 9v5',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  check: 'M5 12.5 9.5 17 19 7.5',
  'chevron-right': 'M9 6l6 6-6 6',
  alert: 'M12 3 2.5 20h19L12 3zm0 6v5m0 3v.5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 8v5m0-8.5v.5',
  plus: 'M12 5v14M5 12h14',
  'arrow-left': 'M19 12H5m6-6-6 6 6 6',
  'arrow-down': 'M12 5v14m6-6-6 6-6-6',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'eye-off':
    'M3 3l18 18M10 10.6A3 3 0 0 0 13.4 14M6.5 6.7C3.8 8.5 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.3-1M9.9 6.2A10 10 0 0 1 12 6c6.5 0 10 6 10 6s-1 1.7-2.8 3.3',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  stop: 'M7 7h10v10H7z',
  send: 'M4 12 20 4l-4 16-4-7-8-1z',
  key: 'M15 3a6 6 0 1 0-4.2 10.2L3 21h4v-3h3v-3h2l2.2-2.2A6 6 0 0 0 15 3z',
  inbox: 'M4 4h16v16H4zM4 14h4l2 3h4l2-3h4',
  cpu: 'M8 8h8v8H8zM5 5h14v14H5zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3',
  link: 'M10 14 14 10M8 16l-2 2a3.5 3.5 0 0 1-5-5l2-2m11 5 2-2a3.5 3.5 0 0 0-5-5l-2 2',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M16 3.2a4 4 0 0 1 0 7.6M21.5 21v-1a5 5 0 0 0-3.5-4.8',
  shield: 'M12 3l8 3v6c0 4.5-3.4 7.7-8 9-4.6-1.3-8-4.5-8-9V6l8-3z',
  logout: 'M10 4H5v16h5M14 8l5 4-5 4m5-4H9',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  bot: 'M12 2v3M8 8h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zM9 13v.01M15 13v.01M9 17h6',
  sparkle: 'M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z',
  badge:
    'M4 5h16v14H4zM8 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 17c.5-2 2-3 4-3s3.5 1 4 3M14 9h4M14 13h4',
  box: 'M12 2 3 7v10l9 5 9-5V7l-9-5zM3 7l9 5 9-5M12 12v10',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  menu: 'M4 7h16M4 12h16M4 17h16',
  more: 'M12 5v.01M12 12v.01M12 19v.01',
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  readonly name: IconName;
  readonly size?: 's' | 'm' | 'l';
  /** Accessible label; when omitted the icon is decorative (`aria-hidden`). */
  readonly label?: string;
}

export function Icon({ name, size = 'm', label, className, ...rest }: IconProps) {
  const sizeClass = size === 's' ? ' icon-s' : size === 'l' ? ' icon-l' : '';
  return (
    <svg
      className={`icon${sizeClass}${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
