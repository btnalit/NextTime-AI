import type { ObjectWire } from '@nexttime/shared';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { type GraphQuery, graphHref, parseGraphHash } from '../../lib/graph-route.js';
import { objectDisplayName } from '../../lib/graph-view.js';

/**
 * components/graph/GraphObjectsContext: the page-level Object cache behind every `RefChip` on the
 * graph page (§5.9 principle 3, "id 永不裸露"). `state_at` / `traverse` return neighbour *ids*
 * only and there is no batch Object read (reported as a kernel gap), so names are resolved with
 * one `get_object` per unseen id — deduplicated, at most `CONCURRENCY` in flight, results kept
 * for the life of the page, and a failed lookup remembered so it is not retried on every render
 * (the chip simply stays bare). Search results and the focused Object prime the cache for free
 * (`prime`), so the common path — search → open → expand — resolves most names without a call.
 *
 * Lives under `components/graph/` rather than `hooks/` (not this lane's directory); it is graph-
 * page-specific either way.
 */
export interface GraphObjects {
  readonly objects: ReadonlyMap<string, ObjectWire>;
  /** `objectDisplayName` over the cached row and the ontology's identity keys — `undefined`
   *  while unresolved or unresolvable (→ bare RefChip). */
  readonly nameOf: (id: string) => string | undefined;
  /** The deep link that focuses `id` while keeping the page's current search / as-of state —
   *  what every object `RefChip` on the page links to. */
  readonly hrefFor: (id: string) => string;
  readonly prime: (rows: readonly ObjectWire[]) => void;
  /** Resolve these ids (skipping cached / in-flight / failed ones). */
  readonly request: (ids: readonly string[]) => void;
}

const CONCURRENCY = 4;

const GraphObjectsContext = createContext<GraphObjects | null>(null);

export interface GraphObjectsProviderProps {
  readonly http: CapabilityCaller;
  /** `list_types{kind:'object'}` → `typeName → identityKey[]` (`lib/graph-view.ts`
   *  `identityKeysByType`); empty until the types load — names then fall back to stored order. */
  readonly identityKeys: ReadonlyMap<string, readonly string[]>;
  /** The page's current hash query; `hrefFor` overrides only its `objectId`. */
  readonly baseQuery?: GraphQuery;
  readonly children: ReactNode;
}

export function GraphObjectsProvider({
  http,
  identityKeys,
  baseQuery,
  children,
}: GraphObjectsProviderProps) {
  const [objects, setObjects] = useState<ReadonlyMap<string, ObjectWire>>(() => new Map());
  const inFlight = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const prime = useCallback((rows: readonly ObjectWire[]): void => {
    if (rows.length === 0) return;
    setObjects((prev) => {
      let next: Map<string, ObjectWire> | undefined;
      for (const row of rows) {
        if (prev.has(row.id)) continue;
        next ??= new Map(prev);
        next.set(row.id, row);
      }
      return next ?? prev;
    });
  }, []);

  const pump = useCallback((): void => {
    while (inFlight.current.size < CONCURRENCY && queue.current.length > 0) {
      const id = queue.current.shift();
      if (id === undefined) break;
      if (objectsRef.current.has(id) || inFlight.current.has(id) || failed.current.has(id))
        continue;
      inFlight.current.add(id);
      http
        .call<ObjectWire | null>('get_object', { objectId: id })
        .then((row) => {
          if (!mounted.current) return;
          if (row === null) failed.current.add(id);
          else setObjects((prev) => (prev.has(id) ? prev : new Map(prev).set(id, row)));
        })
        .catch(() => {
          // Unresolvable (deleted, forbidden, network): the chip stays bare; no page-level error
          // for a name lookup.
          failed.current.add(id);
        })
        .finally(() => {
          inFlight.current.delete(id);
          if (mounted.current) pump();
        });
    }
  }, [http]);

  const request = useCallback(
    (ids: readonly string[]): void => {
      for (const id of ids) {
        if (
          objectsRef.current.has(id) ||
          inFlight.current.has(id) ||
          failed.current.has(id) ||
          queue.current.includes(id)
        )
          continue;
        queue.current.push(id);
      }
      pump();
    },
    [pump],
  );

  const nameOf = useCallback(
    (id: string): string | undefined => {
      const row = objects.get(id);
      return row ? objectDisplayName(row, identityKeys.get(row.objectType)) : undefined;
    },
    [objects, identityKeys],
  );

  // Keyed on the serialized query, not the (per-render) object identity of `baseQuery`.
  const baseKey = graphHref(baseQuery ?? {});
  const hrefFor = useCallback(
    (id: string): string => graphHref({ ...(parseGraphHash(baseKey) ?? {}), objectId: id }),
    [baseKey],
  );

  const value = useMemo<GraphObjects>(
    () => ({ objects, nameOf, hrefFor, prime, request }),
    [objects, nameOf, hrefFor, prime, request],
  );
  return <GraphObjectsContext.Provider value={value}>{children}</GraphObjectsContext.Provider>;
}

const NONE: GraphObjects = {
  objects: new Map(),
  nameOf: () => undefined,
  hrefFor: (id) => graphHref({ objectId: id }),
  prime: () => undefined,
  request: () => undefined,
};

/** The page's Object cache; outside a provider (a unit test of one row) every name is bare. */
export function useGraphObjects(): GraphObjects {
  return useContext(GraphObjectsContext) ?? NONE;
}

/** Ask the cache for these ids whenever the set changes (compared by content, not identity). */
export function useResolvedObjects(ids: readonly string[]): void {
  const { request } = useGraphObjects();
  const key = ids.join('\n');
  useEffect(() => {
    if (key === '') return;
    request(key.split('\n'));
  }, [key, request]);
}
