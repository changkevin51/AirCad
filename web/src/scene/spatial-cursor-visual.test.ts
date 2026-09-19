import { describe, expect, it } from 'vitest';
import { SpatialCursorVisual } from './spatial-cursor-visual';
import { v3 } from '../model/vec';

describe('SpatialCursorVisual', () => {
  it('hides without a world point and shows a marker on the point', () => {
    const visual = new SpatialCursorVisual();
    visual.update(null, true);
    expect(visual.group.visible).toBe(false);
    visual.update(v3(10, 20, 30), true);
    expect(visual.group.visible).toBe(true);
    visual.update(v3(10, 20, 30), false);
    expect(visual.group.visible).toBe(false);
  });

  it('sizes the snap-radius sphere and highlights a vertex target', () => {
    const visual = new SpatialCursorVisual();
    visual.update(v3(0, 0, 0), true, { radius: 40, snapType: 'vertex', target: v3(10, 0, 0) });
    expect(visual.group.visible).toBe(true);
    const radius = visual.group.children[1] as { scale: { x: number }; visible: boolean };
    const highlight = visual.group.children[2] as { visible: boolean; position: { x: number } };
    expect(radius.scale.x).toBe(40);
    expect(highlight.visible).toBe(true);
    expect(highlight.position.x).toBe(10);
  });
});
