import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../test/test-utils';
import { MascotFrameProducer } from '../MascotFrameProducer';

// @tauri-apps/api/event is already mocked in setup.ts (listen → vi.fn())

describe('MascotFrameProducer', () => {
  afterEach(() => cleanup());

  it('renders nothing when no bus session is active', () => {
    const { container } = renderWithProviders(<MascotFrameProducer />);
    // Component returns null until a meet-video:bus-started Tauri event fires
    expect(container.firstChild).toBeNull();
  });

  it('mounts and unmounts without throwing', () => {
    expect(() => {
      const { unmount } = renderWithProviders(<MascotFrameProducer />);
      unmount();
    }).not.toThrow();
  });
});
