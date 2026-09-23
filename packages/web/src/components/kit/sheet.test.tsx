// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from './sheet.js';

afterEach(cleanup);

describe('kit/Sheet', () => {
  it('opens on trigger click, renders role="dialog", and defaults to the right-side variant class', async () => {
    render(
      <Sheet>
        <SheetTrigger>详情</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Gatekeeper 详情</SheetTitle>
          </SheetHeader>
          <SheetClose>关闭</SheetClose>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toContain('Gatekeeper 详情');
    expect(sheet.className).toContain('right-0');
  });

  it('side="left" applies the left-side variant class', async () => {
    render(
      <Sheet defaultOpen>
        <SheetContent side="left">
          <SheetTitle>侧边</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const sheet = await screen.findByRole('dialog');
    expect(sheet.className).toContain('left-0');
  });

  it('closes via SheetClose', async () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>关闭测试</SheetTitle>
          <SheetClose>关闭</SheetClose>
        </SheetContent>
      </Sheet>,
    );
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
