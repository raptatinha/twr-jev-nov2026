import type { Page } from '@playwright/test';

/**
 * Collects what an exploratory tester would look at on a page: visible text,
 * console errors and failed network requests. Call `watch()` BEFORE navigating.
 */
export type PageState = {
  // What the page is for, in words ("list all books in the store"). Jev judges the page against it.
  purpose: string;
  url: string;
  title: string;
  // The visible text, whitespace squashed, cut to 3,000 characters.
  text: string;
  // Errors from the app's own scripts, and requests that failed (status 400+ or no response).
  consoleErrors: string[];
  failedRequests: string[];
};

/**
 * Known noise on DemoQA: its own script logs an error when the ads we block don't load.
 * Context quality matters: this one line was enough to split Jev between "pass" and "suspicious".
 */
const KNOWN_NOISE = /advertisement|GPT script|googletag/i;

/** Listens to one Playwright page and collects its errors. One watcher per test (see tests/fixtures.ts). */
export class PageWatcher {
  private readonly consoleErrors: string[] = [];
  private readonly failedRequests: string[] = [];

  constructor(private readonly page: Page) {}

  // Start listening. Must run BEFORE page.goto(), or the first errors are missed.
  watch(): void {
    // Only the app's own requests count. Third-party scripts (ads, analytics) are not what we test.
    const isApp = (url: string) => new URL(url).hostname.endsWith('demoqa.com');
    this.page.on('console', (msg) => {
      // Skip errors that come from other sites (blocked ads, trackers): noise in the state makes Jev unsure.
      const source = msg.location().url;
      if (msg.type() === 'error' && (!source || isApp(source)) && !KNOWN_NOISE.test(msg.text())) this.consoleErrors.push(msg.text().slice(0, 200));
    });
    // HTTP errors from the app's own API (e.g. our fake 500).
    this.page.on('response', (res) => {
      if (res.status() >= 400 && isApp(res.url())) this.failedRequests.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
    });
    // Requests that got no response at all (network error, aborted).
    this.page.on('requestfailed', (req) => isApp(req.url()) && this.failedRequests.push(`FAILED ${req.method()} ${new URL(req.url()).pathname}: ${req.failure()?.errorText}`));
  }

  /**
   * Exploration, not assertion: give the page a moment to finish its network calls.
   * (We don't know what "loaded" looks like on a broken page, so we can't wait for an element.)
   */
  async settle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }

  // Take the picture: everything a tester would look at, right now.
  async snapshot(purpose: string): Promise<PageState> {
    const text = (await this.page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    return {
      purpose,
      url: this.page.url(),
      title: await this.page.title(),
      // Small on purpose: Jev's state limit is generous, but context quality beats context size.
      text: text.slice(0, 3_000),
      // No duplicates, and at most 10 of each: repeated noise only makes the state longer.
      consoleErrors: [...new Set(this.consoleErrors)].slice(0, 10),
      failedRequests: [...new Set(this.failedRequests)].slice(0, 10),
    };
  }
}

/** The state as plain text, the same for Jev and for the LLM escalation. One fact per line. */
export function stateText(s: PageState): string {
  return [
    `Page purpose: ${s.purpose}`,
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    `Visible text: ${s.text || '(empty)'}`,
    `Console errors: ${s.consoleErrors.length ? s.consoleErrors.join(' | ') : 'none'}`,
    `Failed network requests: ${s.failedRequests.length ? s.failedRequests.join(' | ') : 'none'}`,
  ].join('\n');
}
