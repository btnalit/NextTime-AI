/**
 * application/eval-seal (S10 E3-1c, I-E4 评测对人透明、对 agent 封闭): stops evaluation content —
 * a suite's canary, or a verbatim run of a holdout case's text — on the ways it could reach an
 * agent: a capability's result or error to a Handle (`application/gateway/dispatch.ts`), what a
 * Worker starts with (`application/task/spawn.ts`), a person's chat message to the entry agent
 * (`application/chat/service.ts`), and what the entry agent starts a Turn with
 * (`application/host-bridge/agent-host-runtime.ts`). Refused with 403 `evaluation_content_withheld`
 * (a Turn's start, which no call waits on, ends the Turn failed instead) and an audit row that says
 * where and for whom, never what. Separate from `application/eval`, which only the human-channel
 * handlers may import: this module reads the evaluation tables for one yes-or-no answer and hands
 * nothing of them on.
 *
 * S10 E3-2c (legacy 514, `hold.ts`): the refusals an agent could have provoked are counted per
 * Principal, and enough of them pause every agent acting for it until the workspace owner releases
 * it — each of those paths checks the pause first (`assertNoSealHold`, 403 `evaluation_probe_hold`).
 */
export {
  EvaluationContentWithheldError,
  EvaluationProbeHoldError,
  type ProbeHoldSubject,
  type SealPlace,
} from './errors.js';
export {
  type OpenedSealHold,
  type ProbeHoldPath,
  type ProbeHoldRefusal,
  SEAL_HOLD_OPENED_ACTION,
  SEAL_HOLD_REFUSED_ACTION,
  assertNoSealHold,
  countSealHit,
  hasActiveSealHold,
  isCountedSealPlace,
  recordProbeHoldRefusal,
} from './hold.js';
export {
  EVALUATION_WITHHELD_ACTION,
  type EvaluationWithheldRecord,
  recordEvaluationWithheld,
} from './record.js';
export { type SealOptions, resetEvaluationSealForTests, sealWithholds } from './seal.js';
export { SEAL_SPAN_CHARS, normalizeSealText } from './span-index.js';
