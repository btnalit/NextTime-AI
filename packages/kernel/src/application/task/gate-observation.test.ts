import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactSuspectedSecrets } from '../../governance/redaction/index.js';
import { gateObservationContent, gatePayloadKeptRaw, keptGatePayload } from './gate-observation.js';

/** A JWT-shaped value, made at run time — never a real credential. */
function syntheticJwt(): string {
  return [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(`{"sub":"${randomUUID()}"}`).toString('base64url'),
    Buffer.from(randomUUID()).toString('base64url'),
  ].join('.');
}

const KEPT_CHARS = 8_000;
const fullCopy = (payload: unknown): unknown =>
  redactSuspectedSecrets(payload, { secretFields: true }).value;

describe('keptGatePayload (legacy 237)', () => {
  it('keeps a small result whole, as the call-argument rule’s copy', () => {
    const payload = {
      hosts: ['h1'],
      database: { user: 'app', password: `synthetic-${randomUUID()}` },
      note: `deploy with Authorization: Bearer ${syntheticJwt()}`,
    };
    const kept = keptGatePayload(payload);
    expect(kept).toEqual({ value: fullCopy(payload), truncated: false });
    expect(kept.value).toMatchObject({ database: { password: '[redacted]' } });
  });

  it('cuts a large result to what is kept, matching the whole copy up to the cut', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => ({
      host: `h-${index}`,
      note: 'an ordinary inventory row with nothing secret in it',
    }));
    const payload = { rows, database: { password: `synthetic-${randomUUID()}` } };
    const kept = keptGatePayload(payload);
    expect(kept.truncated).toBe(true);
    expect(typeof kept.value).toBe('string');
    const whole = JSON.stringify(fullCopy(payload));
    expect((kept.value as string).slice(0, KEPT_CHARS)).toBe(whole.slice(0, KEPT_CHARS));
    expect(kept.value as string).toMatch(/… \[\d+ more characters omitted\]$/);
  });

  it('a secret the cut crosses was read whole and replaced: no part of it is kept', () => {
    const jwt = syntheticJwt();
    // `{"filler":"` + filler + `","note":"token ` puts the token's first character just before
    // the cut, and its end past it.
    const filler = 'x'.repeat(KEPT_CHARS - 10 - '{"filler":"'.length - '","note":"token '.length);
    const payload = { filler, note: `token ${jwt}` };
    expect(JSON.stringify(payload).indexOf(jwt)).toBe(KEPT_CHARS - 10);

    const kept = keptGatePayload(payload);
    expect(kept.truncated).toBe(true);
    expect(kept.value as string).not.toContain(jwt.slice(0, 10));
  });

  it('the margin covers a secret as long as any replaced whole: a 3 KB token the cut crosses leaves nothing', () => {
    // A JWT whose claims run to ~3 KB (a Handle is well under 2k, a PEM RSA-4096 key ~3.3k): cut
    // short of its end, it would no longer be a JWT to the value patterns.
    const claims = Buffer.from(JSON.stringify({ sub: randomUUID(), pad: 'p'.repeat(2_400) }));
    const jwt = [
      Buffer.from('{"alg":"HS256"}').toString('base64url'),
      claims.toString('base64url'),
      Buffer.from(randomUUID()).toString('base64url'),
    ].join('.');
    expect(jwt.length).toBeGreaterThan(3_000);
    const filler = 'x'.repeat(KEPT_CHARS - 10 - '{"filler":"'.length - '","note":"token '.length);
    const payload = { filler, note: `token ${jwt}` };
    expect(JSON.stringify(payload).indexOf(jwt)).toBe(KEPT_CHARS - 10);

    const kept = keptGatePayload(payload);
    expect(kept.truncated).toBe(true);
    expect(kept.value as string).not.toContain(jwt.slice(0, 10));
  });

  it('only the start of a result is read: a start that redaction shortened below the cut is kept as it is, marked truncated', () => {
    const tokens = Array.from({ length: 400 }, () => syntheticJwt());
    const payload = { notes: tokens.map((token) => `Authorization: Bearer ${token}`) };
    const kept = keptGatePayload(payload);

    // Read whole, its copy would be longer than the cut; read to the bound, it is shorter, and the
    // strings past the bound are left out as one `[…]`.
    expect(JSON.stringify(fullCopy(payload)).length).toBeGreaterThan(KEPT_CHARS);
    expect(JSON.stringify(kept.value).length).toBeLessThan(KEPT_CHARS);
    expect(kept.truncated).toBe(true);
    const notes = (kept.value as { notes: string[] }).notes;
    expect(notes.length).toBeLessThan(tokens.length);
    expect(notes.slice(0, 10)).toEqual(
      (fullCopy(payload) as { notes: string[] }).notes.slice(0, 10),
    );
    expect(notes[0]).toContain('[redacted]');
    expect(notes.at(-1)).toBe('[…]');
    const stored = JSON.stringify(kept.value);
    for (const token of tokens) expect(stored).not.toContain(token.split('.')[1]);
  });

  it('a copy that ends where reading stopped keeps no start of the secret it stopped in (legacy 819)', () => {
    // JWTs replaced by `[redacted]` shorten the copy below the cut, so the copy ends where reading
    // stopped (12 096 characters in) — inside the password.
    const read = KEPT_CHARS + 4_096;
    const tokens = Array.from({ length: 80 }, () => syntheticJwt()).join(' ');
    const password = 'password: "qz7 correct horse battery staple" done';
    const note = `${tokens}${' '.repeat(read - 15 - tokens.length)}${password}${'z'.repeat(5_000)}`;
    expect(note.indexOf(password)).toBe(read - 15);

    const kept = keptGatePayload(note);
    expect(kept.truncated).toBe(true);
    expect(JSON.stringify(kept.value).length).toBeLessThan(KEPT_CHARS);
    expect(JSON.stringify(kept.value)).not.toContain('qz7');
  });

  it('a copy cut where an emoji falls ends before it, never in half of it, and says how much it left out (legacy 834)', () => {
    const EMOJI = '\u{1F600}';
    // `"` + filler puts the emoji's first half last before the cut.
    const note = `${'x'.repeat(KEPT_CHARS - 2)}${EMOJI}${'y'.repeat(100)}`;
    expect(JSON.stringify(note).charCodeAt(KEPT_CHARS - 1)).toBe(0xd83d);

    const kept = keptGatePayload(note);
    expect(kept.truncated).toBe(true);
    const serialized = JSON.stringify(note);
    expect(kept.value).toBe(
      `"${'x'.repeat(KEPT_CHARS - 2)}… [${serialized.length - (KEPT_CHARS - 1)} more characters omitted]`,
    );
  });
});

describe('gatePayloadKeptRaw — what the scrub counts (legacy 817)', () => {
  /** No value pattern knows it: only the field it sits under gives it away. */
  const PLAIN = 'hunter2-plain-word';
  /** A row as one written before legacy 237 stored it: the gate's result as it came. */
  const storedBefore = (payload: unknown): Record<string, unknown> => {
    const serialized = JSON.stringify(payload);
    return serialized.length <= KEPT_CHARS
      ? { payload, truncated: false }
      : {
          payload: `${serialized.slice(0, KEPT_CHARS)}… [${serialized.length - KEPT_CHARS} more characters omitted]`,
          truncated: true,
        };
  };
  /** A row as one written now is. */
  const storedNow = (payload: unknown): Record<string, unknown> =>
    gateObservationContent({
      gatekeeperId: randomUUID(),
      gateName: 'g',
      operation: 'op',
      mode: 'observe',
      status: 'ok',
      payload,
    });
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      host: `h-${index}`,
      note: 'an ordinary inventory row with nothing secret in it',
    }));

  it('a result kept whole as it came is counted when the rule would hide something in it', () => {
    for (const payload of [
      { database: { user: 'app', password: PLAIN } },
      { cfg: { apiKey: 12_345_678 } },
      { note: `deploy with Authorization: Bearer ${syntheticJwt()}` },
      `export TOKEN=${syntheticJwt()}`,
    ]) {
      expect(gatePayloadKeptRaw(storedBefore(payload)), JSON.stringify(payload)).toBe(true);
    }
    for (const payload of [{ hosts: ['h1'], ok: true }, 'all good', null, { rows: rows(3) }]) {
      expect(gatePayloadKeptRaw(storedBefore(payload)), JSON.stringify(payload)).toBe(false);
    }
  });

  it('a result stored cut, as text, is judged by the field rule over its JSON text', () => {
    // An object under a secret-named field: no value pattern finds what is inside it.
    const before = storedBefore({ secrets: { user: 'svc', value: PLAIN }, rows: rows(400) });
    expect(before.truncated).toBe(true);
    expect(before.payload).toContain(PLAIN);
    expect(gatePayloadKeptRaw(before)).toBe(true);
    // The same text with no field rule over it: the value patterns alone pass it.
    expect(gatePayloadKeptRaw({ ...before, truncated: false })).toBe(false);

    // The cut lands inside the secret: what is left of it is still found.
    const head = JSON.stringify({ rows: rows(1), pad: '' }).length;
    const cutInside = storedBefore({
      rows: rows(1),
      pad: 'x'.repeat(KEPT_CHARS - head - 30),
      secrets: { value: `${PLAIN}-${'y'.repeat(200)}` },
    });
    expect(cutInside.truncated).toBe(true);
    // The secret's string is left open where the cut falls, the note after it.
    expect(cutInside.payload).toMatch(
      /"secrets":\{"value":"hunter2[^"]*… \[\d+ more characters omitted\]$/,
    );
    expect(gatePayloadKeptRaw(cutInside)).toBe(true);
    expect(gatePayloadKeptRaw(storedBefore({ rows: rows(400) }))).toBe(false);
  });

  it('a row written now is marked as the kept copy and never counted', () => {
    for (const payload of [
      { database: { user: 'app', password: PLAIN } },
      { secrets: { user: 'svc', value: PLAIN, port: 5432 }, token: 12_345_678 },
      { note: `deploy with Authorization: Bearer ${syntheticJwt()}` },
      // Cut, as text, where the value patterns read `"credentials":{` as a value given to it.
      { credentials: { value: PLAIN }, rows: rows(400) },
      `export TOKEN=${syntheticJwt()} ${'z'.repeat(20_000)}`,
      { hosts: ['h1'], ok: true },
    ]) {
      const now = storedNow(payload);
      expect(now.payloadRedacted).toBe(true);
      expect(JSON.stringify(now)).not.toContain(PLAIN);
      expect(gatePayloadKeptRaw(now), JSON.stringify(now).slice(0, 120)).toBe(false);
    }
  });

  it('without the marker, the kept copy kept whole is not counted, and one cut can be: an upper bound', () => {
    const unmarked = (payload: unknown) => {
      const { payloadRedacted: _, ...rest } = storedNow(payload);
      return rest;
    };
    // The field rule replaces each `[redacted]` under these again and counts it; the copies are
    // compared, so the copy kept whole is not counted.
    expect(
      gatePayloadKeptRaw(unmarked({ secrets: { user: 'svc', value: PLAIN }, token: 12_345_678 })),
    ).toBe(false);
    const cut = unmarked({ credentials: { value: PLAIN }, rows: rows(400) });
    expect(cut.truncated).toBe(true);
    expect(cut.payload).toContain('"credentials":{"value":"[redacted]"}');
    expect(gatePayloadKeptRaw(cut)).toBe(true);
  });
});
