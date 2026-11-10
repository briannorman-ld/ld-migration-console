import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceDescriptor } from '@sslm/canonical';
import type { LdProject } from '@sslm/ld-client';

const listSources = vi.fn(async () => [{ id: 's1', workspaceId: 'w1', alias: 'web', label: 'Web', kind: 'console_api' as const, createdAt: '' }]);
const addSource = vi.fn(async (workspaceId: string, s: SourceDescriptor) => ({ ...s, workspaceId }));
vi.mock('../lib/store.ts', () => ({ store: { listSources: () => listSources(), addSource: (w: string, s: SourceDescriptor) => addSource(w, s) } }));

const setSecret = vi.fn();
vi.mock('../lib/secrets.ts', () => ({ secrets: { set: (...a: unknown[]) => setSecret(...a) } }));

const syncConsoleSource = vi.fn(async (..._a: unknown[]) => ({}));
const syncLdSource = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('../lib/sync.ts', () => ({
  syncConsoleSource: (...a: unknown[]) => syncConsoleSource(...a),
  syncLdSource: (...a: unknown[]) => syncLdSource(...a),
  uploadSpec: vi.fn(async () => ({})),
}));

const projects = [
  { _id: '1', key: 'shop', name: 'Shop' },
  { _id: '2', key: 'legacy-storefront', name: 'Legacy Storefront' },
] as LdProject[];
const listProjects = vi.fn(async () => projects);
vi.mock('@sslm/ld-client', async (orig) => ({
  ...(await orig<typeof import('@sslm/ld-client')>()),
  LdClient: class {
    listProjects = () => listProjects();
  },
}));

// Like StatSig: `GET /project` carries only the id, the name is a project setting.
const validateKey = vi.fn(async () => ({ id: '5ETXMP5xDW3P7AMyQ14tey' }));
const projectName = vi.fn(async (): Promise<string | undefined> => 'Web');
vi.mock('@sslm/statsig-client', async (orig) => ({
  ...(await orig<typeof import('@sslm/statsig-client')>()),
  StatsigConsoleClient: class {
    validateKey = () => validateKey();
    projectName = () => projectName();
  },
}));

const { AddSource } = await import('./AddSource.tsx');

describe('AddSource', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('asks for nothing the source can say itself', () => {
    render(<AddSource workspaceId="w1" onDone={() => undefined} />);
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    expect(screen.queryByLabelText(/Alias/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'LaunchDarkly project' }));
    expect(screen.queryByLabelText(/Project key/)).toBeNull();
    expect(screen.getByLabelText('Project to read')).toBeTruthy();
  });

  it('names a Console API source after the StatSig project and keeps the alias unique', async () => {
    const onDone = vi.fn();
    render(<AddSource workspaceId="w1" onDone={onDone} />);
    fireEvent.change(screen.getByLabelText(/Console API key/), { target: { value: 'console-abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(validateKey).toHaveBeenCalledTimes(1);
    expect(projectName).toHaveBeenCalledTimes(1);
    const source = addSource.mock.calls[0]![1];
    expect(source.label).toBe('Web');
    expect(source.alias).toBe('web-2');
    expect(source.kind).toBe('console_api');
    expect(setSecret).toHaveBeenCalledWith('statsig', source.id, 'console-abc', 'w1');
    expect(syncConsoleSource).toHaveBeenCalledTimes(1);
  });

  it('falls back to the project id when the key cannot read the project settings', async () => {
    projectName.mockResolvedValueOnce(undefined);
    const onDone = vi.fn();
    render(<AddSource workspaceId="w1" onDone={onDone} />);
    fireEvent.change(screen.getByLabelText(/Console API key/), { target: { value: 'console-abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const source = addSource.mock.calls[0]![1];
    expect(source.label).toBe('StatSig project 5ETXMP5xDW3P7AMyQ14tey');
    expect(source.alias).toBe('statsig-project-5etxmp5x');
  });

  it('does not save a Console API source whose key StatSig rejects', async () => {
    validateKey.mockRejectedValueOnce(new Error('StatSig rejected the API key (401).'));
    render(<AddSource workspaceId="w1" onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Console API key/), { target: { value: 'console-bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await screen.findByText('StatSig rejected the API key (401).');
    expect(addSource).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('lists the projects a LaunchDarkly token can read and names the source after the chosen one', async () => {
    const onDone = vi.fn();
    render(<AddSource workspaceId="w1" onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'LaunchDarkly project' }));
    const picker = screen.getByLabelText('Project to read') as HTMLInputElement;
    expect(picker.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Add source' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'api-reader-token' } });
    // Typing sends nothing; the token goes to the API only when the projects are listed.
    expect(listProjects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'List projects' }));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(picker.placeholder).toBe('Search 2 projects…');

    fireEvent.focus(picker);
    fireEvent.click(screen.getByRole('option', { name: /Legacy Storefront/ }));
    expect(picker.value).toContain('Legacy Storefront');

    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const source = addSource.mock.calls[0]![1];
    expect(source.kind).toBe('launchdarkly');
    expect(source.label).toBe('Legacy Storefront (LaunchDarkly)');
    expect(source.alias).toBe('legacy-storefront');
    expect(source.ld).toEqual({ instance: 'us', projectKey: 'legacy-storefront' });
    expect(setSecret).toHaveBeenCalledWith('ld_source', source.id, 'api-reader-token', 'w1');
    expect(syncLdSource).toHaveBeenCalledTimes(1);
  });

  it('picks the project itself when the token reads only one', async () => {
    listProjects.mockResolvedValueOnce(projects.filter((p) => p.key === 'legacy-storefront'));
    render(<AddSource workspaceId="w1" onDone={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'LaunchDarkly project' }));
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'api-reader-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'List projects' }));
    const picker = screen.getByLabelText('Project to read') as HTMLInputElement;
    await waitFor(() => expect(picker.value).toContain('Legacy Storefront'));
    expect(screen.getByRole('button', { name: 'Add source' })).toHaveProperty('disabled', false);
  });

  it('forgets the listing when the instance changes, so the token is not re-sent elsewhere by itself', async () => {
    render(<AddSource workspaceId="w1" onDone={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'LaunchDarkly project' }));
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'api-reader-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'List projects' }));
    const picker = screen.getByLabelText('Project to read') as HTMLInputElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Instance'), { target: { value: 'eu' } });
    expect(picker.disabled).toBe(true);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/EU instance/)).toBeTruthy();
  });

  it('shows why a token could not list projects', async () => {
    listProjects.mockRejectedValueOnce(new Error('LaunchDarkly rejected the token (401).'));
    render(<AddSource workspaceId="w1" onDone={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'LaunchDarkly project' }));
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'api-bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'List projects' }));
    await screen.findByText('LaunchDarkly rejected the token (401).');
    expect(screen.getByRole('button', { name: 'Add source' })).toHaveProperty('disabled', true);
  });
});
