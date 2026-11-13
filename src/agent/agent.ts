import type { Page } from '@playwright/test';
// track() measures Jev's multi-question call; decide() measures an LLM step.
import { decide, track } from '../meter';
import { jev, modelByKey } from '../models';
import type { ChoiceQuestion } from '../types';

/**
 * Project 3: a simple browser agent.
 *
 * Each step: OBSERVE the page -> DECIDE the next action -> ACT -> repeat until the goal is met.
 *
 *   hybrid    Jev decides every step (one call answers the rubric AND picks the next action).
 *             Confidence >= ACT_THRESHOLD: act. Below: hand this one step to the LLM.
 *   llm-only  The LLM decides every step (what most agents do today).
 *
 * Both modes see exactly the same state and the same list of actions.
 */
// Hybrid mode: Jev acts alone at or above this confidence (AGENT_ACT in .env).
export const ACT_THRESHOLD = Number(process.env.AGENT_ACT || 0.7);
// A rubric item counts as met when Jev's yes-probability is at least 0.8.
const RUBRIC_PASS = 0.8;

/** What the agent must achieve: the goal in words, plus yes/no checks that say when it's done. */
export type Goal = {
  text: string;
  /** Yes/no criteria. All must be met for the goal to count as done (the goal loop). */
  rubric: Record<string, string>;
};

// One thing the agent can click. key: the option name sent to the model (a0, a1...). index: its position on the page, to click it.
type Action = { key: string; index: number; role: string; name: string; href: string | null };

// One line of the agent's log: which step, where it was, who decided, what it did, and what that cost.
export type StepLog = { step: number; url: string; decidedBy: 'jev' | 'llm'; action: string; confidence: number | null; costUsd: number; ms: number };

/** The result of one agent run: the steps, how many Jev and LLM calls it made, total cost and time. */
export type AgentRun = {
  mode: 'hybrid' | 'llm-only';
  /** The agent believes it reached the goal. */
  done: boolean;
  /** Plain Playwright check of the real goal (set by the test). */
  verified?: boolean;
  steps: StepLog[];
  jevCalls: number;
  llmCalls: number;
  costUsd: number;
  ms: number;
};

// What counts as an action: links with a target, and buttons.
const CLICKABLE = 'a[href], button';

/** OBSERVE: every visible link and button, with a name a human would recognise. */
async function observe(page: Page): Promise<{ text: string; actions: Action[] }> {
  // Runs inside the browser: read every link and button in one go.
  const raw = await page.locator(CLICKABLE).evaluateAll((elements) =>
    elements.map((el, index) => {
      const rect = el.getBoundingClientRect();
      // Visible = it has a size and isn't hidden. Hidden elements can't be clicked.
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      // The name a person sees: aria-label first, then the text, then the title.
      const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      return { index, visible, disabled: (el as HTMLButtonElement).disabled === true, role: el.tagName === 'A' ? 'link' : 'button', name, href: el.getAttribute('href') };
    }),
  );
  const actions = raw
    // Keep only what a user could actually click, and that has a name.
    .filter((a) => a.visible && !a.disabled && a.name)
    .slice(0, 60) // Jev takes up to 255 options; fewer, clearer options decide better.
    .map((a, i) => ({ key: `a${i}`, index: a.index, role: a.role, name: a.name, href: a.href }));
  // The page text, squashed and cut to 2,000 characters: enough to recognise the page.
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, 2_000);
  return { text, actions };
}

// An action in words, e.g. 'click link "Book Store" (goes to /books)'. These are the options the models see.
function describe(a: Action): string {
  return `click ${a.role} "${a.name}"${a.href && a.role === 'link' ? ` (goes to ${a.href})` : ''}`;
}

// The state for one step: the goal, where we are, what's on screen, and what we already did.
function stateFor(goal: Goal, page: Page, text: string, history: StepLog[]): string {
  return [
    `Goal: ${goal.text}`,
    `Current URL: ${page.url()}`,
    `Visible text: ${text}`,
    `Steps taken so far: ${history.length ? history.map((h) => h.action).join(' -> ') : 'none'}`,
  ].join('\n');
}

/**
 * Run the agent until the goal is met or maxSteps (default 6) is reached.
 * mode "hybrid": Jev decides, the LLM helps when Jev is unsure. mode "llm-only": the LLM decides every step.
 */
export async function runAgent(page: Page, goal: Goal, mode: AgentRun['mode'], opts: { maxSteps?: number; taskId: string }): Promise<AgentRun> {
  // The LLM used for unsure steps (hybrid) or every step (llm-only).
  const strong = modelByKey(process.env.ROUTE_STRONG || 'opus');
  // Tags the calls in calls.jsonl, so the report can compare the two modes.
  const experiment = mode === 'hybrid' ? 'agent-hybrid' : 'agent-llm';
  const run: AgentRun = { mode, done: false, steps: [], jevCalls: 0, llmCalls: 0, costUsd: 0, ms: 0 };
  const started = performance.now();

  // The agent loop: OBSERVE -> DECIDE -> ACT, once per step.
  for (let step = 1; step <= (opts.maxSteps ?? 6); step++) {
    // OBSERVE: wait for the page, list what can be clicked, and build the state and the question.
    await page.waitForLoadState('domcontentloaded');
    const { text, actions } = await observe(page);
    const state = stateFor(goal, page, text, run.steps);
    // The options: one per action, keyed a0, a1, ... and described in words.
    const options: Record<string, string> = Object.fromEntries(actions.map((a) => [a.key, describe(a)]));
    const question: ChoiceQuestion = { instructions: `Which action brings us closest to the goal? Goal: ${goal.text}`, options };
    // Each step gets its own task id (task#1, task#2...) in calls.jsonl.
    const meta = { experiment, taskId: `${opts.taskId}#${step}`, state };

    // Filled in by whoever decides this step: Jev or the LLM.
    let choice: string | null = null;
    let confidence: number | null = null;
    let decidedBy: StepLog['decidedBy'] = 'jev';
    let stepCost = 0;
    let stepMs = 0;

    // DECIDE, hybrid mode: Jev first.
    if (mode === 'hybrid') {
      // One Jev call: the rubric (is the goal met?) and the next action, answered in parallel.
      // Each rubric item becomes a yes/no (noul) question, asked in the same call as the next action.
      const rubricQuestions = Object.fromEntries(Object.entries(goal.rubric).map(([k, v]) => [k, { type: 'noul' as const, instructions: v }]));
      const { call, record } = await track(jev(), meta, () => jev().ask(state, { ...rubricQuestions, next: { type: 'choice', instructions: question.instructions, criteria: options } }), (r) => ({
        answer: r.next?.choice ?? null,
        confidence: r.next?.confidence ?? null,
      }));
      run.jevCalls++;
      stepCost += record.cost_usd;
      stepMs += record.latency_ms;
      // Goal check: every rubric item must be likely yes. Then the agent stops here.
      const met = Object.keys(goal.rubric).every((k) => (call.result[k]?.noul ?? 0) >= RUBRIC_PASS);
      if (met) {
        run.steps.push({ step, url: page.url(), decidedBy: 'jev', action: 'done (rubric met)', confidence: null, costUsd: stepCost, ms: stepMs });
        run.done = true;
        break;
      }
      choice = record.answer;
      confidence = record.confidence;
    }

    // DECIDE with the LLM: always in llm-only mode; in hybrid mode only when Jev had no answer or was below ACT_THRESHOLD.
    if (mode === 'llm-only' || choice === null || (confidence ?? 0) < ACT_THRESHOLD) {
      // System Two: the LLM decides this step. It can also say the goal is done.
      // The LLM gets one extra option, "done", because it has no rubric questions to say so.
      const llmQuestion: ChoiceQuestion = { ...question, options: { ...options, done: 'The goal is already achieved on this page' } };
      const { record } = await decide(strong, state, llmQuestion, meta);
      run.llmCalls++;
      stepCost += record.cost_usd;
      stepMs += record.latency_ms;
      choice = record.answer;
      confidence = record.confidence;
      // The log will show the LLM made this step's decision.
      decidedBy = 'llm';
      if (choice === 'done') {
        run.steps.push({ step, url: page.url(), decidedBy, action: 'done', confidence, costUsd: stepCost, ms: stepMs });
        run.done = true;
        break;
      }
    }

    // ACT: turn the chosen key (a0, a1...) back into the element to click.
    const action = actions.find((a) => a.key === choice);
    if (!action) break; // The model gave no usable answer: stop instead of guessing.
    // ACT. If the click doesn't work (covered, moved), say so in the log and let the next step recover.
    // Remember the page text before the click, to notice when the page changes.
    const before = await page.locator('body').innerText();
    const clicked = await page
      .locator(CLICKABLE)
      .nth(action.index)
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    // DemoQA is a single-page app: the URL changes before the new page is drawn, sometimes with
    // no network request to wait for. Wait until the visible text changes, or the next OBSERVE
    // sees the old page and repeats the click.
    if (clicked) {
      await page
        .waitForFunction((prev) => document.body.innerText !== prev, before, { timeout: 5_000 })
        .catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    }
    // Log the step: what was clicked, who chose it, how sure, and what the step cost.
    run.steps.push({ step, url: page.url(), decidedBy, action: describe(action) + (clicked ? '' : ' (click failed)'), confidence, costUsd: stepCost, ms: stepMs });
  }

  // Totals for the report: the cost of every step, and the wall-clock time of the whole run.
  run.costUsd = run.steps.reduce((s, x) => s + x.costUsd, 0);
  run.ms = Math.round(performance.now() - started);
  return run;
}
