import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it, vi } from 'vitest';

import { store } from '../../../../store';
import type { WorkerThreadRef } from '../../utils/workerThreadRef';
import { WorkerThreadRefCard } from '../WorkerThreadRefCard';

function makeRef(overrides: Partial<WorkerThreadRef> = {}): WorkerThreadRef {
  return { threadId: 'wt-1', label: 'worker', ...overrides };
}

function renderCard(ref: WorkerThreadRef) {
  return render(
    <Provider store={store}>
      <WorkerThreadRefCard ref={ref} />
    </Provider>
  );
}

describe('WorkerThreadRefCard', () => {
  it('renders the label pill and open text', () => {
    renderCard(makeRef());
    expect(screen.getByText('worker')).toBeTruthy();
    expect(screen.getByText('Open worker thread')).toBeTruthy();
  });

  it('renders agentId in metadata when provided', () => {
    renderCard(makeRef({ agentId: 'researcher' }));
    expect(screen.getByText(/researcher/)).toBeTruthy();
  });

  it('renders iteration count with correct pluralisation', () => {
    const { unmount } = renderCard(makeRef({ iterations: 1 }));
    expect(screen.getByText(/1 turn/)).toBeTruthy();
    unmount();

    renderCard(makeRef({ iterations: 3 }));
    expect(screen.getByText(/3 turns/)).toBeTruthy();
  });

  it('renders elapsed milliseconds rounded', () => {
    renderCard(makeRef({ elapsedMs: 1234.7 }));
    // Math.round(1234.7) = 1235
    expect(screen.getByText(/1235ms/)).toBeTruthy();
  });

  it('renders combined metadata separated by ·', () => {
    renderCard(makeRef({ agentId: 'a1', iterations: 2, elapsedMs: 500 }));
    expect(screen.getByText('a1 · 2 turns · 500ms')).toBeTruthy();
  });

  it('dispatches setSelectedThread and loadThreadMessages on click — NOT setActiveThread', () => {
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    renderCard(makeRef({ threadId: 'wt-42' }));

    fireEvent.click(screen.getByRole('button'));

    // Collect the types of plain actions dispatched (thunks are functions)
    const dispatchedTypes = dispatchSpy.mock.calls
      .map(([action]) =>
        typeof action === 'object' && action !== null ? (action as { type?: string }).type : null
      )
      .filter(Boolean);

    // setSelectedThread must have been dispatched
    expect(dispatchedTypes).toContain('thread/setSelectedThread');

    // setActiveThread must NOT have been dispatched
    expect(dispatchedTypes).not.toContain('thread/setActiveThread');

    // loadThreadMessages is an async thunk — at least one thunk call must be present
    const thunkCalls = dispatchSpy.mock.calls.filter(([action]) => typeof action === 'function');
    expect(thunkCalls.length).toBeGreaterThan(0);

    dispatchSpy.mockRestore();
  });
});
