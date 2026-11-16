// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { firstProblem } from './useFocusAfterRender.js';

describe('firstProblem (legacy 776)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is the control the first error is said on, in reading order', () => {
    document.body.innerHTML = `
      <form>
        <input id="a" /><p class="field-hint" id="a-hint">hint</p>
        <input id="steps.0-b" /><p class="field-error" id="steps.0-b-error" role="alert">B</p>
        <input id="c" /><p class="field-error" id="c-error" role="alert">C</p>
      </form>`;
    expect(firstProblem(document.querySelector('form'))?.id).toBe('steps.0-b');
  });

  it('is the error itself, made focusable, when no control is found for it', () => {
    document.body.innerHTML = `
      <form>
        <div class="field-error" role="alert" data-testid="left">A step's problem</div>
        <input id="c" /><p class="field-error" id="c-error" role="alert">C</p>
      </form>
      <input id="outside" />`;
    const form = document.querySelector('form');
    const said = firstProblem(form);
    expect(said?.dataset.testid).toBe('left');
    expect(said?.getAttribute('tabindex')).toBe('-1');
    said?.focus();
    expect(document.activeElement).toBe(said);

    // A control outside the form, or one that cannot take focus, is not where focus goes.
    document.body.innerHTML = `
      <form><p class="field-error" id="outside-error" role="alert">O</p></form>
      <input id="outside" />`;
    expect(firstProblem(document.querySelector('form'))?.id).toBe('outside-error');
    document.body.innerHTML = `
      <form><input id="d" disabled /><p class="field-error" id="d-error" role="alert">D</p></form>`;
    expect(firstProblem(document.querySelector('form'))?.id).toBe('d-error');
  });

  it('is nothing when nothing is said', () => {
    document.body.innerHTML = '<form><input id="a" /></form>';
    expect(firstProblem(document.querySelector('form'))).toBeUndefined();
    expect(firstProblem(null)).toBeUndefined();
  });
});
