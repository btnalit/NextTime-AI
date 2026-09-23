// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.js';

afterEach(cleanup);

describe('kit/Table', () => {
  it('renders a native table with the expected roles', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>e2e-test-gate</TableCell>
            <TableCell>healthy</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual([
      '名称',
      '状态',
    ]);
    const dataRow = screen.getByText('e2e-test-gate').closest('tr');
    expect(dataRow?.querySelectorAll('td').length).toBe(2);
  });

  it('applies the token-backed shell classes', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('table').className).toContain('border-collapse');
  });
});
