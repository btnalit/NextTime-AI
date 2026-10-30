/**
 * application/eval-seal (S10 E3-1c, I-E4 评测对人透明、对 agent 封闭): stops evaluation content —
 * a suite's canary, or a verbatim run of a holdout case's text — on the three ways it could reach
 * an agent: a capability's result to a Handle (`application/gateway/dispatch.ts`), what a Worker
 * starts with (`application/task/spawn.ts`), and a person's chat message to the entry agent
 * (`application/chat/service.ts`). Refused with 403 `evaluation_content_withheld` and an audit row
 * that says where and for whom, never what. Separate from `application/eval`, which only the
 * human-channel handlers may import: this module reads the evaluation tables for one yes-or-no
 * answer and hands nothing of them on.
 */
export { EvaluationContentWithheldError, type SealPlace } from './errors.js';
export {
  EVALUATION_WITHHELD_ACTION,
  type EvaluationWithheldRecord,
  recordEvaluationWithheld,
} from './record.js';
export { resetEvaluationSealForTests, sealWithholds } from './seal.js';
export { SEAL_SPAN_CHARS, normalizeSealText } from './span-index.js';
