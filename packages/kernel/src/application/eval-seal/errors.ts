/** Where the seal stopped evaluation content on its way to an agent (S10 E3-1c). */
export type SealPlace =
  /** A capability's result, on its way back to a Handle (an agent or a service). */
  | 'capability_result'
  /** The error a Handle's call failed with (its message or details). */
  | 'capability_error'
  /** What a Worker starts with: its Task input, system prompt and mounted Skills. */
  | 'worker_start'
  /** A person's chat message, the prompt of an entry agent's Turn. */
  | 'entry_turn'
  /** What an entry agent starts a Turn with: its system prompt (the published entry definition's,
   *  the platform's instructions, the person's own prompt addendum) and its mounted Skills. */
  | 'entry_start';

const MESSAGES: Record<SealPlace, (rolledBack: boolean) => string> = {
  capability_result: (rolledBack) =>
    rolledBack
      ? 'the result carries content reserved for evaluation, so it was withheld and what the call wrote to the platform was rolled back'
      : 'the result carries content reserved for evaluation, so it was withheld — the call itself took effect',
  capability_error: () =>
    'the call failed, and its error carries content reserved for evaluation, so the error was withheld',
  worker_start: () =>
    'what this Worker would start with carries content reserved for evaluation, so it was not started',
  entry_turn: () =>
    'this message carries content reserved for evaluation, which no agent may read, so it was not sent — nothing was saved',
  entry_start: () =>
    'what the entry agent would start this turn with carries content reserved for evaluation, so the turn was not started',
};

/**
 * 403 `evaluation_content_withheld` (S10 E3-1c, I-E4): what was about to reach an agent carries a
 * suite's canary or a verbatim run of a holdout case's text. The message says where it was stopped
 * and nothing else — never the run it matched, the case, the suite, or which of the two it was —
 * so neither the refused caller nor anyone reading the error can learn from it what is held out.
 */
export class EvaluationContentWithheldError extends Error {
  readonly code = 'evaluation_content_withheld' as const;
  readonly where: SealPlace;
  /** For a capability result: whether the call's own transaction was rolled back (what the call
   *  wrote to the platform; not an effect outside it, such as a gate's). */
  readonly rolledBack: boolean;
  /** Whether the audit row for this refusal is already written (`recordEvaluationWithheld`). */
  recorded = false;

  constructor(where: SealPlace, rolledBack = true) {
    super(MESSAGES[where](rolledBack));
    this.name = 'EvaluationContentWithheldError';
    this.where = where;
    this.rolledBack = rolledBack;
  }
}
