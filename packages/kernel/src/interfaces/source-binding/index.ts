/**
 * interfaces/source-binding: the `workers`-network half of the kernel's front door — the route
 * allow-list for agent containers and the Handle bound to each container's address. See
 * source-binding.ts's doc comment; `@nexttime/shared`'s `handle-binding.ts` for the contract
 * worker-supervisor writes.
 *
 * `packages/kernel/src/index.ts` (composition root) builds it in `main()` from
 * `NEXTTIME_SUBNET_WORKERS` + `HANDLE_BINDINGS_FILE` and passes it to `createServer()`.
 */

export {
  SourceBindingRefused,
  WORKERS_PLANE_ROUTES,
  createFileHandleBindingReader,
  createFileHandleBindingSource,
  createSourceBinding,
  registerWorkersPlaneGuard,
} from './source-binding.js';
export type { SourceBinding, SourceBindingConfig } from './source-binding.js';
