import { describe, expect, it } from 'vitest';
import { buildInputPanelState, inputStatus, type InputStatusContext } from './input-panel';
import type { TrackerConfigJson } from '../input/tracker-client';

const base: InputStatusContext = {
  connection: 'open',
  camera: 'ready',
  cameraMessage: null,
  source: 'webcam',
  tracking: 'none',
};

describe('inputStatus precedence', () => {
  it('reports a dead socket before anything else', () => {
    expect(inputStatus({ ...base, connection: 'closed', camera: 'error', cameraMessage: 'x' }).text).toBe(
      'Tracker offline — reconnecting…',
    );
    expect(inputStatus({ ...base, connection: 'connecting' }).retry).toBe(false);
  });

  it('reports camera errors with a retry affordance', () => {
    const status = inputStatus({ ...base, camera: 'error', cameraMessage: 'device lost' });
    expect(status).toEqual({ text: 'Camera unavailable: device lost', tone: 'error', retry: true });
  });

  it('treats an intentional mouse source as neutral, never an error', () => {
    const status = inputStatus({ ...base, source: 'none', camera: 'disabled' });
    expect(status).toEqual({ text: 'Mouse input active', tone: 'neutral', retry: false });
  });

  it('camera starting outranks tracking states', () => {
    expect(inputStatus({ ...base, camera: 'starting', tracking: 'hand' }).text).toBe('Camera starting…');
  });

  it('collecting shows calibration progress on the depth source', () => {
    const status = inputStatus({
      ...base,
      source: 'oak',
      spatialState: 'origin',
      collecting: true,
      calibrationSamples: 3,
      calibrationGoal: 8,
    });
    expect(status.text).toBe('Hold still… 3/8');
  });

  it('depth states map to origin, tracking, paused, lost, acquiring', () => {
    const oak = { ...base, source: 'oak' as const };
    expect(inputStatus({ ...oak, spatialState: 'origin' }).text).toBe('Origin needed — press Set origin');
    expect(inputStatus({ ...oak, spatialState: 'tracked' })).toMatchObject({ text: 'Tracking', tone: 'ok' });
    expect(inputStatus({ ...oak, spatialState: 'held', spatialReason: 'occluded' }).text).toBe('Paused (occluded)');
    expect(inputStatus({ ...oak, spatialState: 'held' }).text).toBe('Paused');
    expect(inputStatus({ ...oak, spatialState: 'lost' }).tone).toBe('warn');
    expect(inputStatus({ ...oak, spatialState: 'acquiring' }).text).toBe('Acquiring…');
  });

  it('webcam tracking states map to tracking, lost, mouse, show-a-hand', () => {
    expect(inputStatus({ ...base, tracking: 'hand' })).toMatchObject({ text: 'Tracking', tone: 'ok' });
    expect(inputStatus({ ...base, tracking: 'lost' }).tone).toBe('warn');
    expect(inputStatus({ ...base, tracking: 'mouse' }).text).toBe('Camera ready — mouse active');
    expect(inputStatus({ ...base, tracking: 'none' }).text).toBe('Show a hand to track');
  });
});

describe('buildInputPanelState', () => {
  const config: TrackerConfigJson = {
    source: 'oak',
    cameraIndex: 0,
    target: 'color',
    colorPreset: 'blue',
    colorTolerance: 1.4,
  };

  it('copies the config and defaults extras', () => {
    const state = buildInputPanelState(config);
    expect(state.source).toBe('oak');
    expect(state.target).toBe('color');
    expect(state.colorPreset).toBe('blue');
    expect(state.colorTolerance).toBe(1.4);
    expect(state.applying).toBe(false);
    expect(state.connection).toBe('closed');
  });
});
