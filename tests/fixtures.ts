import { test as base, expect } from '@playwright/test';
import { PageWatcher } from '../src/explore/page-state';
import { stopTelemetry } from '../src/telemetry';
import { BooksPage } from './pages/books-page';
import { LoginPage } from './pages/login-page';

/**
 * Shared fixtures. Tests import `test` and `expect` from here.
 * - booksPage / loginPage: Page Objects, created for you.
 * - watcher: starts recording console errors and failed requests before the test navigates.
 * - telemetry (automatic, once per worker): flushes OpenTelemetry spans and metrics when the worker ends.
 */
// The fixtures a test can ask for by name, e.g. async ({ booksPage, watcher }) => ...
type Fixtures = { booksPage: BooksPage; loginPage: LoginPage; watcher: PageWatcher };

/** DemoQA shows ads. They move the layout and slow pages down, so the demos block them. */
const AD_HOSTS = /doubleclick\.net|googlesyndication|googletagservices|adservice\.google|amazon-adsystem|pubmatic|criteo|prebid|adnxs|rubiconproject|openx|taboola|outbrain|ezoic/;

// Playwright's `test`, extended with our fixtures. Each fixture: set up, `use()` it in the test, then clean up.
export const test = base.extend<Fixtures, { telemetry: void }>({
  // Every page blocks ads. (Project 1 never asks for a page, so it never starts a browser.)
  page: async ({ page }, use) => {
    // Any request to an ad host is cancelled before it leaves the browser.
    await page.route(AD_HOSTS, (route) => route.abort());
    await use(page);
  },
  booksPage: async ({ page }, use) => {
    // Page Objects: the test gets them ready-made, on the same (ad-free) page.
    await use(new BooksPage(page));
  },
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  watcher: async ({ page }, use) => {
    // Start listening for console errors and failed requests BEFORE the test navigates.
    const watcher = new PageWatcher(page);
    watcher.watch();
    await use(watcher);
    // A delayed fake response may still be pending when the test ends.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
  // Runs once per worker, automatically (no test asks for it): flush OpenTelemetry when the worker ends.
  telemetry: [
    async ({}, use) => {
      await use();
      await stopTelemetry();
    },
    { scope: 'worker', auto: true },
  ],
});

// Re-exported so tests import both `test` and `expect` from this one file.
export { expect };
