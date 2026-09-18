/**
 * S5.5 leftover 34 (docs/STATUS.md row 34): `pg` warns — once per process, through
 * `util.deprecate` — when `client.query()` is called while that client is still executing a
 * query ("... is deprecated and will be removed in pg@9.0"). Every such site in this package was
 * serialized; this hook turns any regression into a failed test run instead of a log line nobody
 * reads, so the suite stays clean before the pg@9 upgrade makes it a hard error.
 */
process.on('warning', (warning) => {
  if (
    warning.name === 'DeprecationWarning' &&
    warning.message.includes('client.query() when the client is already executing a query')
  ) {
    throw new Error(
      `pg: a query was issued on a client that was still executing another one — serialize it (leftover 34): ${warning.message}`,
    );
  }
});
