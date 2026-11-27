/**
 * What a model is shown of a gate tool's result (legacy 967 stage 1;
 * `docs/tool-result-and-budget-design-2026-11-27.md` §4.1). Every mode's gate tools render the
 * kernel's answer through `renderToolResult` — `worker.ts`'s `buildGateTool` (its result and the
 * simulate of a pending approval), `entry.ts`'s and `admin.ts`'s `buildGateObserveTool`.
 *
 * - Compact JSON, never indented: a result within the cap is `JSON.stringify(value)`, nothing added.
 * - The cap is on the whole text, the note line included (stricter than the design's "the cap plus
 *   the note"): a tool call's stored preview is cut at the same 16,000 characters (kernel
 *   `TOOL_CALL_RESULT_PREVIEW_CHARS`), and the console reads the envelope from it whole.
 * - Over the cap, only whole items are cut, and only inside `data` when the result has one: the
 *   envelope around it (`status`, `observedFactCount`, an ActionRequest's `id`) is kept as it is —
 *   a model tells a pending approval from a refusal by `status`. First every string longer than
 *   `LONG_STRING_CHARS` keeps its head and its tail (the newest lines of a log) with the count of
 *   what was left out between them, cut at code points. The tail is whole lines only (`tailStart`):
 *   the kernel redacts the text a model is shown, a value by the name before it, and a tail that
 *   began inside a line could hold a value whose name was left out (review #501 on #1629). Then,
 *   while it is still over, the last
 *   item of the array with the most characters of its own goes (`ownChars`: its serialized length
 *   less the arrays inside its items, which count on their own; a tie goes to the path first in
 *   code-unit order): what is left of each array is a prefix of it, and the body still parses.
 * - Only when even that does not fit (one item too large, nesting too deep, too many arrays to
 *   weigh) is the text cut by characters, as before — and the note says it is not complete JSON.
 * - The note line says which paths are incomplete and how much of each is shown; not to count or
 *   conclude from what is shown as if it were all; and which of the Operation's parameters narrow
 *   it, or, with none, to say in the result that the list is incomplete (invariant N1). It is the
 *   platform's words, never the gate's (N6): a path's key that is not a plain identifier is written
 *   as its place among its object's keys, and a parameter name is offered only if it is one.
 *
 * The text's shape — JSON, then `TOOL_RESULT_NOTE_SEPARATOR` and the note in brackets — is
 * `@nexttime/shared`'s `tool-result-text.ts`, which the console reads it with.
 *
 * Observed facts are written by the kernel from the whole answer (N2); `details` keeps it whole.
 *
 * It replaces `gate-tools.ts`'s `truncateToolResult` (S8 W3-K1, leftover 75 first half), which
 * indented the JSON and kept the head of its text: a list was cut mid-item, with no word of how
 * many items there were or how many the model saw (legacy 967, design §1.2).
 */

import { TOOL_RESULT_NOTE_SEPARATOR } from '@nexttime/shared';
import { gateToolParameters } from '../tool-schema.js';

const DEFAULT_GATE_TOOL_RESULT_MAX_CHARS = 16_000;

/** Reads `NEXTTIME_GATE_TOOL_RESULT_MAX_CHARS` once, at module load (= once per mode's process
 *  start — this package's `NEXTTIME_*` env var convention, `index.ts`'s own `readRequiredEnv`
 *  callers). An unset, unparsable, or non-positive value falls back to the default — a malformed
 *  override is worth ignoring, never worth crashing a Worker/entry container over. */
function resolveGateToolResultMaxChars(): number {
  const raw = process.env.NEXTTIME_GATE_TOOL_RESULT_MAX_CHARS;
  if (!raw) return DEFAULT_GATE_TOOL_RESULT_MAX_CHARS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GATE_TOOL_RESULT_MAX_CHARS;
}

/** The cap on the text a model is shown of one result, note line included, this process was started
 *  with — computed once. */
export const GATE_TOOL_RESULT_MAX_CHARS = resolveGateToolResultMaxChars();

/** The note line's bound, with the paths it names and the parameters it offers. */
export const NOTE_MAX_CHARS = 600;
/** What a shortened result keeps free of its cap for the note and the blank line before it. */
const NOTE_ROOM = TOOL_RESULT_NOTE_SEPARATOR.length + NOTE_MAX_CHARS;
const NOTE_MAX_PATHS = 5;
const NOTE_MAX_PARAMS = 8;
const PATH_MAX_CHARS = 120;
const PLAIN_NAME = /^[A-Za-z0-9_]{1,40}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** A string longer than this (code points) keeps `STRING_HEAD` and `STRING_TAIL` of them. */
export const LONG_STRING_CHARS = 2_000;
const STRING_HEAD = 400;
const STRING_TAIL = 1_200;
/** Beyond these the items are not weighed: the text is cut by characters. */
const MAX_ARRAYS = 2_000;
const MAX_DEPTH = 100;

export interface RenderOptions {
  /** Default: this process's `GATE_TOOL_RESULT_MAX_CHARS`. */
  readonly maxChars?: number;
  /** The Operation's parameters (its `params_schema`'s property names), offered to narrow it. */
  readonly narrowingParams?: readonly string[];
}

/** The parameter names of an Operation's gate tool, as `RenderOptions.narrowingParams`: read from
 *  the parameters the tool declares (`gateToolParameters`), so a name offered is one the model can
 *  pass (review #501 on #1629). */
export function paramNames(paramsSchema: unknown): string[] {
  const { properties } = gateToolParameters(paramsSchema) as { properties?: unknown };
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Cut {
  readonly path: string;
  /** `chars`: a long string's start and end; `start`: its start only (no line began in its tail). */
  readonly kind: 'items' | 'chars' | 'start';
  kept: number;
  readonly of: number;
}

/** An array of the body, weighed by `ownChars`. */
interface ArrayNode {
  readonly path: string;
  readonly items: Json[];
  readonly itemChars: number[];
  /** Its serialized length, and that of the live arrays directly inside its items. */
  chars: number;
  childChars: number;
  kept: number;
  dead: boolean;
  readonly parent: { readonly node: ArrayNode; readonly index: number } | undefined;
  readonly children: ArrayNode[];
  readonly cut: Cut;
}

class TooDeep extends Error {}

/** `text`'s length in code points. */
function codePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0xdc00 || unit > 0xdfff || i === 0) n += 1;
    else if (text.charCodeAt(i - 1) < 0xd800 || text.charCodeAt(i - 1) > 0xdbff) n += 1;
  }
  return n;
}

/** The code-unit index after `count` code points of `text` from `from`, going forward. */
function advance(text: string, from: number, count: number): number {
  let at = from;
  for (let n = 0; n < count && at < text.length; n += 1) {
    const unit = text.charCodeAt(at);
    at += unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length ? 2 : 1;
  }
  return at;
}

/** The code-unit index `count` code points before the end of `text`. */
function retreat(text: string, count: number): number {
  let at = text.length;
  for (let n = 0; n < count && at > 0; n += 1) {
    const unit = text.charCodeAt(at - 1);
    at -= unit >= 0xdc00 && unit <= 0xdfff && at - 2 >= 0 ? 2 : 1;
  }
  return at;
}

/** `text` cut to at most `max` code units, never between the two halves of a surrogate pair. */
function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const unit = text.charCodeAt(max - 1);
  return text.slice(0, unit >= 0xd800 && unit <= 0xdbff ? max - 1 : max);
}

function plainKey(key: string, place: number): string {
  return IDENTIFIER.test(key) ? `.${key}` : `.<key ${place + 1}>`;
}

/**
 * The kernel's private-key rule, as it is in kernel `substrate/redaction/secret-values.ts` (a test
 * here reads it there): a block runs from its BEGIN line to the first END line after it, or to the
 * end of the text when none comes. Exported for that test.
 */
export const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;

/**
 * Where a long string's kept tail starts: at most `STRING_TAIL` code points before its end, and
 * only at the start of a line — a value's name is on its own line before it (`password=…`,
 * `Authorization: Bearer …`, a JSON object in a string), so a tail that begins inside a line could
 * show a value without the name the kernel's redaction finds it by. No line starts there: no tail.
 * And no tail begins inside a private-key block as the kernel reads the whole string: the kernel
 * finds a block by its BEGIN line, which would be left out. The tail starts on the line after the
 * block ends instead, and a block that runs to the end leaves no tail (review #501, #493 on #1629).
 */
function tailStart(value: string): number {
  let at = retreat(value, STRING_TAIL);
  if (at > 0 && value.charCodeAt(at - 1) !== 0x0a) {
    const newline = value.indexOf('\n', at);
    if (newline === -1) return value.length;
    at = newline + 1;
  }
  for (const block of value.matchAll(PRIVATE_KEY_BLOCK)) {
    if (block.index >= at) break;
    const end = block.index + block[0].length;
    if (end <= at) continue;
    const newline = value.indexOf('\n', end);
    if (newline === -1) return value.length;
    at = newline + 1;
  }
  return at;
}

/** The long strings of `value`, kept head and tail; the cuts made, in order. */
function cutLongStrings(value: Json, path: string, cuts: Cut[], depth: number): Json {
  if (depth > MAX_DEPTH) throw new TooDeep();
  if (typeof value === 'string') {
    if (value.length <= LONG_STRING_CHARS) return value;
    const total = codePoints(value);
    if (total <= LONG_STRING_CHARS) return value;
    const head = value.slice(0, advance(value, 0, STRING_HEAD));
    const tail = value.slice(tailStart(value));
    const kept = STRING_HEAD + codePoints(tail);
    cuts.push({ path, kind: tail === '' ? 'start' : 'chars', kept, of: total });
    const marker = `${head} [... ${total - kept} characters omitted ...]`;
    return tail === '' ? marker : `${marker} ${tail}`;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => cutLongStrings(item, `${path}[${i}]`, cuts, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    Object.keys(value).forEach((key, place) => {
      out[key] = cutLongStrings(
        value[key] as Json,
        `${path}${plainKey(key, place)}`,
        cuts,
        depth + 1,
      );
    });
    return out;
  }
  return value;
}

/** `value`'s serialized length, registering its arrays (`nodes`) as it goes. */
function weigh(
  value: Json,
  path: string,
  parent: ArrayNode['parent'],
  nodes: ArrayNode[],
  depth: number,
): number {
  if (depth > MAX_DEPTH || nodes.length > MAX_ARRAYS) throw new TooDeep();
  if (Array.isArray(value)) {
    const node: ArrayNode = {
      path,
      items: value,
      itemChars: [],
      chars: 0,
      childChars: 0,
      kept: value.length,
      dead: false,
      parent,
      children: [],
      cut: { path, kind: 'items', kept: value.length, of: value.length },
    };
    nodes.push(node);
    parent?.node.children.push(node);
    value.forEach((item, index) => {
      node.itemChars.push(weigh(item, `${path}[${index}]`, { node, index }, nodes, depth + 1));
    });
    node.chars = 2 + node.itemChars.reduce((a, b) => a + b, 0) + Math.max(0, value.length - 1);
    if (parent !== undefined) parent.node.childChars += node.chars;
    return node.chars;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    let chars = 2 + Math.max(0, keys.length - 1);
    keys.forEach((key, place) => {
      chars +=
        JSON.stringify(key).length +
        1 +
        weigh(value[key] as Json, `${path}${plainKey(key, place)}`, parent, nodes, depth + 1);
    });
    return chars;
  }
  return JSON.stringify(value).length;
}

const ownChars = (node: ArrayNode): number => node.chars - node.childChars;

/** Whether `a` goes before `b`: more characters of its own, then the path first in order. */
function before(a: ArrayNode, b: ArrayNode): boolean {
  const ownA = ownChars(a);
  const ownB = ownChars(b);
  return ownA !== ownB ? ownA > ownB : a.path < b.path;
}

/** Marks `node` and every array inside it dead: an item that went takes them with it. */
function kill(node: ArrayNode): void {
  node.dead = true;
  for (const child of node.children) kill(child);
}

/** Drops the last kept item of `node`; returns the characters that took off the whole. */
function dropLast(node: ArrayNode): number {
  const index = node.kept - 1;
  const delta = (node.itemChars[index] as number) + (node.kept > 1 ? 1 : 0);
  let dead = 0;
  for (const child of node.children) {
    if (!child.dead && child.parent?.index === index) {
      dead += child.chars;
      kill(child);
    }
  }
  node.kept = index;
  node.cut.kept = index;
  node.chars -= delta;
  node.childChars -= dead;
  // Every array around it is shorter by as much, and so is its arrays-inside sum: their own
  // characters do not change.
  for (let up = node.parent; up !== undefined; up = up.node.parent) {
    up.node.itemChars[up.index] = (up.node.itemChars[up.index] as number) - delta;
    up.node.chars -= delta;
    up.node.childChars -= delta;
  }
  return delta;
}

/** Drops whole items, the heaviest array's last first, until `total` is within `max`; `total`
 *  after. Arrays whose ancestors went are dead and not weighed. */
function dropItems(nodes: ArrayNode[], total: number, max: number): number {
  let left = total;
  while (left > max) {
    let best: ArrayNode | undefined;
    for (const node of nodes) {
      if (node.dead || node.kept === 0) continue;
      if (best === undefined || before(node, best)) best = node;
    }
    if (best === undefined) break;
    // The same array keeps going while it is still the heaviest: weighed once for the run.
    let next: ArrayNode | undefined;
    for (const node of nodes) {
      if (node === best || node.dead || node.kept === 0) continue;
      if (next === undefined || before(node, next)) next = node;
    }
    do {
      left -= dropLast(best);
    } while (left > max && best.kept > 0 && (next === undefined || before(best, next)));
  }
  return left;
}

/** The body `cut` reads: `data` of an object that has one, else the whole value. */
function bodyOf(value: Json): { body: Json; path: string; put: (body: Json) => Json } {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
    return { body: value.data as Json, path: '.data', put: (body) => ({ ...value, data: body }) };
  }
  return { body: value, path: '', put: (body) => body };
}

/** A path as the note writes it: without the leading dot, and kept short. */
function shown(path: string): string {
  if (path === '') return 'the result';
  const bare = path.startsWith('.') ? path.slice(1) : path;
  return bare.length <= PATH_MAX_CHARS ? bare : `${bare.slice(0, 20)}...${bare.slice(-90)}`;
}

function described(cut: Cut): string {
  if (cut.kind === 'items') return `${shown(cut.path)}: ${cut.kept} of ${cut.of} items`;
  const where = cut.kind === 'chars' ? 'start and end' : 'start';
  return `${shown(cut.path)}: ${cut.kept} of ${cut.of} characters (${where})`;
}

/** The note line: `head`, which paths are cut (at most `NOTE_MAX_PATHS`, as many as fit), the
 *  warning, and how to narrow it. At most `NOTE_MAX_CHARS`. */
function note(head: string, cuts: readonly Cut[], narrowing: readonly string[]): string {
  const params = narrowing.filter((name) => PLAIN_NAME.test(name)).slice(0, NOTE_MAX_PARAMS);
  const tail =
    params.length > 0
      ? ` To narrow it, this Operation takes: ${params.join(', ')}.`
      : ' If you report a list from it, say that the list is incomplete.';
  const warn = ' Do not count or conclude from what is shown as if it were all of it.';
  for (let n = Math.min(cuts.length, NOTE_MAX_PATHS); n >= 0; n -= 1) {
    const rest = cuts.length - n;
    const which =
      n > 0
        ? ` ${cuts.slice(0, n).map(described).join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`
        : cuts.length > 0
          ? ` ${cuts.length} parts are incomplete.`
          : '';
    const line = `[${head}${which}${warn}${tail}]`;
    if (line.length <= NOTE_MAX_CHARS) return line;
  }
  return `[${head}${warn}]`.slice(0, NOTE_MAX_CHARS);
}

/** The text a model is shown of a gate tool's result `value` (module comment). */
export function renderToolResult(value: unknown, options: RenderOptions = {}): string {
  const max = options.maxChars ?? GATE_TOOL_RESULT_MAX_CHARS;
  const narrowing = options.narrowingParams ?? [];
  const compact = JSON.stringify(value) ?? 'null';
  if (compact.length <= max) return compact;
  // A cap smaller than the note's room leaves no JSON at all: only the note says what it was.
  const room = Math.max(0, max - NOTE_ROOM);

  const whole = JSON.parse(compact) as Json;
  const cuts: Cut[] = [];
  let cut: Json;
  try {
    const { body, path, put } = bodyOf(whole);
    cut = put(cutLongStrings(body, path, cuts, 0));
  } catch (err) {
    if (!(err instanceof TooDeep)) throw err;
    return characterCut(whole, room, narrowing);
  }
  const afterStrings = JSON.stringify(cut);
  if (afterStrings.length <= room) return withNote(afterStrings, note(SHORTENED, cuts, narrowing));

  const { body, path } = bodyOf(cut);
  const nodes: ArrayNode[] = [];
  try {
    weigh(body, path, undefined, nodes, 0);
  } catch (err) {
    if (!(err instanceof TooDeep)) throw err;
    return characterCut(cut, room, narrowing);
  }
  if (dropItems(nodes, afterStrings.length, room) > room) return characterCut(cut, room, narrowing);
  for (const node of nodes) if (!node.dead) node.items.length = node.kept;
  const itemCuts = nodes
    .filter((node) => !node.dead && node.kept < node.cut.of)
    .map((node) => node.cut)
    .sort((a, b) => b.of - b.kept - (a.of - a.kept) || (a.path < b.path ? -1 : 1));
  const stringCuts = cuts.filter((stringCut) => !gone(stringCut.path, nodes));
  return withNote(JSON.stringify(cut), note(SHORTENED, [...itemCuts, ...stringCuts], narrowing));
}

const SHORTENED = 'The result was shortened to fit:';

function withNote(json: string, noteLine: string): string {
  return `${json}${TOOL_RESULT_NOTE_SEPARATOR}${noteLine}`;
}

/** Whether `path` was inside an item that went. */
function gone(path: string, nodes: readonly ArrayNode[]): boolean {
  for (const node of nodes) {
    if (!path.startsWith(`${node.path}[`)) continue;
    const index = Number.parseInt(path.slice(node.path.length + 1), 10);
    if (node.dead || index >= node.kept) return true;
  }
  return false;
}

const DATA_PLACE = '\u0000data\u0000';

/** The last resort: the body's text cut by characters, the envelope around it as it is, and a
 *  note saying the body is not complete JSON. */
function characterCut(value: Json, max: number, narrowing: readonly string[]): string {
  const { body, path, put } = bodyOf(value);
  const bodyText = JSON.stringify(body);
  const [before = '', after = ''] = JSON.stringify(put(DATA_PLACE)).split(
    JSON.stringify(DATA_PLACE),
  );
  const room = max - before.length - after.length;
  if (path === '' || room <= 0) {
    const text = JSON.stringify(value);
    const head = headOf(text, max);
    return withNote(
      head,
      note(
        `The result was cut at ${head.length} of ${text.length} characters: the text above is not complete JSON.`,
        [],
        narrowing,
      ),
    );
  }
  const head = headOf(bodyText, room);
  return withNote(
    `${before}${head}${after}`,
    note(
      `Its data was cut at ${head.length} of ${bodyText.length} characters: what stands for it above is not complete JSON.`,
      [],
      narrowing,
    ),
  );
}
