# Design System Master File — NextTime AI Console

> **Logic:** when building a page, first check `design-system/nexttime-ai-console/pages/<page>.md`; if it
> exists its rules override this file, otherwise follow this file.
>
> **Project:** NextTime AI console (governance console for an AI-agent control plane: chats with the
> entry agent, approvals, connected systems + authorization, capability catalog, audit / graph,
> platform administration). **Generated** 2026-09-26 with ui-ux-pro-max (`--density 8 --motion 4
> --variance 3`, query "B2B SaaS admin console trustworthy professional blue productivity security
> governance"), then **reconciled** with the maintainer-approved 2026-09-18 artboards
> (`docs/console-completion-plan.md` §5.9) and the frontend-productization standard. Values live in
> `packages/web/src/styles/tokens.css` (the only stylesheet allowed colour / px literals); components
> consume token names, never raw hex.

---

## Global Rules

### Color palette

**Brand** — one scale around the §5.9 accent (600 = `#1f4fd6`, 6.3:1 on white):

| Token | Hex |
|---|---|
| `--brand-50` | `#eef3fe` |
| `--brand-100` | `#dce6fd` |
| `--brand-200` | `#bccffb` |
| `--brand-300` | `#8fb0f7` |
| `--brand-400` | `#5b86f0` |
| `--brand-500` | `#3563e6` |
| `--brand-600` | `#1f4fd6` |
| `--brand-700` | `#1a40b0` |
| `--brand-800` | `#1b378e` |
| `--brand-900` | `#1c3271` |
| `--brand-950` | `#152046` |

**Roles (light / dark)** — dark is designed separately, not inverted:

| Role | Token | Light | Dark |
|---|---|---|---|
| Page background | `--bg` | `#f3f5fa` | `#0b1020` (deep tinted navy, never `#000`) |
| Card surface | `--surface-1` | `#ffffff` | `#111829` |
| Subtle fill / hover | `--surface-2` | `#f7f9fc` | `#161f34` |
| Pressed / table head | `--surface-3` | `#edf1f7` | `#1c2740` |
| Border | `--border` | `#e1e6ef` | `#25304a` |
| Strong border / input | `--border-strong` | `#c8d0dc` | `#35425f` |
| Text | `--text` | `#111a2e` | `#e6ebf5` (off-white, never `#fff`) |
| Secondary text | `--text-2` | `#465167` | `#aab4c8` |
| Caption | `--text-3` | `#5f6672` | `#98a2b6` |
| Primary action | `--primary` / hover / press | `#1f4fd6` / `#1a40b0` / `#1b378e` | `#7aa2ff` / `#93b4ff` / `#a9c3ff` |
| Text on primary | `--text-on-primary` | `#ffffff` | `#0b1020` |
| Link / selection / focus | `--accent`, `--accent-soft` | `#1f4fd6`, `#e8eefc` | `#7aa2ff`, 16% tint |

**Governance semantics** — fixed, one colour per meaning, never decorative (§5.9 principle 2):

| Meaning | Token | Light |
|---|---|---|
| Observe / read-only / collector | `--observe` | `#0f766e` |
| Execute / pending / warn / medium impact | `--warn` | `#b45309` |
| High impact / irreversible / reject / failed | `--danger` | `#b42318` |
| Executed / published / healthy | `--ok` | `#157347` |
| System / proposal / default | `--info` | `#1f4fd6` |
| Archived / superseded / residue | `--muted` | `#626b7b` |

Every semantic colour has a `-soft` background for chips. No orange CTA (the generator's suggestion) —
amber already means "pending", so a second warm accent would collide.

Contrast is enforced by `packages/web/src/styles/tokens-contrast.test.ts`: every text token ≥ 4.5:1 on
every neutral and semantic-soft background, in both themes, plus the primary label on all three
primary states.

### Typography

- **Families:** IBM Plex Sans (Latin UI) + Noto Sans SC (CJK) + IBM Plex Mono (ids, operations, code).
  Self-hosted and bundled (the console runs on a LAN host with no internet); Noto Sans SC is
  unicode-range sliced. Not Plus Jakarta Sans / Fira (generator output) — Chinese-first UI.
- **Scale (six stops, 12px floor):** 24/700 page title · 19/600 section · 16/600 dialog title ·
  14/400 body and chat (line-height 1.6) · 13/400 dense tables and forms · 12/400 caption.
- **Weights:** 400 / 500 / 600 / 700. Tabular numbers in data views.

### Spacing

Dense console scale (density 8): 4 / 8 / 12 / 16 / 24 / 32 (`--space-1`…`--space-6`). Card padding 16;
page gutter 24; row padding 10×16.

### Shape and depth

- **Radius:** 6 chip · 8 control · 12 card.
- **Three surface levels:** page (`--bg`) → card (`--surface-1` + 1px `--border` + `--shadow-card`) →
  floating (`--shadow-1`: drawer, popover, dropdown, toast, dialog). `--shadow-raised` is the hover lift
  of an interactive card. Shadows are tinted with the ink hue, soft and short.

| Level | Token | Light value |
|---|---|---|
| Card | `--shadow-card` | `0 1px 2px rgba(17,26,46,.04), 0 1px 3px rgba(17,26,46,.06)` |
| Raised | `--shadow-raised` | `0 2px 4px rgba(17,26,46,.05), 0 6px 16px rgba(17,26,46,.08)` |
| Floating | `--shadow-1` | `0 4px 12px rgba(17,26,46,.10), 0 16px 40px rgba(17,26,46,.14)` |

### Motion

`--dur-fast` 150ms, `--dur` 200ms, `--ease-out` `cubic-bezier(0.2,0,0,1)`; `--transition` is the
default for hover / press / colour changes; open/close of sheets and dialogs 200ms fade + small
translate. `prefers-reduced-motion` collapses all of it (`base.css`). No bouncy / overshoot easing on
data UI.

---

## Component Specs

- **Buttons:** one brand primary per page (`--primary`, hover and press steps, `--shadow-card`);
  secondary = `--surface-2` fill + `--border-strong`; ghost = text-2, `--surface-2` on hover; danger =
  `--danger-soft` → solid `--danger` on hover; destructive solid stays disabled until the confirm is
  satisfied (typed target for irreversible). Height 36 (28 for in-row / toast); focus ring 2px
  `--accent`. Three or more secondary actions → overflow menu.
- **Cards / lists:** `--surface-1`, 1px `--border`, radius 12, `--shadow-card`; list rows 10×16 with
  hairline dividers, hover `--surface-2`, selected `--accent-soft`; header row with title left, actions
  right.
- **Inputs / selects:** `kit/select` / `kit/textarea` — 1px `--border-strong`, radius 8, focus ring;
  width fits content (selects ≤ 360px), never a full-width native control.
- **Chips:** radius 6, semantic `-soft` background + semantic text; always paired with a label, never
  colour alone.
- **Ids:** name + type + truncated mono id + copy button (`RefChip`); a bare id only when no name
  resolves, greyed.
- **States:** every data view has loading (`kit/skeleton`), empty (`kit/empty-state`: icon, a title
  that names the object, a next action) and error (`ErrorBanner` with retry).
- **Dialogs / sheets:** floating level, overlay `--overlay`; confirm tiers low / medium / irreversible
  (`kit/confirm`).

## Page pattern

Persistent left navigation (single-line items, grouped 使用 / 治理 / 平台, workspace block on top,
connection + user at the bottom); page header = breadcrumb + 24px title + one-line description + one
primary action; content in cards on the tinted page background. Chat is three panes (nav / chat list
/ conversation). Approvals are master-detail.

## Anti-patterns (do not ship)

- Black / white / grey only; ink primary buttons; `#000` dark backgrounds or `#fff` dark-theme text.
- Cards that are only a 1px border on a flat background (use the card level).
- Controls without hover / focus / press feedback; instant snaps where a 150–200ms transition belongs.
- Unstyled native selects, tables, file inputs; full-width selects.
- Blank areas where loading / empty / error belongs; empty states that don't name the object.
- Bilingual residue in one locale ("来源 Source"); raw wire kinds shown to people.
- Emoji as icons; decorative colour that reuses a governance meaning.

## Pre-delivery checklist

- [ ] Tokens only (no raw hex outside `tokens.css`); `pnpm ci:guards` green.
- [ ] Contrast test green; axe baseline not regressed (never baseline an axe regression).
- [ ] Hover / focus-visible / active / disabled / loading on every control.
- [ ] Loading / empty / error on every data view.
- [ ] Screenshots reviewed at 1440 / 1280 / 768 (CI gate) against this file and the approved artboards;
      dark theme and ~390px reviewed for the changed pages.
- [ ] `prefers-reduced-motion` respected.
