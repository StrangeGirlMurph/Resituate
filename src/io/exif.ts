import * as exifr from 'exifr';
import type { Gps } from '../types';

export interface PhotoMeta {
  gps: Gps | null;
  captureTime: Date;
  is360: boolean;
  width: number;
  height: number;
}

function asNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized =
      typeof value === 'string'
        ? value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
        : value;
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function parseGps(meta: Record<string, unknown> | undefined): Gps | null {
  const lat = Number(meta?.latitude);
  const lon = Number(meta?.longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  ) {
    return null;
  }
  return { lat, lon };
}

export async function readPhotoMeta(file: File): Promise<PhotoMeta> {
  let meta: Record<string, unknown> | undefined;

  try {
    meta = (await exifr.parse(file, {
      xmp: true,
      gps: true,
      exif: true,
      mergeOutput: true,
    })) as Record<string, unknown> | undefined;
  } catch {
    meta = undefined;
  }

  const width = asNumber(meta?.ExifImageWidth ?? meta?.ImageWidth);
  const height = asNumber(meta?.ExifImageHeight ?? meta?.ImageHeight);
  const gpano = meta?.GPano as Record<string, unknown> | undefined;
  const projection = meta?.ProjectionType ?? gpano?.ProjectionType;
  const useViewer = meta?.UsePanoramaViewer ?? gpano?.UsePanoramaViewer;
  const isPano =
    projection === 'equirectangular' ||
    useViewer === true ||
    useViewer === 'True' ||
    useViewer === 'true' ||
    useViewer === 1 ||
    useViewer === '1';
  const is360 = isPano || (width > 0 && height > 0 && Math.abs(width / height - 2) < 0.1);

  return {
    gps: parseGps(meta),
    captureTime:
      asDate(meta?.DateTimeOriginal) ??
      asDate(meta?.CreateDate) ??
      new Date(file.lastModified),
    is360,
    width,
    height,
  };
}
