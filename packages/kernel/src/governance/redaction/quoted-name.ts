/**
 * Legacy 232: how a caller-chosen name (an Operation / action kind) appears inside a message the
 * kernel writes — an error, a stored failure reason, a log line. Such a name is any string the
 * caller sent or proposed, so it is quoted the JSON way (quotes, backslashes and control
 * characters — a line break included — escaped, so it can neither end the quote nor forge a log
 * line) and clipped to `QUOTED_NAME_MAX` characters, so a long one cannot fill the message.
 */
export const QUOTED_NAME_MAX = 120;

export function quotedName(name: string): string {
  const clipped = name.length > QUOTED_NAME_MAX ? `${name.slice(0, QUOTED_NAME_MAX)}…` : name;
  return JSON.stringify(clipped);
}
