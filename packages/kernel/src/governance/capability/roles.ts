/**
 * The role predicates (`roleSatisfiesMinRole`, `roleMayUseCapability`) and the auditor's allowlists
 * (R-35 / D-07) live in `@nexttime/shared` (`roles.ts`) so the console's "may this reader fix it"
 * links use the exact rule this kernel authorizes with. Re-exported here so every governance and
 * application importer keeps its path; the rule's documentation is in the shared file.
 */
export {
  AUDITOR_CONVERSATION_CAPABILITIES,
  AUDITOR_READ_CAPABILITIES,
  roleMayUseCapability,
  roleSatisfiesMinRole,
} from '@nexttime/shared';
