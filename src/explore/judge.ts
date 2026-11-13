// track() measures the Jev call; decide() measures the LLM escalation.
import { decide, track } from '../meter';
import { jev, modelByKey } from '../models';
import type { ChoiceQuestion } from '../types';
// What Playwright collected about the page, and how it becomes text.
import { stateText, type PageState } from './page-state';

/**
 * Project 2: Jev as the fast judge of an exploratory run.
 * Playwright collects the page state; Jev answers fuzzy questions about it in ONE call:
 *   verdict      (choice) pass / suspicious / fail
 *   looksBroken  (noul)   probability the page is broken
 *   message      (score)  how clear a form message is, when there is one
 *
 * The DECISION uses the yes/no question, not the three-way verdict. In real runs the verdict
 * was a close call between "pass" and "suspicious" (they overlap), while "looks broken"
 * separated working pages (0.17-0.33) from broken ones (0.75-0.98). Lesson: split the fuzzy question.
 *
 *   looksBroken <= CLEAR (0.4)   -> pass, Jev decides
 *   looksBroken >= FLAG  (0.7)   -> flag for review, Jev decides
 *   in between                   -> escalate to a System Two model (with a reason),
 *                                   or "needs-human" if no LLM key is set
 * The verdict stays as a label for the human.
 */
// The two bands on "looks broken", from .env (EXPLORE_CLEAR, EXPLORE_FLAG).
export const CLEAR = Number(process.env.EXPLORE_CLEAR || 0.4);
export const FLAG = Number(process.env.EXPLORE_FLAG || 0.7);

// The three-way verdict. Asked to Jev (as a choice) and, when escalating, to the LLM.
export const VERDICT_QUESTION: ChoiceQuestion = {
  instructions:
    'You are an exploratory tester. Given the page purpose, judge what a real user would experience on this page right now.',
  options: {
    pass: 'Works as expected: the content matches the page purpose and nothing looks wrong',
    suspicious: 'Something looks off and a human should check it: odd or missing data, unclear messages, partial content',
    fail: 'Clearly broken: empty where content is expected, raw errors, placeholder or nonsense data, or failed requests that break the page',
  },
};

/** Everything the report shows for one page: the verdict, who decided, Jev's numbers, cost and time. */
export type Judgement = {
  verdict: 'pass' | 'suspicious' | 'fail' | 'needs-human';
  /** Who gave the final verdict. */
  decidedBy: 'jev' | 'llm' | 'nobody';
  jevVerdict: string | null;
  jevConfidence: number;
  looksBroken: number | null;
  messageClarity: number | null;
  reason?: string;
  costUsd: number;
  latencyMs: number;
};

/**
 * Judge one page. formMessage: the text shown after a form was submitted (adds the "message" question).
 * taskId names the page in calls.jsonl and in the report.
 */
export async function judgePage(state: PageState, taskId: string, opts: { formMessage?: string } = {}): Promise<Judgement> {
  // The state as text. The form message, when there is one, is appended so Jev can rate it.
  const text = stateText(state) + (opts.formMessage ? `\nMessage shown after the form was submitted: ${opts.formMessage}` : '');

  // One Jev call with up to three questions, measured like any other model call.
  const { record, call } = await track(
    jev(),
    { experiment: 'explore', taskId, state: text },
    () =>
      jev().ask(text, {
        // 1. choice: pass / suspicious / fail (a label for the human).
        verdict: { type: 'choice', instructions: VERDICT_QUESTION.instructions, criteria: VERDICT_QUESTION.options },
        // 2. noul: probability the page is broken. THIS one drives the decision.
        looksBroken: { type: 'noul', instructions: 'This page looks broken, empty, or shows raw errors, placeholder text or nonsense data.' },
        // 3. score: how clear the form message is, only when there is a message.
        ...(opts.formMessage
          ? {
              message: {
                type: 'score' as const,
                instructions: 'Rate how clearly the message tells the user what happened and what to do next.',
                criteria: ['Unclear or technical', 'Understandable but no next step', 'Clear, polite and says what to do next'],
              },
            }
          : {}),
      }),
    // What goes in calls.jsonl: the verdict and its confidence and probabilities.
    (answers) => ({ answer: answers.verdict?.choice ?? null, confidence: answers.verdict?.confidence ?? null, probabilities: answers.verdict?.probabilities }),
  );

  const answers = call.result;
  // The number that decides: 0 = looks fine, 1 = looks broken.
  const broken = answers.looksBroken?.noul ?? null;
  // When flagged, keep Jev's own wording: "fail" if it said so, otherwise "suspicious".
  const flaggedVerdict = (record.answer === 'fail' ? 'fail' : 'suspicious') as Judgement['verdict'];
  const judgement: Judgement = {
    // At or above FLAG: on the review list. Otherwise pass (the in-between case is replaced below).
    verdict: broken !== null && broken >= FLAG ? flaggedVerdict : 'pass',
    decidedBy: 'jev',
    jevVerdict: record.answer,
    jevConfidence: record.confidence ?? 0,
    looksBroken: broken,
    messageClarity: answers.message?.score ?? null,
    costUsd: record.cost_usd,
    latencyMs: record.latency_ms,
  };
  // Clearly fine or clearly broken: Jev decides alone. Done, no LLM call.
  if (broken !== null && (broken <= CLEAR || broken >= FLAG)) return judgement;

  // Not sure: escalate to System Two, with a reason a human can read in the report.
  const strong = modelByKey(process.env.ROUTE_STRONG || 'opus');
  // No LLM key: mark it for a human instead of guessing.
  if (!strong.available()) return { ...judgement, verdict: 'needs-human', decidedBy: 'nobody' };
  // Same state, same verdict question, now to the LLM, which also writes a short reason.
  const escalation = await decide(strong, text, VERDICT_QUESTION, { experiment: 'explore-escalation', taskId }, { withReason: true });
  return {
    ...judgement,
    verdict: (escalation.record.answer as Judgement['verdict']) ?? 'needs-human',
    decidedBy: escalation.record.answer ? 'llm' : 'nobody',
    reason: escalation.record.reason,
    // Cost and time include both calls: Jev's and the LLM's.
    costUsd: judgement.costUsd + escalation.record.cost_usd,
    latencyMs: judgement.latencyMs + escalation.record.latency_ms,
  };
}
