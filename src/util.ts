import type { Gps } from './types';

/** DataTransfer type carrying a photo id from the sidebar to the map. */
export const PHOTO_DRAG_TYPE = 'application/x-resituate-photo';

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return result;
}

export function sameGps(a: Gps | null, b: Gps | null): boolean {
  return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
}

export function clampLat(lat: number): number {
  return Math.max(-90, Math.min(90, lat));
}

export function clampLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${pad(
    date.getDate(),
  )}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCoord(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}
