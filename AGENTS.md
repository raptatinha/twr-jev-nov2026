# Rules for AI agents in jev-training

Read by Codex, Cursor and GitHub Copilot. Claude Code reads it through `CLAUDE.md`.

## What this is

Workshop demos: Jev (a System One decision model) compared with LLMs, in TypeScript + Playwright.
Playground: https://demoqa.com/books. The step-by-step guide is `guide/guide.md`.

## Must

- Every model call goes through `track()` or `decide()` in `src/meter.ts`. Never call a model API directly from a test or script: the numbers would be missing.
- Prices live only in `src/prices.ts`, with a date and a source. Model IDs come from `.env`.
- Tokens come from each vendor's `usage` field. Never estimate tokens.
- Explore before generating selectors: open the page with `playwright-cli` or Playwright MCP (`.mcp.json`) and read the snapshot. Never invent a locator.
- Locators: `getByRole` > `getByLabel` > `getByPlaceholder` > `getByText` > `getByTestId`. Page objects in `tests/pages/`, given to tests by fixtures in `tests/fixtures.ts`.
- Web-first assertions (`await expect(locator).toBeVisible()`); one tag per test (`@p1`, `@p2`, `@p3`).
- Playwright assertions decide pass or fail. A Jev (or LLM) verdict never fails a test: it adds an annotation and a review-list entry.
- Run what you changed: `npm run typecheck`, then the matching `npm run p1|p2|p3` (needs API keys).
- Edit `guide/guide.md`, then `npm run guide`. Never edit `guide/guide.html` by hand.

## Never

- `page.waitForTimeout()` or any sleep in a test. (The 15 s delay inside the "too slow" `page.route` simulates a slow API; it is not a wait.)
- Keys, tokens or passwords in code, logs or reports. Keys only in `.env`, which is ignored by git.
- Planting bugs in the app: simulate failures with `page.route`.
- Presenting fake or estimated numbers as measured results.
