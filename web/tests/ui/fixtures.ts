import { test as base, type WebSocketRoute } from '@playwright/test';
import type {
  CameraState,
  KeycapMessage,
  SpatialMessage,
  SpatialState,
  StatusMessage,
  TrackerConfigJson,
  TrackerSnapshot,
} from '../../src/input/tracker-client';

/**
 * Tracker status payload matching the shape consumed by TrackerClient
 * (web/src/input/tracker-client.ts): GET /api/tracker returns this snapshot;
 * POST /api/tracker accepts { expectedStreamId, config?, retry? }.
 * Override per test file or test with test.use({ trackerSnapshot: {...} }).
 */
export const trackerStatus: TrackerSnapshot = {
  ok: true,
  config: {
    source: 'none',
    cameraIndex: 0,
    target: 'keycap',
    colorPreset: 'green',
    colorTolerance: 0.18,
  },
  camera: 'disabled',
  message: 'No tracking camera configured.',
  streamId: 'ui-test-stream',
  sourceRunId: 'ui-test-run',
  capabilities: {
    sources: ['webcam', 'oak', 'none'],
    depthTargets: ['keycap'],
    depthaiInstalled: false,
  },
  serverTimeMs: 0,
};

/** Snapshot for a configured webcam source. */
export const webcamSnapshot: TrackerSnapshot = {
  ...trackerStatus,
  config: { ...trackerStatus.config, source: 'webcam' },
  camera: 'starting',
  message: '',
};

/** Snapshot for a configured depth camera. */
export const oakSnapshot = (depthaiInstalled = true): TrackerSnapshot => ({
  ...trackerStatus,
  config: { ...trackerStatus.config, source: 'oak' },
  camera: 'ready',
  message: '',
  capabilities: { ...trackerStatus.capabilities, depthaiInstalled },
});

export const statusMessage = (camera: CameraState, message = ''): StatusMessage => ({
  type: 'status',
  camera,
  message,
});

/** One green keycap mid-frame; tracking reports 'keycap' while frames arrive. */
export const keycapMessage = (t: number): KeycapMessage => ({
  type: 'keycap',
  t,
  frame: { w: 640, h: 480 },
  keycaps: [
    {
      id: 1,
      center: [320, 240],
      confidence: 1,

    },
  ],
});

/** A v2 spatial sample; 'tracked' requires fresh + cameraMm + sample/age times. */
export const spatialMessage = (
  streamId: string,
  sourceRunId: string,
  seq: number,
  t: number,
  state: SpatialState = 'tracked',
): SpatialMessage => ({
  type: 'spatial',
  v: 2,
  streamId,
  sourceRunId,
  seq,
  t,
  sampleTimeMs: state === 'tracked' || state === 'held' ? t : null,
  ageMs: state === 'tracked' || state === 'held' ? 0 : null,
  target: 'keycap',
  trackingEpoch: 1,
  frame: { w: 640, h: 480, mirrored: true },
  pixel: state === 'tracked' || state === 'held' ? [320, 240] : null,
  cameraMm: state === 'tracked' || state === 'held' ? [0, 0, 500] : null,
  state,
  fresh: state === 'tracked',
  reason: null,
  quality: { validPixels: 100, roiCount: 1, spreadMm: null, pairSkewMs: null },
});

type TrackerFrame = StatusMessage | KeycapMessage | SpatialMessage | Record<string, unknown>;

export interface TrackerFixture {
  /** Push a server-to-client JSON frame through the captured socket route. */
  send(message: TrackerFrame): void;
  /** Close the socket and refuse reconnects so the UI stays "Tracker offline". */
  close(): void;
  /** Make the next POST /api/tracker fail with the given status and error. */
  failNextPost(status: number, error: string): void;
}

export const test = base.extend<{ trackerSnapshot: TrackerSnapshot; tracker: TrackerFixture; fakeSpeech: boolean }>({
  trackerSnapshot: [trackerStatus, { option: true }],
  fakeSpeech: [false, { option: true }],
  // Auto: routes must exist before the page navigates, even when a test never
  // touches the tracker fixture directly.
  tracker: [
    async ({ page, trackerSnapshot, fakeSpeech }, use) => {
      if (fakeSpeech) {
        await page.addInitScript(() => {
          type SpeechResult = { isFinal: boolean; length: number; [index: number]: { transcript: string } };
          class FakeSpeechRecognition {
            continuous = false;
            interimResults = false;
            maxAlternatives = 1;
            lang = '';
            onresult: ((event: { resultIndex: number; results: SpeechResult[] }) => void) | null = null;
            onerror: ((event: { error: string }) => void) | null = null;
            onend: (() => void) | null = null;
            start(): void {
              (window as unknown as { __aircadSpeech: FakeSpeechRecognition | null }).__aircadSpeech = this;
            }
            stop(): void {
              this.onend?.();
            }
            abort(): void {
              this.onerror?.({ error: 'aborted' });
              this.onend?.();
            }
            emit(isFinal: boolean, transcript: string): void {
              const result = { isFinal, length: 1, 0: { transcript } } as SpeechResult;
              this.onresult?.({ resultIndex: 0, results: [result] });
            }
          }
          const w = window as unknown as {
            SpeechRecognition: typeof FakeSpeechRecognition;
            webkitSpeechRecognition: typeof FakeSpeechRecognition;
            __aircadSpeech: FakeSpeechRecognition | null;
          };
          w.SpeechRecognition = FakeSpeechRecognition;
          w.webkitSpeechRecognition = FakeSpeechRecognition;
          w.__aircadSpeech = null;
        });
      }
      let socket: WebSocketRoute | null = null;
      let refuseConnections = false;
      let postFailure: { status: number; error: string } | null = null;

      await page.route('**/api/tracker', async (route) => {
        const request = route.request();
        if (request.method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ...trackerSnapshot, serverTimeMs: Date.now() }),
          });
          return;
        }
        if (postFailure) {
          const failure = postFailure;
          postFailure = null;
          await route.fulfill({
            status: failure.status,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: failure.error }),
          });
          return;
        }
        // A successful POST echoes the requested config back in the snapshot.
        const posted = JSON.parse(request.postData() ?? '{}') as { config?: TrackerConfigJson; retry?: boolean };
        const config = posted.config ?? trackerSnapshot.config;
        const camera = config.source === 'none' ? 'disabled' : trackerSnapshot.camera === 'disabled' ? 'starting' : trackerSnapshot.camera;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...trackerSnapshot, ok: true, config, camera, serverTimeMs: Date.now() }),
        });
      });

      await page.routeWebSocket('**/ws', (ws) => {
        if (refuseConnections) {
          ws.close();
          return;
        }
        socket = ws;
        ws.onMessage(() => {
          // The client only subscribes; frames arrive via tracker.send().
        });
        ws.onClose(() => {
          if (socket === ws) socket = null;
        });
      });

      await use({
        send(message) {
          if (!socket) throw new Error('tracker socket is not connected');
          socket.send(JSON.stringify(message));
        },
        close() {
          refuseConnections = true;
          socket?.close();
        },
        failNextPost(status, error) {
          postFailure = { status, error };
        },
      });
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
