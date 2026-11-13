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
const syncPostHogSource = vi.fn(async (..._a: unknown[]) => ({}));
const uploadPostHogPayload = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('../lib/sync.ts', () => ({
  syncConsoleSource: (...a: unknown[]) => syncConsoleSource(...a),
  syncLdSource: (...a: unknown[]) => syncLdSource(...a),
  syncPostHogSource: (...a: unknown[]) => syncPostHogSource(...a),
  uploadPostHogPayload: (...a: unknown[]) => uploadPostHogPayload(...a),
  uploadSpec: vi.fn(async () => ({})),
}));

const phProjects = [
  { id: '4242', name: 'Acme Hog', organizationId: 'org-1', organizationName: 'Acme' },
  { id: '7', name: 'Sandbox', organizationId: 'org-2', organizationName: 'Acme Labs' },
];
const listReadableProjects = vi.fn(async () => phProjects);
vi.mock('@sslm/adapters', async (orig) => ({
  ...(await orig<typeof import('@sslm/adapters')>()),
  PostHogClient: class {
    listReadableProjects = () => listReadableProjects();
  },
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
const { setFlagOverride } = await import('../lib/flags.ts');

describe('AddSource', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setFlagOverride('posthogSource', undefined);
  });

  it('offers no PostHog source while the posthog-source flag is off', () => {
    render(<AddSource workspaceId="w1" onDone={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'PostHog project' })).toBeNull();
    expect(screen.getByRole('button', { name: 'LaunchDarkly project' })).toBeTruthy();
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

  it('forgets a key pasted for one provider when another tile is chosen', async () => {
    setFlagOverride('posthogSource', true);
    render(<AddSource workspaceId="w1" onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'PostHog project' }));
    fireEvent.change(screen.getByLabelText(/Personal API key/), { target: { value: 'phx_read_only_key' } });
    fireEvent.click(screen.getByRole('button', { name: 'List projects' }));
    await waitFor(() => expect(listReadableProjects).toHaveBeenCalledTimes(1));

    // The LaunchDarkly tile starts empty: the PostHog key is gone, nothing is listed, and the
    // list button is disabled, so the key cannot reach LaunchDarkly's API.
    fireEvent.click(screen.getByRole('button', { name: 'LaunchDarkly project' }));
    expect((screen.getByLabelText(/Access token/) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'List projects' })).toHaveProperty('disabled', true);
    expect((screen.getByLabelText('Project to read') as HTMLInputElement).disabled).toBe(true);
    expect(listProjects).not.toHaveBeenCalled();

    // Switching between the two PostHog inputs keeps the key: same provider.
    fireEvent.click(screen.getByRole('button', { name: 'PostHog project' }));
    fireEvent.change(screen.getByLabelText(/Personal API key/), { target: { value: 'phx_read_only_key' } });
    fireEvent.click(screen.getByLabelText('Upload a local-evaluation payload instead'));
    fireEvent.click(screen.getByLabelText('Read the project with a personal API key'));
    expect((screen.getByLabelText(/Personal API key/) as HTMLInputElement).value).toBe('phx_read_only_key');
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

  it('lists the projects a PostHog key can read and names the source after the chosen one', async () => {
    setFlagOverride('posthogSource', true);
    const onDone = vi.fn();
    render(<AddSource workspaceId="w1" onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'PostHog project' }));
    const picker = screen.getByLabelText('Project to read') as HTMLInputElement;
    expect(picker.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Add source' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/Personal API key/), { target: { value: 'phx_read_only_key' } });
    // Typing sends nothing; the key goes to the API only when the projects are listed.
    expect(listReadableProjects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'List projects' }));
    await waitFor(() => expect(listReadableProjects).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(picker.placeholder).toBe('Search 2 projects…');

    fireEvent.focus(picker);
    fireEvent.click(screen.getByRole('option', { name: /Acme Hog \(Acme\)/ }));
    expect(picker.value).toContain('Acme Hog');

    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const source = addSource.mock.calls[0]![1];
    expect(source.kind).toBe('posthog');
    expect(source.label).toBe('Acme Hog (PostHog)');
    expect(source.alias).toBe('acme-hog');
    expect(source.posthog).toEqual({ region: 'us', projectId: '4242', projectName: 'Acme Hog' });
    expect(setSecret).toHaveBeenCalledWith('ph_source', source.id, 'phx_read_only_key', 'w1');
    expect(syncPostHogSource).toHaveBeenCalledTimes(1);
    expect(uploadPostHogPayload).not.toHaveBeenCalled();
  });

  it('adds a PostHog payload source from an uploaded flags definitions file', async () => {
    setFlagOverride('posthogSource', true);
    const onDone = vi.fn();
    render(<AddSource workspaceId="w1" onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'PostHog project' }));
    fireEvent.click(screen.getByLabelText('Upload a local-evaluation payload instead'));
    expect(screen.queryByLabelText('Project to read')).toBeNull();
    const file = new File(['{"flags":[]}'], 'posthog-flags.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText(/Flags definitions payload/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const source = addSource.mock.calls[0]![1];
    expect(source.kind).toBe('posthog_payload');
    expect(source.label).toBe('posthog-flags (PostHog payload)');
    expect(source.alias).toBe('posthog');
    expect(setSecret).not.toHaveBeenCalled();
    expect(uploadPostHogPayload).toHaveBeenCalledWith('w1', source, file);
    expect(syncPostHogSource).not.toHaveBeenCalled();
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
