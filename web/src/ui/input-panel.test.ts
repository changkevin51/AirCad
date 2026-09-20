import { describe, expect, it } from 'vitest';
import { buildInputPanelState } from './input-panel';

describe('InputPanel state', () => {
  it('copies a tracker config for the depth camera', () => {
    const state = buildInputPanelState(
      { source: 'oak', cameraIndex: 0, target: 'color', colorPreset: 'red', colorTolerance: 1.5 },
      { calibrated: true, depthaiInstalled: true, status: 'Tracking' },
    );
    expect(state.source).toBe('oak');
    expect(state.target).toBe('color');
    expect(state.scale).toBe(1);
    expect(state.calibrated).toBe(true);
    expect(state.colorPreset).toBe('red');
  });
});
