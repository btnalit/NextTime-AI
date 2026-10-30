import { createContext, useContext } from 'react';

/** What a `Field` (`kit/field`, `components/ui/Field`) shows under its control: the ids of the
 *  hint and the error, while each is shown, and the control's own id. */
export interface FieldDescription {
  readonly controlId: string;
  readonly describedBy: string | undefined;
}

export const FieldDescriptionContext = createContext<FieldDescription | null>(null);

/**
 * Legacy 498: a Field's hint and error, said to whoever focuses its control. The form code used
 * to wire `aria-describedby` by hand on every control (`describedBy`), and dozens never were — a
 * screen reader read neither the hint nor the error. A control inside a `Field` now points at
 * them by default; one the form describes itself (`explicit`, say an extra note outside the
 * Field) keeps its own. Only the control the Field's label is for (`id === controlId`) — any
 * other control inside it says nothing it does not say itself.
 */
export function useFieldDescribedBy(
  id: string | undefined,
  explicit: string | undefined,
): string | undefined {
  const field = useContext(FieldDescriptionContext);
  if (explicit !== undefined) return explicit;
  if (field === null || id === undefined || id !== field.controlId) return undefined;
  return field.describedBy;
}
