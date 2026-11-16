import type { OperationParamSummaryWire } from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/operation-params (legacy 775): an Operation's params, filled in one by one, over the JSON
 * object a check sends (`params`). The Operation's own param summary (`list_operations`, legacy
 * 465: name, in, required, type, gateOwned) says what to offer; the JSON text stays what the form
 * keeps and sends, so switching back to editing it as JSON loses nothing.
 */

/** Why a field cannot be sent as it is: a required param left empty, or what it holds is not a
 *  value of its param's type. */
export type ParamProblem = 'required' | 'number' | 'integer' | 'object' | 'array';

/** What a field's problem says, on the field and among the form's errors. */
export function paramProblemText(problem: ParamProblem, t: Translate): string {
  switch (problem) {
    case 'required':
      return t('这个参数必填。', 'This param is required.');
    case 'number':
      return t('要填一个数字。', 'Enter a number.');
    case 'integer':
      return t('要填一个整数。', 'Enter a whole number.');
    case 'object':
      return t('要填一个 JSON 对象，比如 {"a": 1}。', 'Enter a JSON object, like {"a": 1}.');
    case 'array':
      return t('要填一个 JSON 数组，比如 ["a"]。', 'Enter a JSON array, like ["a"].');
  }
}

/** The text in each param's field, by param name. An empty text leaves the param out. */
export type ParamTexts = Readonly<Record<string, string>>;

/** The params a person fills in: every one but those only the gate sets, required ones first,
 *  then by name (the order the kernel lists them in). */
export function fillableParams(
  params: readonly OperationParamSummaryWire[],
): readonly OperationParamSummaryWire[] {
  return params
    .filter((param) => param.gateOwned !== true)
    .sort((a, b) =>
      a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1,
    );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** What a param's field shows for a value already in the JSON, or `null` when the field could
 *  not hold it without changing it (a number in a text param, say). */
function textOf(param: OperationParamSummaryWire, value: unknown): string | null {
  switch (param.type) {
    case 'string':
      return typeof value === 'string' ? value : null;
    case 'number':
      return typeof value === 'number' ? String(value) : null;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? String(value) : null;
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : null;
    case 'object':
      return isPlainObject(value) ? JSON.stringify(value) : null;
    case 'array':
      return Array.isArray(value) ? JSON.stringify(value) : null;
    default:
      // No single type: the field takes a JSON value, or text that is not JSON as that text —
      // so a word shows without quotes, and anything else as JSON; either way it round-trips.
      return typeof value === 'string' && value.trim() !== '' && !parsesAsJson(value)
        ? value
        : JSON.stringify(value);
  }
}

/** The fields' texts for the params JSON `text`, or `null` when it cannot be shown field by field:
 *  not a JSON object, a key that is not a param a person fills in (unknown, or only the gate sets
 *  it), or a value its field could not hold. */
export function paramTextsOf(
  text: string,
  fillable: readonly OperationParamSummaryWire[],
): ParamTexts | null {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const byName = new Map(fillable.map((param) => [param.name, param]));
  const texts: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const param = byName.get(name);
    if (param === undefined) return null;
    const shown = textOf(param, value);
    if (shown === null) return null;
    texts[name] = shown;
  }
  return texts;
}

const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** One field's value: what its text means for its param's type, or the text itself with the
 *  problem when it does not fit (sent as typed, so nothing the person wrote is dropped). */
function paramValue(
  param: OperationParamSummaryWire,
  text: string,
): { readonly value: unknown; readonly problem?: ParamProblem } {
  switch (param.type) {
    case 'string':
      return { value: text };
    case 'number':
    case 'integer': {
      const trimmed = text.trim();
      const number = NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
      if (!Number.isFinite(number)) return { value: text, problem: param.type };
      // Review #501 on #1296 (P3-1): a whole number past 2^53 is not one JSON can carry
      // exactly — sent as typed and said, rather than quietly changed to a neighbour.
      if (param.type === 'integer' && !Number.isSafeInteger(number)) {
        return { value: text, problem: 'integer' };
      }
      return { value: number };
    }
    case 'boolean':
      return { value: text === 'true' };
    default: {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // #1296 UX P3: a param with no single type takes text as typed when it is not JSON, so
        // a word needs no quotes; an object or an array must be JSON.
        return param.type === undefined ? { value: text } : { value: text, problem: param.type };
      }
      if (param.type === 'object' && !isPlainObject(parsed)) {
        return { value: text, problem: 'object' };
      }
      if (param.type === 'array' && !Array.isArray(parsed)) {
        return { value: text, problem: 'array' };
      }
      return { value: parsed };
    }
  }
}

/** The params JSON the fields make (`''` when none is filled in), in the fields' order, and the
 *  fields that cannot be sent as they are: a required one left empty, or text that does not fit
 *  its param's type. */
export function paramsTextFrom(
  texts: ParamTexts,
  fillable: readonly OperationParamSummaryWire[],
): { readonly text: string; readonly problems: Readonly<Record<string, ParamProblem>> } {
  const params: Record<string, unknown> = {};
  const problems: Record<string, ParamProblem> = {};
  for (const param of fillable) {
    const text = texts[param.name] ?? '';
    // A text param keeps its spaces; any other empty-looking field is left out.
    if (param.type === 'string' ? text === '' : text.trim() === '') {
      if (param.required) problems[param.name] = 'required';
      continue;
    }
    const { value, problem } = paramValue(param, text);
    params[param.name] = value;
    if (problem !== undefined) problems[param.name] = problem;
  }
  return {
    text: Object.keys(params).length === 0 ? '' : JSON.stringify(params, null, 2),
    problems,
  };
}
