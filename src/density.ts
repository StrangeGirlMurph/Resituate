import type { Gps, Photo } from './types';

// Mean metres per degree of latitude. Longitude is scaled by cos(latitude).
const METERS_PER_DEGREE = 111_320;

// The map is clamped to Web Mercator's latitude limits. Using the northernmost
// (or southernmost) photo latitude keeps grid cells at least the search radius
// wide in both axes, so a 3 x 3 cell lookup is sufficient everywhere.
const MAX_GRID_LATITUDE = 85;

const BLUE_HUE = 215;
const RED_HUE = 360;
const CROWD_SCALE = 3;

/**
 * Colour for a marker with the given number of neighbours inside the crowd
 * radius. Starts at the app's blue and smoothly moves through purple towards
 * red. The exponential curve keeps isolated points blue while a genuinely
 * clustered location reaches red quickly.
 */
export function crowdColor(neighbors: number): string {
  const t = 1 - Math.exp(-Math.max(0, neighbors) / CROWD_SCALE);
  const hue = BLUE_HUE + (RED_HUE - BLUE_HUE) * t;
  return `hsl(${hue.toFixed(1)}, 85%, 48%)`;
}

function distanceMeters(a: Gps, b: Gps): number {
  // Equirectangular approximation. It is accurate for the short distances this
  // feature is meant to highlight and avoids trigonometry in the inner loop.
  const averageLatitude = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const deltaLat = (b.lat - a.lat) * METERS_PER_DEGREE;
  const deltaLon =
    (b.lon - a.lon) * METERS_PER_DEGREE * Math.cos(averageLatitude);
  return Math.hypot(deltaLat, deltaLon);
}

/**
 * Count, for every geotagged photo, how many other geotagged photos lie within
 * `radiusMeters`. Photos are bucketed into a geographic grid sized around the
 * radius, so only nearby cells are checked instead of every pair of photos.
 */
export function neighborCounts(
  photos: Photo[],
  radiusMeters: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  const geotagged: Photo[] = [];
  let maxAbsLatitude = 0;

  for (const photo of photos) {
    counts.set(photo.id, 0);
    if (!photo.gps) continue;
    geotagged.push(photo);
    maxAbsLatitude = Math.max(maxAbsLatitude, Math.abs(photo.gps.lat));
  }

  if (geotagged.length < 2 || !(radiusMeters > 0)) return counts;

  const latitude = Math.min(maxAbsLatitude, MAX_GRID_LATITUDE);
  const cosLatitude = Math.max(Math.cos(latitude * (Math.PI / 180)), 0.01);
  const latCellSize = radiusMeters / METERS_PER_DEGREE;
  const lonCellSize = radiusMeters / (METERS_PER_DEGREE * cosLatitude);

  const cells = new Map<string, Photo[]>();
  for (const photo of geotagged) {
    const gps = photo.gps!;
    const x = Math.floor(gps.lon / lonCellSize);
    const y = Math.floor(gps.lat / latCellSize);
    const key = `${x},${y}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(photo);
    else cells.set(key, [photo]);
  }

  for (const photo of geotagged) {
    const gps = photo.gps!;
    const centerX = Math.floor(gps.lon / lonCellSize);
    const centerY = Math.floor(gps.lat / latCellSize);
    let count = 0;

    for (let y = centerY - 1; y <= centerY + 1; y++) {
      for (let x = centerX - 1; x <= centerX + 1; x++) {
        const bucket = cells.get(`${x},${y}`);
        if (!bucket) continue;
        for (const other of bucket) {
          if (other.id === photo.id) continue;
          if (distanceMeters(gps, other.gps!) <= radiusMeters) count++;
        }
      }
    }

    counts.set(photo.id, count);
  }

  return counts;
}
