export interface Point2D {
  x: number;
  y: number;
}

/**
 * Closest point on a polyline to `point`, using orthogonal projection onto each
 * segment and clamping to the segment's endpoints. Returns `null` for an empty
 * polyline. A one-point polyline projects to that point.
 */
export function nearestPointOnPolyline(
  point: Point2D,
  points: Point2D[],
): Point2D | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { ...points[0] };

  let bestX = points[0].x;
  let bestY = points[0].y;
  let bestDistance = Infinity;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let t =
      lengthSquared === 0
        ? 0
        : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));

    const x = a.x + t * dx;
    const y = a.y + t * dy;
    const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestX = x;
      bestY = y;
    }
  }

  return { x: bestX, y: bestY };
}
