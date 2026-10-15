// Unit tests for scripts/guards/disabled-reason.mjs's detector; the guard itself runs against the
// real console source in CI (`quality`) and `pnpm ci:guards`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findViolations, needsReason } from './disabled-reason.mjs';

test('needsReason: a button grey only while the action runs explains itself', () => {
  assert.equal(needsReason('busy'), false);
  assert.equal(needsReason('submitting'), false);
  assert.equal(needsReason('state.busy'), false);
  assert.equal(needsReason('history.loadingMore'), false);
  assert.equal(needsReason("pending.state.status === 'ready' && pending.state.refreshing"), false);
  assert.equal(needsReason("discovery.status === 'loading'"), false);
  assert.equal(needsReason('busy !== null && busy !== "approve"'), false);
});

test('needsReason: a gate on the form’s content needs a visible reason', () => {
  assert.equal(needsReason('!ready'), true);
  assert.equal(needsReason('!canSubmit'), true);
  assert.equal(needsReason('busy || index === 0'), true);
  assert.equal(needsReason("workspaceId === ''"), true);
  assert.equal(needsReason('!canDiscover || discovery.status === "loading"'), true);
});

test('needsReason: pass-through and self-explained gates', () => {
  assert.equal(needsReason('disabled'), false);
  assert.equal(needsReason('busy || credentialReview.blocked'), false);
});

const form = (between) => `
<form>
  <Button type="submit" disabled={!ready}>
    Save
  </Button>
${between}
</form>`;

test('findViolations: flags a content-gated button with nothing next to it', () => {
  assert.deepEqual(findViolations(form('')), [{ line: 3, expression: '!ready' }]);
});

test('findViolations: a nearby StillNeeded, a title or an allow comment satisfies it', () => {
  assert.deepEqual(findViolations(form('  <StillNeeded items={missing} />')), []);
  assert.deepEqual(
    findViolations('<Button disabled={!ready} title={why}>Save</Button>'),
    [],
  );
  assert.deepEqual(
    findViolations(
      '{/* ux-lint-allow-disabled: the first step cannot move up. */}\n<Button disabled={index === 0}>Up</Button>',
    ),
    [],
  );
  // An allow comment needs a reason.
  assert.equal(
    findViolations('{/* ux-lint-allow-disabled: */}\n<Button disabled={index === 0}>Up</Button>')
      .length,
    1,
  );
});

test('findViolations: busy-only buttons and buttons without disabled are ignored', () => {
  assert.deepEqual(findViolations('<Button disabled={submitting}>Save</Button>'), []);
  assert.deepEqual(findViolations('<button type="button" onClick={go}>Go</button>'), []);
});
