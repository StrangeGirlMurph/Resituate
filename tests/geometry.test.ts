import { describe, expect, it } from 'vitest';
import { nearestPointOnPolyline } from '../src/geometry';

describe('nearestPointOnPolyline', () => {
  it('projects a point onto the inside of a segment', () => {
    expect(
      nearestPointOnPolyline({ x: 5, y: 5 }, [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual({ x: 5, y: 0 });
  });

  it('clamps the projection to the segment endpoints', () => {
    const segment = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(nearestPointOnPolyline({ x: -5, y: 2 }, segment)).toEqual({ x: 0, y: 0 });
    expect(nearestPointOnPolyline({ x: 15, y: 2 }, segment)).toEqual({ x: 10, y: 0 });
  });

  it('picks the closest segment of a polyline', () => {
    const polyline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(nearestPointOnPolyline({ x: 5, y: 1 }, polyline)).toEqual({ x: 5, y: 0 });
    expect(nearestPointOnPolyline({ x: 11, y: 7 }, polyline)).toEqual({ x: 10, y: 7 });
  });

  it('handles single-point, empty and zero-length polylines', () => {
    expect(nearestPointOnPolyline({ x: 3, y: 4 }, [{ x: 1, y: 2 }])).toEqual({
      x: 1,
      y: 2,
    });
    expect(nearestPointOnPolyline({ x: 3, y: 4 }, [])).toBeNull();
    expect(
      nearestPointOnPolyline({ x: 3, y: 4 }, [
        { x: 1, y: 1 },
        { x: 1, y: 1 },
      ]),
    ).toEqual({ x: 1, y: 1 });
  });
});
