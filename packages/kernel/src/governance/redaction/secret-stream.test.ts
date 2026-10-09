import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  STREAM_HOLD_MAX_CHARS,
  createSecretStreamScrubber,
  scrubSecretValues,
} from './index.js';

/** A Handle-shaped compact JWT (header `{"alg":"EdDSA"}`). Synthetic — `.gitleaks.toml` allows
 *  this signature segment. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';

/** Texts with a secret of every shape the scrub knows, at the start, middle and end. */
const TEXTS: readonly string[] = [
  `my Handle is ${HANDLE}, keep it safe`,
  `HOME=/workspace\nCAPABILITY_HANDLE=${HANDLE}\nKERNEL_URL=http://kernel:8080\n`,
  `token: ${HANDLE}`,
  `图里没有 depends_on 关系。我的 Handle 是${HANDLE}。请勿外传。`,
  'Authorization: Bearer abc.def-123456 and Basic dXNlcjpwYXNzd29yZA== done',
  'connect to postgres://nexttime:s3cret@db:5432/x now',
  '{"api_key": "abc 123 def", "n": 1, "note": "a \\"quoted\\" token"}',
  'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\nAAAAC3Nza\n-----END OPENSSH PRIVATE KEY-----\nafter',
  'run PGPASSWORD=hunter2 psql and /login?user=a&password=hunter2&x=1',
  'nothing secret here: max_tokens=1024, the depends_on edge, tokenCount 3 — 普通的中文句子。',
  'export API_TOKEN="abcdefghijklmnopqrstuvwxyz 0123" && password: \'two words\' --password  x y',
  'I don\'t know; password: "correct horse battery" said the note. Cookie: a=1; b=2\nnext',
  'POSTGRES_PASSWORD: abcdefghijklmnopqrstuvwxyz\nX-Api-Key: abcdefghijklmnopqrstuvwxyz0123 end',
];

/** Everything a scrubber emits for `pieces`, then its flush. */
function stream(pieces: readonly string[]): { text: string; redactedValues: number } {
  const scrubber = createSecretStreamScrubber();
  let text = '';
  let redactedValues = 0;
  for (const piece of [...pieces.map((p) => scrubber.push(p)), scrubber.flush()]) {
    text += piece.value;
    redactedValues += piece.redactedValues;
  }
  return { text, redactedValues };
}

describe('createSecretStreamScrubber — a secret split across pieces is still scrubbed', () => {
  it.each(TEXTS.map((text) => [text.slice(0, 32), text]))(
    'split anywhere in two, the output is the whole text scrubbed: %s…',
    (_label, text) => {
      const whole = scrubSecretValues(text);
      for (let at = 0; at <= text.length; at += 1) {
        expect(stream([text.slice(0, at), text.slice(at)])).toEqual({
          text: whole.value,
          redactedValues: whole.redactedValues,
        });
      }
    },
  );

  it.each(TEXTS.map((text) => [text.slice(0, 32), text]))(
    'one character at a time, and in uneven pieces, the same: %s…',
    (_label, text) => {
      const whole = scrubSecretValues(text).value;
      expect(stream([...text]).text).toBe(whole);
      for (const size of [2, 3, 5, 7, 13]) {
        const pieces = [];
        for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
        expect(stream(pieces).text).toBe(whole);
      }
    },
  );

  it('never emits any part of a Handle, whatever was emitted so far', () => {
    const text = `我的 Handle 是 ${HANDLE} 。`;
    const scrubber = createSecretStreamScrubber();
    let emitted = '';
    for (const char of text) {
      emitted += scrubber.push(char).value;
      expect(emitted).not.toContain('eyJ');
    }
    emitted += scrubber.flush().value;
    expect(emitted).toBe(`我的 Handle 是 ${REDACTED} 。`);
  });

  it('holds a secret JSON value back until it is closed, spaces and all', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('{"password": "correct horse').value).toBe('{');
    expect(scrubber.push(' battery staple"}, ').value).toBe(`"password": "${REDACTED}"}, `);
    expect(scrubber.flush().value).toBe('');
  });
});

describe('createSecretStreamScrubber — the stream stays live', () => {
  it('emits Chinese prose as it arrives — no spaces does not mean held back', () => {
    const scrubber = createSecretStreamScrubber();
    for (const char of '图里没有这类关系。') expect(scrubber.push(char).value).toBe(char);
  });

  it('holds back only the word being written', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('hello wor').value).toBe('hello ');
    expect(scrubber.push('ld and').value).toBe('world ');
    expect(scrubber.flush().value).toBe('and');
  });

  it('past its bound it drops what it held and emits nothing more until flushed', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push(`start ${'A'.repeat(STREAM_HOLD_MAX_CHARS + 1)}`)).toEqual({
      value: `start ${REDACTED}`,
      redactedValues: 1,
    });
    expect(scrubber.push(' more text ').value).toBe('');
    expect(scrubber.flush().value).toBe('');
    expect(scrubber.push('next ').value).toBe('next ');
  });
});
