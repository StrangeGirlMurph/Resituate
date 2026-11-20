import { describe, expect, it } from 'vitest';
import { crowdColor, neighborCounts } from '../src/density';
import type { Photo } from '../src/types';

const METERS_PER_DEGREE = 111_320;

function metersToLongitude(meters: number): number {
  return meters / METERS_PER_DEGREE;
}

function photo(id: string, lat: number | null, lon: number | null): Photo {
  return {
    id,
    name: `${id}.jpg`,
    relPath: `${id}.jpg`,
    kind: 'jpeg',
    handle: {} as Photo['handle'],
    gps: lat === null || lon === null ? null : { lat, lon },
    origGps: null,
    captureTime: new Date(0),
    is360: false,
    width: 0,
    height: 0,
    sizeBytes: 0,
  };
}

describe('crowdColor', () => {
  it('starts blue and moves towards red as neighbours increase', () => {
    expect(crowdColor(0)).toBe('hsl(215.0, 85%, 48%)');

    const hues = [0, 1, 2, 3, 5, 10].map((count) =>
      Number(crowdColor(count).match(/^hsl\(([\d.]+)/)![1]),
    );
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i]).toBeGreaterThan(hues[i - 1]);
    }
    expect(hues[hues.length - 1]).toBeGreaterThan(350);
  });
});

describe('neighborCounts', () => {
  it('counts only photos inside the radius', () => {
    const a = photo('a', 0, 0);
    const b = photo('b', 0, metersToLongitude(1));
    const c = photo('c', 0, metersToLongitude(10));

    const counts = neighborCounts([a, b, c], 2);

    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(0);
  });

  it('counts photos at the same position and expands with the radius', () => {
    const a = photo('a', 0, 0);
    const b = photo('b', 0, 0);
    const c = photo('c', 0, metersToLongitude(10));

    const close = neighborCounts([a, b, c], 2);
    expect(close.get('a')).toBe(1);
    expect(close.get('b')).toBe(1);
    expect(close.get('c')).toBe(0);

    const wide = neighborCounts([a, b, c], 20);
    expect(wide.get('a')).toBe(2);
    expect(wide.get('b')).toBe(2);
    expect(wide.get('c')).toBe(2);
  });

  it('ignores photos without GPS', () => {
    const a = photo('a', 0, 0);
    const b = photo('b', 0, metersToLongitude(1));
    const noGps = photo('no-gps', null, null);

    const counts = neighborCounts([a, b, noGps], 2);

    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('no-gps')).toBe(0);
  });

  it('returns zero for every photo when the radius is not positive', () => {
    const a = photo('a', 0, 0);
    const b = photo('b', 0, 0);

    const counts = neighborCounts([a, b], 0);

    expect(counts.get('a')).toBe(0);
    expect(counts.get('b')).toBe(0);
  });
});
