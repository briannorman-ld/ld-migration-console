import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterOptions, SearchSelect } from './SearchSelect.tsx';

const projects = [
  { key: 'statsig-migrator', name: 'Statsig Migrator' },
  { key: 'njordan-ai-mig-test-dest', name: 'njordan-ai-mig-test-dest' },
  { key: 'ld-prereq-dashboard', name: 'LD Prereq Dashboard' },
  { key: 'statsig-migration', name: 'Statsig Migration' },
  { key: 'peregrine-outfitters', name: 'Peregrine Outfitters - Shopping Assistant Demo' },
];

describe('filterOptions', () => {
  it('matches every term against name or key, ignoring case', () => {
    expect(filterOptions(projects, '').map((p) => p.key)).toEqual(projects.map((p) => p.key));
    expect(filterOptions(projects, 'STATSIG').map((p) => p.key)).toEqual(['statsig-migrator', 'statsig-migration']);
    expect(filterOptions(projects, 'statsig migration').map((p) => p.key)).toEqual(['statsig-migration']);
    expect(filterOptions(projects, 'prereq-dash').map((p) => p.key)).toEqual(['ld-prereq-dashboard']);
    expect(filterOptions(projects, 'nothing here')).toEqual([]);
  });
});

describe('SearchSelect', () => {
  afterEach(cleanup);

  function setup(value = '') {
    const onChange = vi.fn();
    render(<SearchSelect id="p" value={value} options={projects} onChange={onChange} placeholder="Choose a project…" emptyText="No project matches" />);
    return { onChange, input: screen.getByRole('combobox') as HTMLInputElement };
  }

  it('shows the selected project as "name (key)" and opens the full list on focus', () => {
    const { input } = setup('statsig-migration');
    expect(input.value).toBe('Statsig Migration (statsig-migration)');
    expect(screen.getByRole('listbox', { hidden: true }).hidden).toBe(true);
    fireEvent.focus(input);
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'true', 'false']);
  });

  it('filters as you type and picks with the mouse', () => {
    const { input, onChange } = setup('statsig-migrator');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'prereq' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('1 of 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('option'));
    expect(onChange).toHaveBeenCalledWith('ld-prereq-dashboard');
    // Closed again; the input falls back to the (still-current) selection label.
    expect(screen.getByRole('listbox', { hidden: true }).hidden).toBe(true);
    expect(input.value).toBe('Statsig Migrator (statsig-migrator)');
  });

  it('navigates with the keyboard and reports no matches', () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: 'statsig' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('statsig-migration');

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No project matches')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('listbox', { hidden: true }).hidden).toBe(true);
    expect(input.value).toBe('');
  });
});
