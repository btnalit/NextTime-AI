import type { ObjectWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { objectNameAndType } from '../../lib/graph-view.js';

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * components/graph/useObjectLabels (legacy 470): 「名字 · 类型」 for the Objects a check names by
 * id, so a sentence about a Fact check names them the way the check's editor does. One
 * `get_object` per id (a check names a few; there is no batch read); an id that cannot be read
 * (gone, not visible to the reader) is left out, and the sentence keeps its short id.
 */
export function useObjectLabels(
  http: CapabilityCaller,
  ids: readonly string[],
): ReadonlyMap<string, string> {
  const key = [...new Set(ids)].sort().join(',');
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(NONE);
  useEffect(() => {
    if (key === '') return;
    let live = true;
    void Promise.all(
      key.split(',').map((objectId) =>
        http
          .call<ObjectWire | null>('get_object', { objectId })
          .then((object) => [objectId, object] as const)
          .catch(() => [objectId, null] as const),
      ),
    ).then((rows) => {
      if (!live) return;
      setLabels((prev) => {
        const next = new Map(prev);
        for (const [id, object] of rows) if (object) next.set(id, objectNameAndType(object));
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [http, key]);
  return labels;
}
