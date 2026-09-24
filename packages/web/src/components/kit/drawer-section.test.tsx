// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DrawerSection, DrawerSections } from './drawer-section.js';

afterEach(cleanup);

describe('kit/DrawerSection + DrawerSections', () => {
  it('renders every section titled, in the order given, sharing one heading style', () => {
    render(
      <DrawerSections>
        <DrawerSection title="元数据" testId="meta">
          <p>id, status</p>
        </DrawerSection>
        <DrawerSection title="相关链接" testId="links">
          <p>a link</p>
        </DrawerSection>
        <DrawerSection title="编辑" testId="form">
          <p>a field</p>
        </DrawerSection>
      </DrawerSections>,
    );
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['元数据', '相关链接', '编辑']);
    // One shared class list across every heading — never per-section casing drift.
    const classNames = new Set(headings.map((h) => h.className));
    expect(classNames.size).toBe(1);
    expect(screen.getByTestId('meta')).toBeTruthy();
    expect(screen.getByTestId('links')).toBeTruthy();
    expect(screen.getByTestId('form')).toBeTruthy();
  });

  it('a drawer with nothing to link renders just the sections it has', () => {
    render(
      <DrawerSections>
        <DrawerSection title="元数据">
          <p>id</p>
        </DrawerSection>
        <DrawerSection title="编辑">
          <p>a field</p>
        </DrawerSection>
      </DrawerSections>,
    );
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  });
});
