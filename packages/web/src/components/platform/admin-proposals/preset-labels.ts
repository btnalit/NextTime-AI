import type { ConnectorPresetWire } from '@nexttime/shared';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';

/** A connector preset's display name by its name (`ragflow` → `RAGFlow`); its name when this
 *  deployment ships no preset by it. */
export type PresetLabel = (name: string) => string;

const ALL_PRESETS: Readonly<Record<string, unknown>> = {};

/** The presets this deployment ships (`list_connector_presets`, the platform plane's — a workspace
 *  owner cannot read it, so 能力目录 · 管理员提案 shows the name), as {@link PresetLabel}. */
export function usePresetLabel(http: CapabilityCaller): PresetLabel {
  const list = useCapabilityList<ConnectorPresetWire>(http, 'list_connector_presets', ALL_PRESETS, {
    autoLoadAll: true,
  });
  const names = new Map(
    list.state.status === 'ready'
      ? list.state.data.items.map((preset) => [preset.name, preset.displayName] as const)
      : [],
  );
  return (name) => names.get(name) ?? name;
}
