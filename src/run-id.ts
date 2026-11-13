/**
 * Run ids: a readable local timestamp plus a label for what ran, e.g. "2026-11-09_20-15-33_p1".
 * The same id names everything a run produces:
 *   runs/<id>/calls.jsonl           every model call
 *   playwright-report/<id>/         the Playwright HTML report
 *   reports/dashboard-<id>.html     the dashboard
 * No dependencies on purpose: playwright.config.ts imports it.
 */
export function makeRunId(label?: string): string {
  const d = new Date();
  // Two-digit padding: 9 -> "09", so the ids sort correctly as plain text.
  const p = (n: number) => String(n).padStart(2, '0');
  // Local time (not UTC), so the folder name matches the clock on your wall.
  // Dashes and an underscore instead of ":" and " ", so the id is safe as a folder name on every OS.
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  // The label says what ran: race, bench, p1, edges... No label: just the time.
  return label ? `${stamp}_${label}` : stamp;
}

/** Label for a Playwright run, from --project=... (p1, p2, p3, or several joined with "+"). */
export function labelFromArgs(argv: string[]): string {
  const projects = argv
    // Playwright accepts both "--project=p1-cut-costs" and "--project p1-cut-costs": handle both.
    .flatMap((a, i) => (a.startsWith('--project=') ? [a.slice(10)] : a === '--project' ? [argv[i + 1] ?? ''] : []))
    // Keep only the short prefix: "p1-cut-costs" -> "p1".
    .map((p) => p.split('-')[0])
    .filter(Boolean);
  // No --project at all means every project ran: "all".
  return projects.length ? projects.join('+') : 'all';
}
