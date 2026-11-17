import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactSuspectedSecrets } from '../../governance/redaction/index.js';
import { keptGatePayload } from './gate-observation.js';

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
