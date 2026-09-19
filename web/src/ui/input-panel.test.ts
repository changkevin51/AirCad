import { describe, expect, it } from 'vitest';
import { buildInputPanelState } from './input-panel';

describe('InputPanel state', () => {
  it('copies a tracker config and keeps Free 3D as the depth default', () => {
    const state = buildInputPanelState(
      { source: 'oak', cameraIndex: 0, target: 'color', colorPreset: 'red', colorTolerance: 1.5 },
      { calibrated: true, depthaiInstalled: true, status: 'Tracking' },
    );
    expect(state.source).toBe('oak');
    expect(state.target).toBe('color');
    expect(state.drawingSpace).toBe('free3d');
    expect(state.scale).toBe(1);
    expect(state.calibrated).toBe(true);
    expect(state.colorPreset).toBe('red');
  });
});
