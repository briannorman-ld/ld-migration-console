import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNTAGGED } from '../lib/tags.ts';
import { TagFilter } from './TagFilter.tsx';

const options = [
  { tag: 'checkout', count: 12 },
  { tag: 'mobile', count: 4 },
  { tag: 'search', count: 2 },
  { tag: UNTAGGED, count: 7 },
];

describe('TagFilter', () => {
  afterEach(cleanup);

  it('renders nothing when no item has a tag', () => {
    const { container } = render(<TagFilter options={[]} chosen={new Set()} onChange={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('opens a panel of tags with counts, toggles a tag on and off, and offers "No tag" last', () => {
    const onChange = vi.fn();
    render(<TagFilter options={options} chosen={new Set(['mobile'])} onChange={onChange} noun="gates" />);
    const button = screen.getByRole('button', { name: 'Filter by tag' });
    expect(button.textContent).toContain('1');
    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: 'Tags' });
    const boxes = within(panel).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['checkout (12)', 'mobile (4)', 'search (2)', 'No tag (7)']);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(boxes[0]!);
    expect([...onChange.mock.calls[0]![0]].sort()).toEqual(['checkout', 'mobile']);
    fireEvent.click(boxes[1]!);
    expect([...onChange.mock.calls[1]![0]]).toEqual([]);
  });

  it('narrows the list by typing (keeping "No tag" out of a search) and clears every choice at once', () => {
    const onChange = vi.fn();
    render(<TagFilter options={options} chosen={new Set(['mobile', 'search'])} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by tag' }));
    fireEvent.change(screen.getByLabelText('Find a tag'), { target: { value: 'SEA' } });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith(new Set());
  });

  it('closes on Escape', () => {
    render(<TagFilter options={options} chosen={new Set()} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter by tag' }));
    expect(screen.getByRole('dialog', { name: 'Tags' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Tags' })).toBeNull();
  });
});
