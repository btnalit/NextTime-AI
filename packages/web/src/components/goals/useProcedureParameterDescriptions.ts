import type { PlanSourceProcedureWire, ProcedureSummaryWire } from '@nexttime/shared';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { parsedProcedureParameters } from '../../lib/procedure-template.js';

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * components/goals/useProcedureParameterDescriptions (legacy 474): what each start parameter of a
 * plan made from a Procedure is, by the `description` the Procedure's parameters schema gives it.
 * Read from `list_procedures` (its latest version per id) and used only when that is the version
 * the plan was made from — a later version may say something else; then, or when the read fails,
 * the parameters show by name alone.
 */
export function useProcedureParameterDescriptions(
  http: CapabilityCaller,
  source: PlanSourceProcedureWire | null,
): ReadonlyMap<string, string> {
  const wanted = source?.parameters ? source : null;
  const procedures = useCapabilityList<ProcedureSummaryWire>(
    http,
    'list_procedures',
    {},
    { enabled: wanted !== null, autoLoadAll: true },
  );
  if (wanted === null || procedures.state.status !== 'ready') return NONE;
  const procedure = procedures.state.data.items.find(
    (item) => item.id === wanted.procedureId && item.version === wanted.version,
  );
  const properties = parsedProcedureParameters(procedure?.parameters)?.properties;
  if (!properties) return NONE;
  const descriptions = new Map<string, string>();
  for (const [name, schema] of Object.entries(properties)) {
    const description = schema.description?.trim();
    if (description) descriptions.set(name, description);
  }
  return descriptions;
}
