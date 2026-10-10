import { type Locator, type Page, expect } from '@playwright/test';

/**
 * e2e/lib/ux-lint.ts: the console's copy rules a journey asserts at the steps where it matters
 * (console UX audit §3.2), so a regression fails CI instead of waiting for the next walkthrough:
 *
 * - `expectReadableErrors`: every error on screen reads as a sentence in the viewer's language —
 *   a Chinese body that says what happened and what to do — and the wire code plus the kernel's
 *   own text sit only inside the collapsed 「技术细节」 (`components/kit/error-details`), never in
 *   the body (P1-1).
 * - `expectNoHalfEnglish`: no Chinese sentence trailing off into an English clause (P2-1), the
 *   shape `…已发布 Published — …` that earlier copy kept leaving behind.
 * - `watchForbiddenCapabilityCalls`: a page the signed-in role is meant to use never asks the
 *   kernel for something that role cannot do (a 403 on `/api/cap/*` means the page offered a
 *   control or prefetched data it should have known was out of reach).
 *
 * The page-wide "implementation detail leaking into copy" patterns (UUIDs, raw enums, env vars)
 * stay in `00-gates/content.spec.ts`, which scans every surface against a ratchet baseline.
 */

/** Anything the console renders as an error: the banner, an inline error, a dialog's error box. */
const ERROR_SURFACES =
  '.error-banner, [role="alert"][data-error-code], [role="alert"]:has(details.error-details)';

const CJK = /[一-鿿]/;

/** A Chinese character, optional closing punctuation, then a capitalised English clause running
 *  into a dash — the half-translated trailing copy audit P2-1 lists. */
const HALF_ENGLISH = /[一-鿿][。）]?\s+[A-Z][a-z]+(?: [a-z]+)*\s?—/;

interface ErrorSurfaceText {
  readonly code: string | null;
  /** The text a reader sees without opening 「技术细节」. */
  readonly body: string;
  readonly hasDetails: boolean;
}

async function readErrorSurface(surface: Locator): Promise<ErrorSurfaceText> {
  return surface.evaluate((node) => {
    const element = node as HTMLElement;
    const copy = element.cloneNode(true) as HTMLElement;
    for (const details of copy.querySelectorAll('details.error-details')) details.remove();
    const codeElement = element.querySelector('details.error-details .error-banner-code');
    return {
      code: element.getAttribute('data-error-code') ?? codeElement?.textContent?.trim() ?? null,
      body: (copy.textContent ?? '').replace(/\s+/g, ' ').trim(),
      hasDetails: element.querySelector('details.error-details') !== null,
    };
  });
}

/** Asserts every visible error under `scope` (default: the whole page) follows P1-1. Call it
 *  after the step that is expected to show an error, once that error is visible. */
export async function expectReadableErrors(page: Page, scope?: Locator): Promise<void> {
  const surfaces = (scope ?? page.locator('body')).locator(ERROR_SURFACES);
  const count = await surfaces.count();
  for (let index = 0; index < count; index += 1) {
    const surface = surfaces.nth(index);
    if (!(await surface.isVisible())) continue;
    const { code, body, hasDetails } = await readErrorSurface(surface);
    expect(body, 'an error must say what happened in Chinese').toMatch(CJK);
    expect(hasDetails, `error ${code ?? '(no code)'} must fold its code into 「技术细节」`).toBe(
      true,
    );
    if (code) {
      expect(body, `the code ${code} belongs in 「技术细节」, not the body`).not.toContain(code);
    }
  }
}

/** Asserts no visible text under `scope` trails off from Chinese into an English clause. */
export async function expectNoHalfEnglish(scope: Locator): Promise<void> {
  const text = (await scope.innerText()).replace(/[ \t]+/g, ' ');
  for (const line of text.split('\n')) {
    expect(line, 'half-translated copy (Chinese trailing into English)').not.toMatch(HALF_ENGLISH);
  }
}

/** Records every `/api/cap/*` call that the kernel answered 403 from now on; call the returned
 *  function at the end of the journey to assert there were none. */
export function watchForbiddenCapabilityCalls(page: Page): () => void {
  const forbidden: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.status() === 403 && url.pathname.startsWith('/api/cap/')) {
      forbidden.push(url.pathname);
    }
  });
  return () => {
    expect(forbidden, 'capability calls the signed-in role was refused').toEqual([]);
  };
}

/**
 * Collects the calls the console refused on its own (`lib/http-client.ts`'s
 * `CAPABILITY_REFUSED_LOCALLY_EVENT`): a page asking for something its reader's role cannot have
 * never reaches the network, so `watchForbiddenCapabilityCalls` cannot see it (#541 review M1).
 * Install before the first navigation; `take()` returns and clears what was refused since the
 * last call.
 */
export async function watchLocalRefusals(page: Page): Promise<{ take: () => Promise<string[]> }> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __localRefusals: string[] }).__localRefusals = seen;
    window.addEventListener('nexttime:capability-refused-locally', (event) => {
      seen.push((event as CustomEvent<{ capability: string }>).detail.capability);
    });
  });
  return {
    take: () =>
      page.evaluate(() => {
        const seen = (window as unknown as { __localRefusals?: string[] }).__localRefusals ?? [];
        return seen.splice(0, seen.length);
      }),
  };
}
