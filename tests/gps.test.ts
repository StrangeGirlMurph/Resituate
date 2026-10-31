import { describe, expect, it } from 'vitest';
import piexif from 'piexifjs';
import { updateGpsBuffer } from '../src/io/gps';

const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==';

function toBinaryString(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
  return result;
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function jpegWithXmp(): Uint8Array {
  const base = fromBase64(TINY_JPEG_BASE64);
  const payload = new TextEncoder().encode(
    'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPano:ProjectionType=equirectangular</x:xmpmeta>',
  );
  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  new DataView(segment.buffer).setUint16(2, payload.length + 2, false);
  segment.set(payload, 4);

  const result = new Uint8Array(2 + segment.length + base.length - 2);
  result.set(base.subarray(0, 2), 0);
  result.set(segment, 2);
  result.set(base.subarray(2), 2 + segment.length);
  return result;
}

function hasBytes(haystack: Uint8Array, needle: string): boolean {
  const marker = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= haystack.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (haystack[i + j] !== marker[j]) continue outer;
    }
    return true;
  }
  return false;
}

function readGps(bytes: Uint8Array): { lat: number; lon: number } {
  const exif = piexif.load(toBinaryString(bytes));
  const gps = exif.GPS;
  if (!gps) throw new Error('No GPS');
  const latRef = String(gps[piexif.GPSIFD.GPSLatitudeRef]);
  const lonRef = String(gps[piexif.GPSIFD.GPSLongitudeRef]);
  return {
    lat: piexif.GPSHelper.dmsRationalToDeg(
      gps[piexif.GPSIFD.GPSLatitude] as number[],
      latRef,
    ),
    lon: piexif.GPSHelper.dmsRationalToDeg(
      gps[piexif.GPSIFD.GPSLongitude] as number[],
      lonRef,
    ),
  };
}

describe('EXIF GPS writing', () => {
  it('writes latitude/longitude and preserves XMP', () => {
    const original = jpegWithXmp();
    const patched = updateGpsBuffer(original, 51.5, 0.12);

    const gps = readGps(patched);
    expect(gps.lat).toBeCloseTo(51.5, 5);
    expect(gps.lon).toBeCloseTo(0.12, 5);
    expect(hasBytes(patched, 'GPano:ProjectionType=equirectangular')).toBe(true);
  });

  it('writes negative coordinates with the correct references', () => {
    const patched = updateGpsBuffer(jpegWithXmp(), -33.8688, -151.2093);
    const gps = readGps(patched);

    expect(gps.lat).toBeCloseTo(-33.8688, 5);
    expect(gps.lon).toBeCloseTo(-151.2093, 5);

    const exif = piexif.load(toBinaryString(patched));
    expect(exif.GPS![piexif.GPSIFD.GPSLatitudeRef]).toBe('S');
    expect(exif.GPS![piexif.GPSIFD.GPSLongitudeRef]).toBe('W');
  });

  it('can update GPS again without losing the XMP segment', () => {
    const first = updateGpsBuffer(jpegWithXmp(), 51.5, 0.12);
    const second = updateGpsBuffer(first, 48.8566, 2.3522);
    const gps = readGps(second);

    expect(gps.lat).toBeCloseTo(48.8566, 5);
    expect(gps.lon).toBeCloseTo(2.3522, 5);
    expect(hasBytes(second, 'GPano:ProjectionType=equirectangular')).toBe(true);
  });

  it('rejects invalid coordinates', () => {
    expect(() => updateGpsBuffer(jpegWithXmp(), 91, 0)).toThrow();
    expect(() => updateGpsBuffer(jpegWithXmp(), 0, 181)).toThrow();
  });
});
