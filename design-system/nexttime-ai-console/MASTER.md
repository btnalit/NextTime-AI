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

**Design system v3 (2026-09-27).** The maintainer rejected v2.1's navy-tinted ink ("好难看") and pointed
at the MihomoOrbit console as the reference: colour comes from a vivid primary, the active-navigation
pill, faint multi-hue page ambience and data accents — never from tinting body text. Ink is clean
neutral; the §5.9 governance semantics are unchanged.

### Color palette

**Brand** — one vivid indigo-blue scale (600 = the primary, `#3551f9`, white label 5.68:1):

| Token | Hex |
|---|---|
| `--brand-50` | `#eef1ff` |
| `--brand-100` | `#dfe4ff` |
| `--brand-200` | `#c3ccff` |
| `--brand-300` | `#9aa8fd` |
| `--brand-400` | `#6d80fb` |
| `--brand-500` | `#4d67fa` |
| `--brand-600` | `#3551f9` |
| `--brand-700` | `#2b44e6` |
| `--brand-800` | `#2338c9` |
| `--brand-900` | `#1f309f` |
| `--brand-950` | `#151e5e` |

**Roles (light / dark)** — dark is designed separately, not inverted:

| Role | Token | Light | Dark |
|---|---|---|---|
| Page background | `--bg` (+ `--bg-ambient`) | `#f4f6f9` + blue / violet / cyan washes | `#0f1018` (never `#000`) + stronger washes |
| Card surface | `--surface-1` | `#ffffff` | `#161823` |
| Subtle fill | `--surface-2` | `#f7f8fb` | `#1b1d29` |
| Pressed / hover on page / table head | `--surface-3` | `#eef1f5` | `#20222c` |
| Border | `--border` | `#e3e7ee` | `#292a34` |
| Strong border / input | `--border-strong` | `#cfd5df` | `#3a3c48` |
| Text (headings and body) | `--text` | `#30333f` (soft charcoal, never pure black) | `#dcdfe8` (off-white, never `#fff`) |
| Secondary text | `--text-2` | `#5a5f6d` | `#aab0c0` |
| Caption / section label | `--text-3` | `#666a78` | `#98a1b5` |
| Primary action, active nav pill | `--primary` / hover / press | `#3551f9` / `#2b44e6` / `#2338c9` | `#4466ee` / `#3f60e8` / `#3858e0` |
| Text on primary | `--text-on-primary` | `#ffffff` | `#ffffff` (a saturated fill in both themes) |
| Link / selection / focus | `--accent`, `--accent-soft` | `#3551f9`, `#eef1ff` | `#8aa2ff`, 18% primary tint |
| Product mark | `--brand-gradient` | `#3551f9` → `#7b61ff` | same |

**Governance semantics** — fixed, one colour per meaning, never decorative (§5.9 principle 2):

| Meaning | Token | Light |
|---|---|---|
| Observe / read-only / collector | `--observe` | `#0f766e` |
| Execute / pending / warn / medium impact | `--warn` | `#b45309` |
| High impact / irreversible / reject / failed | `--danger` | `#b42318` |
| Executed / published / healthy | `--ok` | `#157347` |
| System / proposal / default | `--info` | `#3551f9` |
| Archived / superseded / residue | `--muted` | `#626b7b` |

Every semantic colour has a `-soft` background for chips. No orange CTA — amber already means
"pending", so a second warm accent would collide. Decorative multi-hue (icon tiles, data series) must
not reuse a governance colour; add a `--deco-*` token when a page first needs one.

Contrast is enforced by `packages/web/src/styles/tokens-contrast.test.ts`: every text token (and
`--accent`) ≥ 4.5:1 on every neutral and semantic-soft background, in both themes, plus the primary
label on all three primary states.

### Typography

- **Families:** Geist Sans (Latin UI, the reference console's face) + Noto Sans SC (CJK) + Geist Mono
  (ids, operations, code). Self-hosted and bundled (the console runs on a LAN host with no
  internet); Noto Sans SC is unicode-range sliced.
- **Scale (six stops, 12px floor):** 24/600 page title · 19/600 section · 16/600 dialog title ·
  14/400 body and chat (line-height 1.6) · 13/400 dense tables and forms · 12/400 caption.
- **Weights:** 400 / 500 / 600 / 700, all real faces (Noto Sans SC 600 and 700 included — CJK
  semibold stays semibold, never a synthesised bold). Prefer 500 / 600 over 700 for the soft, light
  read of the reference console; 700 only for the wordmark. Tabular numbers in data views.
- **Ink:** one neutral `--text` for headings and body, `--text-2` / `--text-3` below it. Section
  labels (`.section-title`, drawer-section titles) are `--text-3`, 12/600, uppercase, 0.08em
  tracking. No negative letter-spacing on CJK titles.

### Spacing

Dense console scale (density 8): 4 / 8 / 12 / 16 / 24 / 32 (`--space-1`…`--space-6`). Card padding 16;
page gutter 24; row padding 10×16.

### Shape and depth

- **Radius:** 6 chip · 8 control and nav item · 14 card.
- **Three surface levels:** page (`--bg` + `--bg-ambient`, fixed) → card (`--surface-1` + 1px
  `--border` + `--shadow-card`) → floating (`--shadow-1`: drawer, popover, dropdown, toast, dialog).
  `--shadow-raised` is the hover lift of an interactive card; `--shadow-primary` is the soft primary
  glow under the primary button, the active nav pill and the product mark.

| Level | Token | Light value |
|---|---|---|
| Card | `--shadow-card` | `0 1px 2px rgba(31,34,48,.04), 0 1px 3px rgba(31,34,48,.06)` |
| Raised | `--shadow-raised` | `0 2px 4px rgba(31,34,48,.05), 0 8px 20px rgba(31,34,48,.08)` |
| Floating | `--shadow-1` | `0 4px 12px rgba(31,34,48,.10), 0 16px 40px rgba(31,34,48,.14)` |
| Primary glow | `--shadow-primary` | `0 2px 4px rgba(53,81,249,.18), 0 6px 16px rgba(53,81,249,.28)` |

### Motion

`--dur-fast` 150ms, `--dur` 200ms, `--ease-out` `cubic-bezier(0.2,0,0,1)`; `--transition` is the
default for hover / press / colour changes; open/close of sheets and dialogs 200ms fade + small
translate. `prefers-reduced-motion` collapses all of it (`base.css`). No bouncy / overshoot easing on
data UI.

---

## Component Specs

- **Buttons:** one brand primary per page (`--primary`, hover and press steps, `--shadow-primary`);
  secondary = `--surface-2` fill + `--border-strong`; ghost = text-2, `--surface-2` on hover; danger =
  `--danger-soft` → solid `--danger` on hover; destructive solid stays disabled until the confirm is
  satisfied (typed target for irreversible). Height 36 (28 for in-row / toast); focus ring 2px
  `--accent`. Three or more secondary actions → overflow menu.
- **Navigation:** sits on the page background (no panel of its own); items 34px, 14/500, `--text-2`
  with `--text-3` icons, hover `--surface-3`; the active item is a solid `--primary` pill with a white
  label and icon and `--shadow-primary`. Workspace block is a white card.
- **Segmented tabs:** recessed track; the selected segment is a white chip with `--shadow-card` and an
  `--accent` label.
- **Cards / lists:** `--surface-1`, 1px `--border`, radius 14, `--shadow-card`; list rows 10×16 with
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

Left navigation on the page background (single-line items, grouped 使用 / 治理 / 平台, workspace card on
top, connection + user at the bottom, primary pill for the current section); page header = breadcrumb +
24px title + one-line description + one primary action; content in white cards over the ambient page
background. Chat is three panes (nav / chat list / conversation). Approvals, tasks and the catalog are
master-detail (`kit/master-detail`).

## Anti-patterns (do not ship)

- Black / white / grey only with no brand colour anywhere; ink primary buttons; `#000` dark
  backgrounds or `#fff` dark-theme text.
- **Tinted ink** — navy / slate-navy headings or body text (design system v2.1, rejected 2026-09-27):
  colour goes into the primary, the nav pill, chips, data accents and ambience, not into running text.
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
