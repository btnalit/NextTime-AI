import { shownFreeText } from '../redaction/index.js';

/**
 * substrate/graph/shown-object (legacy 420): an Object's properties as the graph reads hand them
 * out. One field differs from what is stored: an Operation Object's `description`, the text every
 * agent reads in its tool list. It is the one property a person changes in place with no review
 * (`update_operation_description`; a publish reviews suspected credentials, and observed Objects'
 * properties are scrubbed at write), so one stored before that capability refused credentials
 * reads as `shownFreeText` shows free text. The row stays as stored.
 */
export function shownObjectProperties(
  objectType: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  if (objectType !== 'Operation' || typeof properties.description !== 'string') return properties;
  return { ...properties, description: shownFreeText(properties.description) };
}
