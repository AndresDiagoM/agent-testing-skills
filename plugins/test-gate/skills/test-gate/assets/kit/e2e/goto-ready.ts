/**
 * goto-ready.ts: `page.goto` plus the two ready signals, so an interaction right after it cannot be lost.
 *
 * Signals (set by the app templates in ../app/, see references/e2e-waiting.md):
 *   1. <html data-hydrated="true">        React hydrated the ROOT only.
 *   2. <html data-page-ready="<pathname>"> the page body hydrated and its effects ran; compared with the path the
 *                                          browser ended on, so a redirect waits for the page it landed on.
 *
 * Parameters (all optional, read when the module loads):
 *   E2E_READY_TIMEOUT_MS   wait budget per signal, default 45000. It only costs time when something is wrong, and it
 *                          is the margin Windows needs. Do not lower it to "speed up" a failing run.
 *   E2E_HYDRATED_ATTR      dataset key of signal 1, default "hydrated"   (html attribute data-hydrated)
 *   E2E_PAGE_READY_ATTR    dataset key of signal 2, default "pageReady"  (html attribute data-page-ready)
 *
 * Not covered: lazy islands (next/dynamic, widgets loading a script). Wait for their own element in the spec.
 * Not for API routes or downloads (no document to hydrate): use `page.goto` there.
 */
import { test as base, expect, type Page } from '@playwright/test';

const READY_TIMEOUT = Number(process.env.E2E_READY_TIMEOUT_MS) || 45_000;
const HYDRATED_KEY = process.env.E2E_HYDRATED_ATTR || 'hydrated';
const PAGE_READY_KEY = process.env.E2E_PAGE_READY_ATTR || 'pageReady';

const toAttr = (datasetKey: string): string => 'data-' + datasetKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export type GotoReadyOptions = NonNullable<Parameters<Page['goto']>[1]> & {
  /**
   * Also wait for the page marker (default true). Pass false only for a document that renders no page marker
   * (a third-party page, or a route that was not wrapped yet).
   */
  pageReady?: boolean;
};

export async function gotoReady(page: Page, url: string, options?: GotoReadyOptions): Promise<void> {
  const { pageReady = true, ...gotoOptions } = options ?? {};
  await page.goto(url, gotoOptions);
  await page.locator(`html[${toAttr(HYDRATED_KEY)}="true"]`).waitFor({ state: 'attached', timeout: READY_TIMEOUT });
  if (!pageReady) return;
  try {
    await page.waitForFunction(
      (key) => {
        const ready = document.documentElement.dataset[key];
        const path = window.location.pathname;
        return ready !== undefined && (ready === path || ready === decodeURI(path));
      },
      PAGE_READY_KEY,
      { timeout: READY_TIMEOUT },
    );
  } catch (cause) {
    const landed = new URL(page.url()).pathname;
    throw new Error(
      `gotoReady(${url}): the root hydrated but <html ${toAttr(PAGE_READY_KEY)}> never matched "${landed}". ` +
        'Does this page render the page marker (withPageReady)? Pass { pageReady: false } only if it must not.',
      { cause },
    );
  }
}

/** Fixture form: `test('...', async ({ gotoReady }) => { await gotoReady('/'); })`. */
export const test = base.extend<{ gotoReady: (url: string, options?: GotoReadyOptions) => Promise<void> }>({
  gotoReady: async ({ page }, provide) => {
    await provide((url, options) => gotoReady(page, url, options));
  },
});

export { expect };
