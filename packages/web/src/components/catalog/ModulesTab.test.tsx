// @vitest-environment jsdom
import type { WorkspaceModuleWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { ModulesTab } from './ModulesTab.js';

afterEach(() => cleanup());

const KNOWLEDGE: WorkspaceModuleWire = {
  name: 'knowledge',
  versions: [{ version: 1, file: 'knowledge-v1.yaml', notes: 'first', breaking: false }],
  latestVersion: 1,
  installedVersion: null,
  status: 'not_installed',
};

describe('ModulesTab', () => {
  it('I-P1: a 409 ontology_namespace_conflict on install reads as its own sentence and keeps the code', async () => {
    const http: CapabilityCaller = {
      call: <T,>(name: string): Promise<T> => {
        if (name === 'list_workspace_modules') return Promise.resolve({ items: [KNOWLEDGE] } as T);
        return Promise.reject(
          new HttpError(
            'capability_error',
            'ontology type names already taken in this workspace (I-P1): ObjectType "Service" (ontology …)',
            'ontology_namespace_conflict',
          ),
        );
      },
    };
    render(
      <PermissionsProvider>
        <ModulesTab http={http} />
      </PermissionsProvider>,
    );

    fireEvent.click(await screen.findByTestId('catalog-module-action-knowledge'));

    const banner = await screen.findByTestId('catalog-module-error-knowledge');
    expect(banner.textContent).toContain('重名');
    expect(banner.textContent).toContain('ontology_namespace_conflict');
  });
});
