/**
 * 48 labeled test failures for the triage task (Project 1 and the model race).
 * `label` is the answer a senior QA engineer would give. Some cases are clear, some are
 * deliberately ambiguous: those are where a router earns its money.
 *
 * history: the last runs of this test, oldest -> newest (P = pass, F = fail). The last one is this failure.
 */
// The four root causes. These keys are the options every model chooses from.
export type Category = 'product_bug' | 'test_bug' | 'environment' | 'flaky';

export type Failure = {
  // F01..F48. Use it with `npm run race -- F12` or `npm run why -- F12`.
  id: string;
  // The test name and its error message, as a CI log would show them.
  test: string;
  error: string;
  // Recent runs, oldest to newest: P = pass, F = fail. The last letter is this failure.
  history: string;
  // Optional extra facts an engineer would know: a recent commit, a deploy, a migration.
  context?: string;
  // The right answer. Used for accuracy only: it is never sent to a model.
  label: Category;
  /** Marked by hand: true when a reasonable engineer could argue for another label. */
  ambiguous?: boolean;
};

/**
 * The dataset, grouped by label (about 12 per label). Written by hand to look like real CI failures.
 * The `ambiguous: true` ones are deliberate close calls: watch them in the race and in Project 1.
 */
export const FAILURES: Failure[] = [
  // ---------- product_bug ----------
  { id: 'F01', test: 'checkout > applies 10% discount code', error: "expect(received).toBe(expected) Expected: '$90.00' Received: '$100.00'", history: 'PPPPPF', context: 'Commit 1 hour ago: "refactor pricing service"', label: 'product_bug' },
  { id: 'F02', test: 'api > GET /orders/:id returns the order', error: 'Expected status 200, received 500. Body: {"error":"NullPointerException at OrderMapper.java:41"}', history: 'PPPPFF', context: 'Backend deployed this morning', label: 'product_bug' },
  { id: 'F03', test: 'login > shows error for wrong password', error: "Expected text 'Invalid username or password!' but page shows 'Welcome back, undefined'", history: 'PPPPPF', label: 'product_bug' },
  { id: 'F04', test: 'search > finds books by author', error: "toHaveCount: expected 2 rows for 'Zakas', received 0. API /search?q=Zakas returned {\"books\":[]}", history: 'PPPFFF', context: 'Search index migrated to new engine', label: 'product_bug' },
  { id: 'F05', test: 'cart > removing last item shows empty state', error: "Locator getByText('Your cart is empty') not found. Screenshot shows cart total '$-0.00'", history: 'PPPPFF', label: 'product_bug' },
  { id: 'F06', test: 'profile > saves new display name', error: 'Expected name "Renata" after reload, received "Ana". PUT /profile returned 200 but GET /profile returns old value', history: 'PPPPPF', context: 'Caching layer added to profile service', label: 'product_bug' },
  { id: 'F07', test: 'api > POST /users rejects invalid email', error: 'Expected status 400, received 201. User created with email "not-an-email"', history: 'PPPPFF', label: 'product_bug' },
  { id: 'F08', test: 'books > pagination shows page 2', error: "Expected 'Page 2 of 3', received 'Page 2 of 2'. Last 4 books missing from listing", history: 'PPPPPF', context: 'Commit: "off-by-one fix in paginator"', label: 'product_bug' },
  { id: 'F09', test: 'a11y > book table has accessible names', error: 'axe: 8 violations "link-name": Links must have discernible text. All title links have empty text', history: 'PPPPFF', context: 'Commit: "replace title text with icon"', label: 'product_bug' },
  { id: 'F10', test: 'checkout > tax is calculated for UK', error: "Expected VAT '£20.00', received '£0.00'", history: 'PPPPPF', context: 'Feature flag "new-tax-engine" enabled in staging today', label: 'product_bug', ambiguous: true },
  { id: 'F11', test: 'invoice > PDF download has correct total', error: 'Expected total 1,234.50, PDF shows 1.234,50 (European format) for a US account', history: 'PPPPPF', context: 'i18n library upgraded', label: 'product_bug', ambiguous: true },
  { id: 'F12', test: 'api > DELETE /books/:isbn returns 204', error: 'Expected 204, received 200 with body {"deleted":true}', history: 'PPPPPF', context: 'API contract changed in PR #812 (approved by product)', label: 'test_bug', ambiguous: true },

  // ---------- test_bug ----------
  { id: 'F13', test: 'login > submit button is visible', error: "Locator getByRole('button', { name: 'Sign in' }) not found. Page has button 'Log in'", history: 'PPPPPF', context: 'Design change ticket UX-221: rename "Sign in" to "Log in" (shipped)', label: 'test_bug' },
  { id: 'F14', test: 'books > shows 8 books', error: 'toHaveCount: expected 8, received 9', history: 'PPPPPF', context: 'Content team added a new book to the catalog yesterday', label: 'test_bug' },
  { id: 'F15', test: 'reports > shows this month', error: "Expected heading 'October 2026', received 'November 2026'", history: 'PPPPPF', context: 'Run date: 2026-11-01', label: 'test_bug' },
  { id: 'F16', test: 'cart > add two items', error: "strict mode violation: getByRole('button', { name: 'Add' }) resolved to 2 elements", history: 'PPPPPF', context: 'Page now shows "Add" and "Add to wishlist" buttons', label: 'test_bug' },
  { id: 'F17', test: 'api > GET /books schema', error: 'ZodError: unrecognized key "subTitle" in object (strictObject)', history: 'PPPPPF', context: 'Optional field subTitle added to API (documented in OpenAPI spec)', label: 'test_bug' },
  { id: 'F18', test: 'profile > avatar upload', error: "ENOENT: no such file or directory, open 'tests/fixtures/avatar.png'", history: 'PPPPPF', context: 'Commit: "clean up unused test fixtures"', label: 'test_bug' },
  { id: 'F19', test: 'orders > order list is sorted', error: 'Expected [101, 102, 103], received [103, 102, 101]', history: 'PPPPPF', context: 'Product decision: newest orders first (ticket ORD-77, shipped)', label: 'test_bug' },
  { id: 'F20', test: 'login > remembers user', error: "TypeError: Cannot read properties of undefined (reading 'token') at fixtures/auth.ts:22", history: 'PPPPPF', context: 'Commit to test repo: "refactor auth fixture"', label: 'test_bug' },
  { id: 'F21', test: 'search > empty search shows all books', error: "expect(locator).toHaveText: expected 'No rows found' received 'Git Pocket Guide'", history: 'PPPPPF', context: 'Test was copied from "search with unknown term" and not updated', label: 'test_bug' },
  { id: 'F22', test: 'signup > password rules', error: "Expected error 'Password must be 8 characters', received 'Password must be at least 12 characters'", history: 'PPPPPF', context: 'Security policy update SEC-4: minimum length 12 (shipped)', label: 'test_bug' },
  { id: 'F23', test: 'dashboard > widgets load', error: 'Test timeout of 30000ms exceeded. waiting for locator(\'.widget:nth-child(4) > div > span\')', history: 'PPPPFF', context: 'Dashboard layout changed: widgets reordered', label: 'test_bug', ambiguous: true },
  { id: 'F24', test: 'books > book detail shows ISBN', error: "Expected '9781449325862', received '9781449331818'", history: 'PPPPPF', context: 'Test opens "the first book in the table"; catalog order changed', label: 'test_bug', ambiguous: true },

  // ---------- environment ----------
  { id: 'F25', test: 'books > list loads', error: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://staging.bookstore.internal/books', history: 'PPPPPF', label: 'environment' },
  { id: 'F26', test: 'api > GET /books', error: 'Expected status 200, received 502 Bad Gateway (nginx)', history: 'PPPPPF', context: 'Staging maintenance window 02:00-03:00 (run at 02:15)', label: 'environment' },
  { id: 'F27', test: 'orders > create order', error: 'Error: connect ECONNREFUSED 10.0.3.14:5432 (Postgres)', history: 'PPPPPF', label: 'environment' },
  { id: 'F28', test: 'all tests (worker 3)', error: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1201/chrome-linux/chrome", history: 'PPPPPF', context: 'CI image updated, Playwright version bumped', label: 'environment' },
  { id: 'F29', test: 'upload > big file', error: 'ENOSPC: no space left on device, write', history: 'PPPPPF', label: 'environment' },
  { id: 'F30', test: 'login > SSO redirect', error: 'page.goto: net::ERR_CERT_DATE_INVALID at https://sso.staging.example.com', history: 'PPPPPF', label: 'environment' },
  { id: 'F31', test: 'payments > card is charged', error: 'Stripe API: 401 Invalid API Key provided: sk_test_****abcd', history: 'PPPPPF', context: 'Secrets rotated in vault yesterday', label: 'environment' },
  { id: 'F32', test: 'api > rate limit headers', error: 'Expected status 200, received 429 Too Many Requests', history: 'PPPPPF', context: '6 pipelines ran in parallel against the same staging', label: 'environment' },
  { id: 'F33', test: 'email > welcome email arrives', error: 'Timed out after 60s waiting for email in Mailpit inbox. Mailpit container status: Exited (137)', history: 'PPPPPF', label: 'environment' },
  { id: 'F34', test: 'search > results are fast', error: 'Expected response time < 500ms, received 4,812ms', history: 'PPPPPF', context: 'Staging DB being restored from backup during the run', label: 'environment', ambiguous: true },
  { id: 'F35', test: 'reports > export CSV', error: 'Test timeout of 30000ms exceeded while waiting for download', history: 'PPPPFF', context: 'Staging moved to a smaller instance type last week', label: 'environment', ambiguous: true },
  { id: 'F36', test: 'api > GET /books/:isbn', error: 'Expected status 200, received 503 Service Unavailable. Retry-After: 120', history: 'PPPPPF', label: 'environment', ambiguous: true },

  // ---------- flaky ----------
  { id: 'F37', test: 'cart > total updates after quantity change', error: "Expected '$40.00', received '$20.00'", history: 'PFPPFPPF', label: 'flaky' },
  { id: 'F38', test: 'books > search debounce', error: "toHaveCount: expected 1, received 8 (search results not yet filtered)", history: 'PPFPPFPF', context: 'Test uses fill() then immediately counts rows', label: 'flaky' },
  { id: 'F39', test: 'modal > closes on Escape', error: "Expected modal to be hidden, but it is visible (animation 'fade-out' in progress)", history: 'PFPPPFPF', label: 'flaky' },
  { id: 'F40', test: 'notifications > toast disappears', error: 'expect(locator).toBeHidden: timeout 5000ms exceeded', history: 'PPFPFPPF', label: 'flaky' },
  { id: 'F41', test: 'orders > two users create orders', error: 'Expected order number 1002, received 1003', history: 'PFPFPPPF', context: 'Tests run in parallel and share one database', label: 'flaky' },
  { id: 'F42', test: 'charts > tooltip shows value', error: "locator.hover: element is not stable (moving)", history: 'PPFPPPFF', label: 'flaky' },
  { id: 'F43', test: 'login > session persists after reload', error: "Expected URL '/profile', received '/login'", history: 'PFPPFPPF', context: 'Passes every time when run alone', label: 'flaky' },
  { id: 'F44', test: 'dates > shows "today"', error: "Expected 'Today', received 'Tomorrow'", history: 'PPPPPPPF', context: 'Run started 23:59:58 UTC', label: 'flaky' },
  { id: 'F45', test: 'websocket > live price updates', error: 'Timed out waiting for message "price:update" after 10s', history: 'PFPPPPFF', label: 'flaky', ambiguous: true },
  { id: 'F46', test: 'search > autocomplete suggestions', error: "toHaveCount: expected 5 suggestions, received 4", history: 'PPFPPPPF', context: 'Suggestions come from a third-party API', label: 'flaky', ambiguous: true },
  { id: 'F47', test: 'profile > avatar renders', error: 'Screenshot comparison failed: 0.4% of pixels differ (threshold 0.2%)', history: 'PFPPPPPF', context: 'Font loads from CDN', label: 'flaky', ambiguous: true },
  { id: 'F48', test: 'checkout > place order', error: 'Test timeout of 30000ms exceeded. Last action: click "Place order"', history: 'PPPPPFPF', context: 'Payment sandbox has known latency spikes', label: 'flaky', ambiguous: true },
];

/** Respect SAMPLE from .env, but keep a mix of categories (round-robin), so a small sample is still fair. */
export function sample(n = Number(process.env.SAMPLE) || FAILURES.length): Failure[] {
  // Group the failures by label: one queue per category.
  const groups: Record<string, Failure[]> = {};
  for (const f of FAILURES) (groups[f.label] ??= []).push(f);
  // Then take one from each queue in turn (round-robin) until we have n.
  const queues = Object.values(groups);
  const out: Failure[] = [];
  for (let i = 0; out.length < Math.min(n, FAILURES.length); i++) {
    for (const q of queues) if (q[i] && out.length < n) out.push(q[i]);
  }
  // With SAMPLE=12 you get 3 of each category, not 12 product bugs.
  return out;
}
