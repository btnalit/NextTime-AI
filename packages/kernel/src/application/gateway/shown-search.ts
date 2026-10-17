import type { PoolClient } from 'pg';
import { type SearchInput, type ShownObjects, SqlGraphStore } from '../../substrate/graph/index.js';
import { CONNECTION_OBJECT_TYPES, displayedObject } from './resource-wire.js';

const graphStore = new SqlGraphStore();

/**
 * Legacy 387: what a text search over the graph (`search`, the Explorer's node list and graph
 * search) matches the connection Objects on — their properties and identity key as every read
 * shows them (`displayedObject`), never as stored. A Gatekeeper or ConnectedSystem written before
 * legacy 186 can still hold a credential in its name or address (`scrub-raw-secrets` rewrites the
 * names, but a Gatekeeper's address stays: the gate is called there); a substring query that hit
 * it would say the credential exists without ever returning it.
 *
 * `undefined` — match on what is stored — only when no connection Object can be told apart that
 * way: the empty query (everything matches), or a search narrowed to another Object type.
 */
export async function shownForSearch(
  client: PoolClient,
  workspaceId: string,
  input: Pick<SearchInput, 'query' | 'objectType'>,
): Promise<ShownObjects | undefined> {
  if (input.query === '') return undefined;
  if (input.objectType !== undefined && !CONNECTION_OBJECT_TYPES.includes(input.objectType)) {
    return undefined;
  }
  const objects = await graphStore.listObjectsOfTypes(client, workspaceId, CONNECTION_OBJECT_TYPES);
  return {
    objectTypes: CONNECTION_OBJECT_TYPES,
    objects: Object.fromEntries(
      objects.map((object) => {
        const shown = displayedObject(object);
        return [object.id, { properties: shown.properties, identityKey: shown.identityKey }];
      }),
    ),
  };
}
