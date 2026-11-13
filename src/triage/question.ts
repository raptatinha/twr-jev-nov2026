import type { ChoiceQuestion } from '../types';
import type { Failure } from './dataset';

/**
 * The triage question from the blog article, asked the same way to every model.
 * English instructions: English is Jev's primary training language.
 */
export const TRIAGE_QUESTION: ChoiceQuestion = {
  instructions: 'What is the most likely root cause of this automated test failure?',
  options: {
    product_bug: 'A real bug in the product code',
    test_bug: 'A bug in the test itself (outdated expectation, locator, data or fixture)',
    environment: 'Infrastructure or environment issue (network, services, CI machine, credentials)',
    flaky: 'Non-deterministic: the same code sometimes passes and sometimes fails',
  },
};

/**
 * The state sent to the model. Only what an engineer would look at, nothing more.
 * Turns one failure into the text every model reads. The label is NOT included: that's the answer.
 * Example (F37):
 *   Test: cart > total updates after quantity change
 *   Error: Expected '$40.00', received '$20.00'
 *   Recent runs (oldest to newest, P=pass F=fail): PFPPFPPF
 */
export function failureState(f: Failure): string {
  return [
    `Test: ${f.test}`,
    `Error: ${f.error}`,
    `Recent runs (oldest to newest, P=pass F=fail): ${f.history}`,
    f.context ? `Context: ${f.context}` : '',
  ]
    // Drop the empty context line when a failure has no context.
    .filter(Boolean)
    .join('\n');
}
