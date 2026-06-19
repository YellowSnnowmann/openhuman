import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/test-utils';
import type { FeedbackItem } from '../../types/feedback';
import FeedbackItemRow from './FeedbackItemRow';

const mockGetFeedback = vi.fn();
vi.mock('../../services/api/feedbackApi', () => ({
  feedbackApi: {
    voteFeedback: vi.fn(),
    updateStatus: vi.fn(),
    addComment: vi.fn(),
    getFeedback: (...args: unknown[]) => mockGetFeedback(...args),
  },
}));

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 'f1',
    type: 'bug',
    title: 'Crash on launch',
    body: 'It crashes',
    status: 'open',
    createdBy: 'u1',
    createdByName: null,
    upvoteCount: 0,
    downvoteCount: 0,
    score: 0,
    rankScore: 0,
    commentCount: 2,
    github: null,
    myVote: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('<FeedbackItemRow />', () => {
  it('renders the title, type and status', () => {
    render(<FeedbackItemRow item={makeItem()} isAdmin={false} onChange={() => {}} />);
    expect(screen.getByText('Crash on launch')).toBeInTheDocument();
    expect(screen.getByText('Bug')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('hides the admin status control for non-admins', () => {
    render(<FeedbackItemRow item={makeItem()} isAdmin={false} onChange={() => {}} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('shows the admin status control for admins', () => {
    render(<FeedbackItemRow item={makeItem()} isAdmin={true} onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('shows the author display name when present', () => {
    render(
      <FeedbackItemRow
        item={makeItem({ createdByName: 'Ada' })}
        isAdmin={false}
        onChange={() => {}}
      />
    );
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  it('falls back to a handle when the author has no name', () => {
    render(
      <FeedbackItemRow
        item={makeItem({ createdBy: 'abcdef123456', createdByName: null })}
        isAdmin={false}
        onChange={() => {}}
      />
    );
    expect(screen.getByText('@3456')).toBeInTheDocument();
  });

  it('expands to reveal the comment thread on "Show more"', async () => {
    mockGetFeedback.mockResolvedValueOnce({ feedback: makeItem(), comments: [] });
    renderWithProviders(<FeedbackItemRow item={makeItem()} isAdmin={false} onChange={() => {}} />);

    expect(screen.queryByText('No comments yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show more'));
    expect(await screen.findByText('No comments yet.')).toBeInTheDocument();
    expect(screen.getByText('Show less')).toBeInTheDocument();
  });

  it('links to the GitHub issue when one exists', () => {
    render(
      <FeedbackItemRow
        item={makeItem({ github: { issueNumber: 7, issueUrl: 'https://gh/issues/7' } })}
        isAdmin={false}
        onChange={() => {}}
      />
    );
    expect(screen.getByText('View issue').closest('a')).toHaveAttribute(
      'href',
      'https://gh/issues/7'
    );
  });
});
