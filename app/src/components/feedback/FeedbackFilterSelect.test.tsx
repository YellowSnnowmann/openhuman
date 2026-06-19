import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import FeedbackFilterSelect from './FeedbackFilterSelect';

const OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'feature', label: 'Feature' },
  { value: 'bug', label: 'Bug' },
];

describe('<FeedbackFilterSelect />', () => {
  it('shows the current selection on the trigger', () => {
    render(
      <FeedbackFilterSelect
        value="feature"
        options={OPTIONS}
        onChange={() => {}}
        ariaLabel="Type"
      />
    );
    expect(screen.getByRole('button', { name: 'Type' })).toHaveTextContent('Feature');
  });

  it('opens the menu and selects an option', () => {
    const onChange = vi.fn();
    render(
      <FeedbackFilterSelect value="all" options={OPTIONS} onChange={onChange} ariaLabel="Type" />
    );

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    expect(screen.getByRole('option', { name: 'Bug' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Bug' }));
    expect(onChange).toHaveBeenCalledWith('bug');
    // Menu closes after selection.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(
      <FeedbackFilterSelect value="all" options={OPTIONS} onChange={() => {}} ariaLabel="Type" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
