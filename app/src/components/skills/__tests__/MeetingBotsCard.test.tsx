import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MeetingBotsCard from '../MeetingBotsCard';

const joinMock = vi.fn();

vi.mock('../../../services/meetCallService', async () => {
  const actual = await vi.importActual<typeof import('../../../services/meetCallService')>(
    '../../../services/meetCallService'
  );
  return {
    ...actual,
    // Flow A: the modal submit calls joinMeetCall (CEF webview), not the
    // Flow B backend joinMeetingViaMascotBot. Switched in the
    // mascot-meet-flowA revival commits — kept the mock variable name
    // `joinMock` to keep the diff focused on the call site swap.
    joinMeetCall: (...args: unknown[]) => joinMock(...args),
  };
});

describe('MeetingBotsCard', () => {
  beforeEach(() => joinMock.mockReset());
  afterEach(() => cleanup());

  it('renders the banner and hides the modal by default', () => {
    render(<MeetingBotsCard />);
    expect(screen.getByTestId('meeting-bots-banner')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the modal when the banner is clicked', () => {
    render(<MeetingBotsCard />);
    fireEvent.click(screen.getByTestId('meeting-bots-banner'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the modal on Cancel', () => {
    render(<MeetingBotsCard />);
    fireEvent.click(screen.getByTestId('meeting-bots-banner'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the modal on Escape', () => {
    render(<MeetingBotsCard />);
    fireEvent.click(screen.getByTestId('meeting-bots-banner'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('submits to joinMeetCall and fires a success toast', async () => {
    joinMock.mockResolvedValueOnce({ requestId: 'req-1' });
    const onToast = vi.fn();
    render(<MeetingBotsCard onToast={onToast} />);

    fireEvent.click(screen.getByTestId('meeting-bots-banner'));
    fireEvent.change(screen.getByLabelText(/meeting link/i), {
      target: { value: 'https://meet.google.com/abc-defg-hij' },
    });
    // Owner display name is now required — the wake-word gate refuses
    // every caption when this is empty (privacy lock), so the submit
    // button stays disabled and the test would hang on form submit
    // without typing a value here.
    fireEvent.change(screen.getByLabelText(/your name in the call/i), {
      target: { value: 'Alice' },
    });
    const form = screen.getByRole('dialog').querySelector('form')!;
    fireEvent.submit(form);

    // Flow A's joinMeetCall takes { meetUrl, displayName, ownerDisplayName }.
    // Assert on the owner name (the new privacy-lock contract) and meetUrl;
    // the bot displayName is a UI-supplied default and not contract-load-
    // bearing for this assertion.
    await vi.waitFor(() => {
      expect(joinMock).toHaveBeenCalledWith(
        expect.objectContaining({
          meetUrl: 'https://meet.google.com/abc-defg-hij',
          ownerDisplayName: 'Alice',
        })
      );
    });
    await vi.waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: expect.stringMatching(/joining/i) })
      );
    });
    // Modal closes on success
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // Flow A's joinMeetCall has no capacity-gated concept — any throw maps
  // to the single "could not start" toast + inline alert with the error
  // message. Two error cases collapsed into one in the Flow A model.
  it('surfaces a join error inline + as an error toast', async () => {
    joinMock.mockRejectedValueOnce(new Error('Bad URL'));
    const onToast = vi.fn();
    render(<MeetingBotsCard onToast={onToast} />);

    fireEvent.click(screen.getByTestId('meeting-bots-banner'));
    fireEvent.change(screen.getByLabelText(/meeting link/i), {
      target: { value: 'https://meet.google.com/x' },
    });
    fireEvent.change(screen.getByLabelText(/your name in the call/i), {
      target: { value: 'Alice' },
    });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);

    await vi.waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: expect.stringMatching(/not start/i) })
      );
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Bad URL');
  });

  it('disables the submit when the active platform is coming-soon', () => {
    render(<MeetingBotsCard />);
    fireEvent.click(screen.getByTestId('meeting-bots-banner'));
    // Pick Zoom (coming soon)
    fireEvent.click(screen.getByRole('button', { name: /Zoom/ }));
    const submit = screen.getByRole('button', { name: /coming soon/i });
    expect(submit).toBeDisabled();
  });
});
