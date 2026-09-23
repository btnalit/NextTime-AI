// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu.js';

afterEach(cleanup);

/** `DropdownMenuTrigger` opens on `onPointerDown`, not `onClick` (the Radix primitive's own
 *  handler) — `fireEvent.click` alone leaves the menu closed under jsdom. */
function openTrigger(name: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0 });
}

function renderMenu(onSelect: () => void) {
  return render(
    <DropdownMenu>
      <DropdownMenuTrigger>更多操作</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onSelect}>改名</DropdownMenuItem>
        <DropdownMenuItem disabled>已禁用</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe('kit/DropdownMenu', () => {
  it('is closed until the trigger opens it, then renders role="menu" with its items', async () => {
    renderMenu(vi.fn());
    expect(screen.queryByRole('menu')).toBeNull();
    openTrigger('更多操作');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('改名')).toBeTruthy();
  });

  it('calls onSelect and closes when an item is chosen', async () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);
    openTrigger('更多操作');
    await screen.findByRole('menu');
    fireEvent.click(screen.getByText('改名'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('does not call onSelect for a disabled item', async () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);
    openTrigger('更多操作');
    await screen.findByRole('menu');
    fireEvent.click(screen.getByText('已禁用'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    renderMenu(vi.fn());
    openTrigger('更多操作');
    await screen.findByRole('menu');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});
