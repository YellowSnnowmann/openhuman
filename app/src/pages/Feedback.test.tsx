import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../test/test-utils';
import type { FeedbackItem } from '../types/feedback';
import Feedback from './Feedback';

const mockList = vi.fn();
const mockVote = vi.fn();
const mockSubmit = vi.fn();
const mockUpdateStatus = vi.fn();

vi.mock('../services/api/feedbackApi', () => ({
  feedbackApi: {
    listFeedback: (...args: unknown[]) => mockList(...args),
    voteFeedback: (...args: unknown[]) => mockVote(...args),
    submitFeedback: (...args: unknown[]) => mockSubmit(...args),
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
  },
}));

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 'f1',
    type: 'feature',
    title: 'Add dark mode',
    body: 'Please add a dark theme',
    status: 'open',
    createdBy: 'u1',
    createdByName: null,
    upvoteCount: 5,
    downvoteCount: 0,
    score: 5,
    rankScore: 0,
    commentCount: 0,
    github: null,
    myVote: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('<Feedback />', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockVote.mockReset();
    mockSubmit.mockReset();
    mockUpdateStatus.mockReset();
  });

  it('loads and renders feedback items from the board', async () => {
    mockList.mockResolvedValueOnce({ items: [makeItem()], total: 1, page: 1, limit: 20 });

    renderWithProviders(<Feedback />);

    expect(await screen.findByText('Add dark mode')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'hot', page: 1, limit: 20 })
    );
    // The submit form is always present.
    expect(screen.getByText('Share feedback')).toBeInTheDocument();
  });

  it('shows the empty state when there is no feedback', async () => {
    mockList.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });

    renderWithProviders(<Feedback />);

    expect(
      await screen.findByText('No feedback yet. Be the first to share an idea.')
    ).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));

    renderWithProviders(<Feedback />);

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
