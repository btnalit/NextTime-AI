import { OPERATION_NAME_MAX } from './action-description.js';

/**
 * Legacy 309 (review #493 of #593): how long a name a caller gives a new thing may be. Before, only
 * an Operation's name had a cap (`OPERATION_NAME_MAX`, legacy 232) among the names a caller chooses;
 * the others were stored and shown at whatever length they came in. Each name has one cap, held
 * here, and every path that writes it — a capability's params, the handler that parses an opaque
 * payload, an HTTP route — checks the same one:
 *
 *   - {@link NAME_MAX_LENGTH}: a name with no cap anywhere before — a Source, a Procedure, a new
 *     ObjectType / LinkType / ActionType of an ontology — takes the Operation name's number;
 *   - a name some path already capped keeps that cap, now on every path that writes it:
 *     {@link DISPLAY_NAME_MAX_LENGTH}, {@link LOGIN_MAX_LENGTH}, {@link CHAT_TITLE_MAX_LENGTH},
 *     {@link WORKER_DEFINITION_NAME_MAX_LENGTH}, and a new Skill's name, `SKILL_NAME_MAX_LENGTH`
 *     (skill.ts): publishing held it to that, and a Skill never changes its name, so a longer
 *     draft could never be published.
 *
 * Counted as Zod's `.max()` counts — UTF-16 code units — like every other cap of the wire contract,
 * so the contract shows it (`maxLength`). Only on a name new to its record: a stored name parses
 * and shows as before, and a name the record already has — a Skill family's (its next version keeps
 * it), one an earlier version of a Procedure or WorkerDefinition had, an ontology type the
 * workspace has published — is not checked again, so a record named longer before the cap keeps
 * its name. A cap on length only: the character rule stays the Operation name's alone (an approver
 * reads it on the approval card).
 */
export const NAME_MAX_LENGTH = OPERATION_NAME_MAX;

/** A person's or Principal's display name: `create_user`, `update_user`, `create_principal`, and the
 *  `/api/auth` routes that set one (`claim`, `profile`). The number a person's own claim and
 *  profile edit always refused past (`users.ts`); `create_user` and `update_user` took up to 200,
 *  a name its owner could then not save back unchanged. */
export const DISPLAY_NAME_MAX_LENGTH = 128;

/** A user's login: `create_user` and `/api/auth/claim` — the length half of the kernel's
 *  `LOGIN_PATTERN` (3–64 of `[a-z0-9._-]`), so a login past it is refused before it is parsed. */
export const LOGIN_MAX_LENGTH = 64;

/** A Chat's title: `new_chat` and `rename_chat`. */
export const CHAT_TITLE_MAX_LENGTH = 200;

/** A WorkerDefinition's `name`: `propose_worker_definition` and
 *  `propose_definition_from_combination`. */
export const WORKER_DEFINITION_NAME_MAX_LENGTH = 200;
