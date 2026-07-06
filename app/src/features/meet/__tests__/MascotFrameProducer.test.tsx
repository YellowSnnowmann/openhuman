import { listen } from '@tauri-apps/api/event';
import { act, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../test/test-utils';
import { MascotFrameProducer, sampleCanvasPixels } from '../MascotFrameProducer';

// @tauri-apps/api/event is mocked in setup.ts (listen → vi.fn()). Here we
// override it per-test to capture the event handlers so we can drive a fake
// `meet-video:bus-started` and assert how many mascot hosts mount.
type Listener = (event: { payload: unknown }) => void;

// The producer renders ManifestRiveMascot / RiveMascot (WebGL). Mock both leaf
// renderers to a plain <canvas> host so the frame's slot structure is
// assertable without the Rive runtime. Each records the face it was asked to
// render via a data attribute.
vi.mock('../../human/Mascot', async () => {
  const actual = await vi.importActual<typeof import('../../human/Mascot')>('../../human/Mascot');
  const stub = (props: { face?: string }) =>
    createElement('canvas', { 'data-face': props.face, width: 200, height: 200 });
  return { ...actual, ManifestRiveMascot: stub, RiveMascot: stub };
});

// Keep the manifest resolution deterministic + synchronous — the host tree
// mounts regardless (MascotStage falls back to RiveMascot when entry is null),
// so we just avoid a real network fetch.
vi.mock('../../human/Mascot/manifest/useMascotManifest', () => ({
  useMascotManifest: () => ({ manifest: null, entry: null, loading: false, error: null }),
}));

vi.mock('../../human/Mascot/manifest/manifestService', () => ({ findMascot: () => null }));

/** Install the browser globals the ProducerSession effect touches. */
function installBrowserStubs() {
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((e: unknown) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
  );
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1;
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      send() {}
      close() {}
    }
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return null;
      }
    }
  );
  if (!('createObjectURL' in URL)) {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
  }
  if (!('revokeObjectURL' in URL)) {
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
  // jsdom does not implement HTMLMediaElement.play(); the silent keep-alive
  // audio the producer creates calls `.play().catch(...)`, so give it a
  // resolving stub.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
}

/**
 * Wire the mocked `listen` so each event name captures its handler. Returns a
 * fn to fire a fake payload for a given event.
 */
function captureListeners() {
  const handlers = new Map<string, Listener>();
  vi.mocked(listen).mockImplementation((event: string, handler: unknown) => {
    handlers.set(event, handler as Listener);
    return Promise.resolve(vi.fn());
  });
  return {
    fire(event: string, payload: unknown) {
      const h = handlers.get(event);
      if (!h) throw new Error(`no listener registered for ${event}`);
      h({ payload });
    },
  };
}

describe('MascotFrameProducer', () => {
  beforeEach(() => {
    installBrowserStubs();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Restore the setup.ts default so other files that rely on the shared
    // `listen` mock (resolving to an unlisten fn) are unaffected.
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(vi.fn());
  });

  it('renders nothing when no bus session is active', () => {
    const { container } = renderWithProviders(<MascotFrameProducer />);
    expect(container.firstChild).toBeNull();
  });

  it('mounts and unmounts without throwing', () => {
    expect(() => {
      const { unmount } = renderWithProviders(<MascotFrameProducer />);
      unmount();
    }).not.toThrow();
  });

  it('renders ONE mascot host for a single mascot', async () => {
    const bus = captureListeners();
    const { container } = renderWithProviders(<MascotFrameProducer />, {
      preloadedState: {
        mascot: {
          color: 'yellow',
          voiceId: null,
          voiceGender: 'male',
          voiceUseLocaleDefault: false,
          selectedMascotId: 'tiny-mascot',
          secondaryMascotId: null,
          mascotVoices: {},
          customMascotGifUrl: null,
          customPrimaryColor: '#F7D145',
          customSecondaryColor: '#B23C05',
        },
      },
    });

    await act(async () => {
      bus.fire('meet-video:bus-started', { requestId: 'r1', port: 55555 });
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-mascot-slot]').length).toBe(1);
    });
    expect(container.querySelector('[data-mascot-slot="primary"]')).not.toBeNull();
    expect(container.querySelector('[data-mascot-slot="secondary"]')).toBeNull();
  });

  it('renders TWO mascot hosts for two distinct mascots', async () => {
    const bus = captureListeners();
    const { container } = renderWithProviders(<MascotFrameProducer />, {
      preloadedState: {
        mascot: {
          color: 'yellow',
          voiceId: null,
          voiceGender: 'male',
          voiceUseLocaleDefault: false,
          selectedMascotId: 'tiny-mascot',
          secondaryMascotId: 'toshi',
          mascotVoices: {},
          customMascotGifUrl: null,
          customPrimaryColor: '#F7D145',
          customSecondaryColor: '#B23C05',
        },
      },
    });

    await act(async () => {
      bus.fire('meet-video:bus-started', { requestId: 'r2', port: 55556 });
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-mascot-slot]').length).toBe(2);
    });
    expect(container.querySelector('[data-mascot-slot="primary"]')).not.toBeNull();
    expect(container.querySelector('[data-mascot-slot="secondary"]')).not.toBeNull();
  });
});

// sampleCanvasPixels is still exported from the producer (re-exported from the
// compositor for back-compat); a light smoke check keeps that surface covered
// here. Full assertions live in mascotFrameCompositor.test.ts.
describe('sampleCanvasPixels (re-export)', () => {
  it('is re-exported and returns pixel stats', () => {
    const mockCtx = {
      getImageData: vi.fn().mockReturnValue({ data: [128, 128, 128, 255] }),
    } as unknown as OffscreenCanvasRenderingContext2D;
    expect(sampleCanvasPixels(mockCtx, 320, 240)).toMatchObject({ avgLuma: 128, sampleCount: 35 });
  });
});
