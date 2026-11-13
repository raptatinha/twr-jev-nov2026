import type { Page, TestInfo } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAR, FLAG, judgePage, type Judgement } from '../src/explore/judge';
import type { PageState } from '../src/explore/page-state';
import { RUNS_DIR, runId } from '../src/meter';
import { models } from '../src/models';
import { usd } from '../src/report/stats';
import { expect, test } from './fixtures';

/**
 * Project 2: AI-powered exploratory testing with Jev + Playwright.
 *
 * WHERE THE LINE IS
 *   - Playwright assertions decide pass or fail. They are deterministic.
 *   - Jev never fails a test. It decides what a human should LOOK AT: every page it doesn't
 *     call "pass" goes into a review list (annotation + the "Needs review" summary).
 *
 * The same pages run twice:
 *   1. the real Book Store: assertions pass, Jev should stay quiet,
 *   2. with the API intercepted (page.route): some breakages the assertions catch,
 *      some they don't. Jev flags both kinds for review.
 * Nothing is planted in the app: the "bugs" are fake API responses.
 *
 *   npm run p2      then   npm run report
 */
// Without a Jev key there is nothing to judge: skip the whole file.
test.skip(!models().jev.available(), 'JEV_API_KEY is not set (see .env.example)');

// The review list lives on disk (runs/<id>/review.jsonl), so every worker adds to the same list.
const reviewFile = () => join(RUNS_DIR, runId(), 'review.jsonl');

/** Ask Jev about the page, report it, and put anything that isn't "pass" on the review list. Never fails the test. */
async function review(page: Page, state: PageState, testInfo: TestInfo, formMessage?: string): Promise<Judgement> {
  // 1. Ask Jev (and, for unsure pages, the LLM) about the page.
  const judgement = await test.step('Jev reviews the page', () => judgePage(state, testInfo.title, { formMessage }));

  const note = (type: string, description: string) => testInfo.annotations.push({ type, description });
  // 2. Report it as annotations: the verdict, the "looks broken" number and its band, cost and time.
  const flagged = judgement.verdict !== 'pass';
  note(flagged ? '⚠ needs review' : 'Jev review', `${judgement.verdict} (decided by ${judgement.decidedBy})`);
  const b = judgement.looksBroken;
  // Which band the number fell in: pass, flag, or escalated to the LLM.
  const zone = b === null ? 'no answer' : b <= CLEAR ? `<= ${CLEAR}: pass` : b >= FLAG ? `>= ${FLAG}: flag` : `between ${CLEAR} and ${FLAG}: escalated`;
  note('looks broken (decides)', `${b === null ? '-' : b.toFixed(2)} (${zone})`);
  note('Jev verdict (label)', `${judgement.jevVerdict} · confidence ${judgement.jevConfidence.toFixed(2)} (calibrated)`);
  if (judgement.messageClarity !== null) note('message clarity (0-2)', judgement.messageClarity.toFixed(2));
  if (judgement.reason) note('LLM reason', judgement.reason);
  note('cost / time', `${usd(judgement.costUsd)} · ${judgement.latencyMs} ms`);

  // 3. Attach exactly what Jev saw, and a screenshot, so a human can check the call.
  await testInfo.attach('page state sent to Jev', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
  await testInfo.attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' });

  // 4. Anything not "pass" goes on the review list. Note: no expect() here: Jev never fails a test.
  if (flagged) {
    mkdirSync(join(RUNS_DIR, runId()), { recursive: true });
    appendFileSync(reviewFile(), `${JSON.stringify({ test: testInfo.title, url: state.url, ...judgement })}\n`);
  }
  return judgement;
}

// Part 1: the real store. The assertions pass, and Jev should stay quiet ("pass").
test.describe('E2E: the real Book Store', () => {
  test('book list', { tag: '@p2' }, async ({ page, booksPage, watcher }, testInfo) => {
    await booksPage.open();
    await watcher.settle();
    // Open, let the page settle, then Jev reviews what a user would see. The purpose tells Jev what the page is for.
    await review(page, await watcher.snapshot('The book list of an online book store'), testInfo);
    // The assertion decides.
    await expect(booksPage.bookLinks.first()).toBeVisible();
  });

  test('search for JavaScript books', { tag: '@p2' }, async ({ page, booksPage, watcher }, testInfo) => {
    await booksPage.open();
    await booksPage.search('JavaScript');
    await watcher.settle();
    await review(page, await watcher.snapshot('Book store search results for "JavaScript"'), testInfo);
    // The assertion: the real store has 4 JavaScript books.
    await expect(booksPage.bookLinks).toHaveCount(4);
  });

  test('book details', { tag: '@p2' }, async ({ page, booksPage, watcher }, testInfo) => {
    await booksPage.open();
    await booksPage.openBook('Learning JavaScript Design Patterns');
    await watcher.settle();
    await review(page, await watcher.snapshot('The details page of one book: ISBN, title, author, publisher, pages, description'), testInfo);
    // The assertion: the right book's details are shown.
    await expect(page.getByText('Addy Osmani')).toBeVisible();
  });

  test('login with a wrong password', { tag: '@p2' }, async ({ page, loginPage, watcher }, testInfo) => {
    await loginPage.open();
    // A login that must fail: an unknown user. The error message is what we want Jev to rate.
    await loginPage.login('jev_training_unknown_user', 'not-the-password');
    const message = page.getByText('Invalid username or password!');
    await expect(message).toBeVisible();
    await watcher.settle();
    const state = await watcher.snapshot('A login form, after the user typed a wrong password. It should explain the problem.');
    // Passing the message adds the third question: how clear is it?
    await review(page, state, testInfo, await message.innerText());
  });
});

// Part 2: the same store with the books API faked by page.route. The app itself is untouched.
test.describe('E2E: a broken Book Store (API intercepted)', () => {
  const purpose = 'The book list of an online book store';

  // Breakages the assertion MISSES: a typical smoke check passes, so only Jev's review list shows them.

  test('placeholder data: the assertion passes, Jev flags it', { tag: '@p2' }, async ({ page, booksPage, watcher }, testInfo) => {
    await page.route('**/BookStore/v1/Books', (route) =>
      route.fulfill({
        json: {
          books: [
            // Fake books with placeholder values: 'undefined', 'Lorem ipsum', '{{publisher}}', negative page counts.
            { isbn: '1', title: 'undefined', subTitle: '', author: 'null', publisher: '{{publisher}}', pages: 0, description: '', website: '' },
            { isbn: '2', title: 'Lorem ipsum dolor', subTitle: '', author: 'TODO', publisher: 'test', pages: -1, description: '', website: '' },
          ],
        },
      }),
    );
    await booksPage.open();
    await watcher.settle();
    await review(page, await watcher.snapshot(purpose), testInfo);
    await expect(booksPage.bookLinks.first(), 'the smoke check: the store lists books').toBeVisible();
  });

  test('empty store: the assertion passes, Jev flags it', { tag: '@p2' }, async ({ page, booksPage, watcher }, testInfo) => {
    // Fake an empty list: the page loads fine, but there are no books.
    await page.route('**/BookStore/v1/Books', (route) => route.fulfill({ json: { books: [] } }));
    await booksPage.open();
    await watcher.settle();
    await review(page, await watcher.snapshot(purpose), testInfo);
    await expect(booksPage.searchBox, 'the smoke check: the store page loads').toBeVisible();
  });

  // Breakages the assertion CATCHES: the test fails, as it should. test.fail() marks
  // the failure as expected in this demo. Jev's review adds a first triage for the human.

  test('HTTP 500: the assertion fails, Jev adds a triage', { tag: '@p2' }, async ({ page, booksPage, watcher }, testInfo) => {
    // test.fail(): this test is EXPECTED to fail; Playwright reports it as passed when it does.
    test.fail(true, 'Expected: the books API returns 500, so the store is broken');
    // Fake a server error on the books API.
    await page.route('**/BookStore/v1/Books', (route) => route.fulfill({ status: 500, json: { code: 500, message: 'Internal Server Error' } }));
    await booksPage.open();
    await watcher.settle();
    await review(page, await watcher.snapshot(purpose), testInfo);
    await expect(booksPage.bookLinks.first(), 'the store lists books').toBeVisible();
  });

  test('slow API: the assertion fails, Jev adds a triage', { tag: '@p2' }, async ({ page, booksPage, watcher }, testInfo) => {
    test.fail(true, 'Expected: the books API takes 15 s, longer than the assertion waits');
    // Hold the response for 15 s: a user looking at the page in the first seconds sees no books.
    await page.route('**/BookStore/v1/Books', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      // After the wait, let the real request through.
      await route.continue();
    });
    await booksPage.open();
    await watcher.settle();
    await review(page, await watcher.snapshot(`${purpose}, 5 seconds after opening it`), testInfo);
    await expect(booksPage.bookLinks.first(), 'the store lists books').toBeVisible({ timeout: 5_000 });
  });
});

// The last test: the review list, as annotations and as a Markdown attachment. This is what a human reads instead of every run.
test('Needs review: what Jev flagged for a human', { tag: '@p2' }, async ({}, testInfo) => {
  const items = existsSync(reviewFile())
    ? readFileSync(reviewFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Judgement & { test: string; url: string })
    : [];
  testInfo.annotations.push({ type: 'flagged', description: `${items.length} page(s) to review` });
  for (const item of items) {
    testInfo.annotations.push({ type: `⚠ ${item.test}`, description: `${item.verdict} · Jev ${item.jevVerdict} (${item.jevConfidence.toFixed(2)})${item.reason ? ` · ${item.reason}` : ''}` });
  }
  // The same list as Markdown, ready to paste into a ticket or a chat.
  const md = ['# Needs review', '', ...items.map((i) => `- **${i.test}** (${i.url}): ${i.verdict}, Jev ${i.jevVerdict} at ${i.jevConfidence.toFixed(2)}${i.reason ? `. LLM: ${i.reason}` : ''}`)].join('\n');
  await testInfo.attach('needs-review.md', { body: md || 'Nothing flagged.', contentType: 'text/markdown' });
});
