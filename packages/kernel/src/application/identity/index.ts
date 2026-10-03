export {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  passwordPolicyViolation,
  verifyPassword,
} from './password.js';
export {
  IdentityError,
  LOGIN_MAX_FAILURES,
  LOGIN_LOCK_MINUTES,
  LOGIN_PATTERN,
  assertPasswordStrength,
  bindPrincipalToUser,
  checkPassword,
  claimIdentity,
  claimIdentityOnClient,
  countActivePlatformAdmins,
  createUser,
  derivedLogin,
  ensureUserForHumanPrincipal,
  findActiveMembership,
  findUserById,
  findUserByLogin,
  insertUser,
  listActiveMemberships,
  listMemberships,
  normalizeLogin,
  updateUserDisplayName,
} from './users.js';
export type {
  BindPrincipalInput,
  ClaimIdentityInput,
  IdentityErrorKind,
  CreateUserInput,
  MembershipRow,
  PasswordCheck,
  PlatformRole,
  UserRow,
  UserStatus,
} from './users.js';
export {
  CONSOLE_SESSION_COOKIE,
  CONSOLE_SESSION_TTL_SECONDS,
  CONSOLE_SESSION_TYP,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  WORKSPACE_COOKIE,
  WORKSPACE_HEADER,
  ConsoleSessionClaimsSchema,
  ConsoleSessionInvalid,
  clearConsoleSessionCookie,
  createUserSession,
  extractConsoleSessionToken,
  lookupConsoleSessionUser,
  mintConsoleSessionToken,
  parseCookieHeader,
  revokeAllUserSessions,
  revokeUserSession,
  serializeConsoleSessionCookie,
  verifyConsoleSessionToken,
} from './console-session.js';
export type { ConsoleSessionClaims, UserSessionRow } from './console-session.js';
export { changeOwnPassword, revokeUserCredentials, setUserPassword } from './credentials.js';
export type {
  ChangeOwnPasswordInput,
  ChangeOwnPasswordOutcome,
  RevokeUserCredentialsOptions,
  UserCredentialRevocation,
} from './credentials.js';
export {
  DEFAULT_INITIAL_ADMIN_PASSWORD_FILE,
  INITIAL_ADMIN_DISPLAY_NAME,
  INITIAL_ADMIN_LOGIN,
  createPlatformAdmin,
  ensureInitialAdmin,
} from './setup.js';
export type { EnsureInitialAdminOptions } from './setup.js';
