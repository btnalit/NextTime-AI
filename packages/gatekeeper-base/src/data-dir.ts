/**
 * The gate's persistent data directory — where the idempotency store and the ConnectedAccount
 * local store live (design doc §5.1.4, §10.2 compose volume convention). Defaults to `./data`
 * for local/dev runs; production deployments (gatekeepers/<system>/, S2.5) set `GATE_DATA_DIR` to
 * a mounted volume.
 */
export function resolveGateDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GATE_DATA_DIR ?? './data';
}
