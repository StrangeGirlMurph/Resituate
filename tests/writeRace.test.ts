import { describe, expect, it, vi } from 'vitest';
import type { Gps, Photo } from '../src/types';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ id: string; target: Gps }>,
  delayMs: 0,
}));

vi.mock('../src/io/gps', () => ({
  writeGps: async (handle: { id: string }, target: Gps) => {
    state.calls.push({ id: handle.id, target: { ...target } });
    if (state.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    }
  },
}));

import { writePhotos } from '../src/io/write';

function photo(id: string, gps: Gps): Photo {
  return {
    id,
    name: `${id}.jpg`,
    relPath: `${id}.jpg`,
    kind: 'jpeg',
    handle: { id } as unknown as FileSystemFileHandle,
    gps: { ...gps },
    origGps: { ...gps },
    captureTime: new Date(0),
    is360: false,
    width: 0,
    height: 0,
    sizeBytes: 0,
  };
}

function callsFor(id: string): Gps[] {
  return state.calls.filter((call) => call.id === id).map((call) => call.target);
}

const newPosition: Gps = { lat: 52.5, lon: 13.4 };
const oldPosition: Gps = { lat: 52.49, lon: 13.38 };

describe('write batch consistency', () => {
  it('snapshots positions when the batch is created', async () => {
    state.calls.length = 0;
    state.delayMs = 20;
    const photos = Array.from({ length: 16 }, (_, index) =>
      photo(`snapshot-${index}`, oldPosition),
    );

    const batch = writePhotos(photos);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Simulate another drag changing the in-memory positions while the first
    // batch is still writing. No second batch has been committed yet.
    for (const item of photos) item.gps = { ...newPosition };

    await batch;

    expect(state.calls).toHaveLength(photos.length);
    for (const item of photos) {
      expect(callsFor(item.id)).toEqual([oldPosition]);
    }
  });

  it('lets the newest committed position win for each file', async () => {
    state.calls.length = 0;
    state.delayMs = 30;
    const photos = Array.from({ length: 16 }, (_, index) =>
      photo(`latest-${index}`, oldPosition),
    );

    const first = writePhotos(photos);
    await new Promise((resolve) => setTimeout(resolve, 5));

    for (const item of photos) item.gps = { ...newPosition };
    const second = writePhotos(photos);

    await Promise.all([first, second]);

    for (const item of photos) {
      const targets = callsFor(item.id);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.at(-1)).toEqual(newPosition);
    }
  });
});
