import { createHash } from 'node:crypto';

/**
 * application/change-plan/component-id: the family id a source names a new Skill or Worker by (S11
 * P1-D; moved here from `application/packs` for AA3b-2). A pack's components and an admin
 * proposal's new families are named the same way — the proposal's `sourceName` in the pack's place
 * — so a proposal exported as a pack keeps their ids, and the core resolves an admin proposal's
 * intent without importing `application/packs` (which imports the core).
 */

const PACK_COMPONENT_NAMESPACE_HEX = '468a8e7084742c0f6e0f32f642b20c82';

/** The deterministic family id of pack `pack`'s Skill or Worker `name`: a name-based (version 5)
 *  uuid, the same construction as `deriveOntologyPackId` under its own namespace, over the kind,
 *  the pack and the name — so no workspace's own Skills or WorkerDefinitions (random ids) and no
 *  other pack's can be taken for it. */
export function derivePackComponentId(
  pack: string,
  kind: 'skill' | 'worker',
  name: string,
): string {
  const bytes = Buffer.from(
    createHash('sha1')
      .update(Buffer.from(PACK_COMPONENT_NAMESPACE_HEX, 'hex'))
      .update(Buffer.from(`${kind}\n${pack}\n${name}`, 'utf8'))
      .digest()
      .subarray(0, 16),
  );
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
