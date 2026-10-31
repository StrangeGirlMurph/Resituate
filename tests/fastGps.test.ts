import { describe, expect, it } from 'vitest';
import piexif from 'piexifjs';
import { prefetchGps, writeGps } from '../src/io/gps';

const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==';

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toBinaryString(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
  return result;
}

function fromBinaryString(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
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

  const withXmp = new Uint8Array(2 + segment.length + base.length - 2);
  withXmp.set(base.subarray(0, 2), 0);
  withXmp.set(segment, 2);
  withXmp.set(base.subarray(2), 2 + segment.length);

  const gps: Record<number, unknown> = {};
  gps[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
  gps[piexif.GPSIFD.GPSLatitudeRef] = 'N';
  gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(51.5);
  gps[piexif.GPSIFD.GPSLongitudeRef] = 'W';
  gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(0.12);
  const exif = piexif.dump({
    '0th': {},
    Exif: {},
    GPS: gps,
    Interop: {},
    '1st': {},
  });
  return fromBinaryString(piexif.insert(exif, toBinaryString(withXmp)));
}

interface TestApp1 {
  offset: number;
  payloadOffset: number;
  payloadLength: number;
}

function findExifApp1(bytes: Uint8Array): TestApp1 | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    const payloadOffset = offset + 4;
    const payloadLength = length - 2;

    if (
      marker === 0xe1 &&
      payloadLength >= 6 &&
      bytes[payloadOffset] === 0x45 &&
      bytes[payloadOffset + 1] === 0x78 &&
      bytes[payloadOffset + 2] === 0x69 &&
      bytes[payloadOffset + 3] === 0x66 &&
      bytes[payloadOffset + 4] === 0 &&
      bytes[payloadOffset + 5] === 0
    ) {
      return { offset, payloadOffset, payloadLength };
    }

    offset += 2 + length;
  }

  return null;
}

/** Simulates a camera EXIF segment with trailing slack that piexifjs drops. */
function withExifSlack(jpeg: Uint8Array, slack: number): Uint8Array {
  const segment = findExifApp1(jpeg);
  if (!segment) throw new Error('Test JPEG has no EXIF segment');

  const padding = new Uint8Array(slack);
  const end = segment.payloadOffset + segment.payloadLength;
  const output = new Uint8Array(jpeg.length + slack);
  output.set(jpeg.subarray(0, end), 0);
  output.set(padding, end);
  output.set(jpeg.subarray(end), end + slack);

  const newLength = segment.payloadLength + 2 + slack;
  output[segment.offset + 2] = (newLength >> 8) & 0xff;
  output[segment.offset + 3] = newLength & 0xff;

  return output;
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
  return {
    lat: piexif.GPSHelper.dmsRationalToDeg(
      gps[piexif.GPSIFD.GPSLatitude] as number[],
      String(gps[piexif.GPSIFD.GPSLatitudeRef]),
    ),
    lon: piexif.GPSHelper.dmsRationalToDeg(
      gps[piexif.GPSIFD.GPSLongitude] as number[],
      String(gps[piexif.GPSIFD.GPSLongitudeRef]),
    ),
  };
}

function makeHandle(initial: Uint8Array) {
  let current = initial;
  let lastModified = 1;
  let headerSlices = 0;
  let writableOptions: FileSystemCreateWritableOptions | undefined;
  const writes: Array<{ position: number; data: Uint8Array }> = [];

  const handle = {
    async getFile(): Promise<File> {
      const snapshot = current;
      const file = {
        size: snapshot.byteLength,
        lastModified,
        slice(start = 0, end = snapshot.byteLength) {
          headerSlices += 1;
          const bytes = snapshot.slice(start, end);
          return new Blob([bytes], { type: 'image/jpeg' });
        },
        async arrayBuffer() {
          return snapshot.buffer.slice(
            snapshot.byteOffset,
            snapshot.byteOffset + snapshot.byteLength,
          );
        },
      };
      return file as unknown as File;
    },
    async createWritable(options?: FileSystemCreateWritableOptions) {
      writableOptions = options;
      return {
        async write(chunk: unknown) {
          if (chunk && typeof chunk === 'object' && 'type' in chunk) {
            const params = chunk as {
              type: 'write';
              position: number;
              data: ArrayBuffer;
            };
            const data = new Uint8Array(params.data);
            current = new Uint8Array(current);
            current.set(data, params.position);
            writes.push({ position: params.position, data });
            lastModified += 1;
            return;
          }

          const data = new Uint8Array(chunk as ArrayBuffer);
          current = new Uint8Array(data);
          writes.push({ position: 0, data });
          lastModified += 1;
        },
        async close() {},
        async abort() {},
      };
    },
  };

  return {
    handle: handle as unknown as FileSystemFileHandle,
    getCurrent: () => current,
    getWrites: () => writes,
    getWritableOptions: () => writableOptions,
    getHeaderSlices: () => headerSlices,
  };
}

describe('fast GPS write path', () => {
  it('writes only the EXIF APP1 segment and preserves XMP', async () => {
    const original = jpegWithXmp();
    const fake = makeHandle(original);

    await writeGps(fake.handle, { lat: 51.5, lon: 0.12 });

    expect(fake.getWritableOptions()).toEqual({ keepExistingData: true });
    expect(fake.getWrites()).toHaveLength(1);
    expect(fake.getWrites()[0].position).toBeGreaterThan(0);
    expect(fake.getWrites()[0].data.length).toBeLessThan(original.length);
    expect(fake.getCurrent().length).toBe(original.length);
    expect(hasBytes(fake.getCurrent(), 'GPano:ProjectionType=equirectangular')).toBe(true);

    const gps = readGps(fake.getCurrent());
    expect(gps.lat).toBeCloseTo(51.5, 5);
    expect(gps.lon).toBeCloseTo(0.12, 5);
  });

  it('keeps the segment size when canonical EXIF is smaller, so the first move stays fast', async () => {
    const original = withExifSlack(jpegWithXmp(), 128);
    const segment = findExifApp1(original);
    if (!segment) throw new Error('Fixture is missing EXIF');
    const fake = makeHandle(original);

    await prefetchGps(fake.handle);
    expect(fake.getWrites()).toHaveLength(0);
    expect(fake.getHeaderSlices()).toBe(1);

    await writeGps(fake.handle, { lat: -33.8688, lon: 151.2093 });

    expect(fake.getHeaderSlices()).toBe(1);
    expect(fake.getWritableOptions()).toEqual({ keepExistingData: true });
    expect(fake.getWrites()).toHaveLength(1);
    expect(fake.getWrites()[0].position).toBe(segment.offset);
    expect(fake.getWrites()[0].data.length).toBe(4 + segment.payloadLength);
    expect(fake.getCurrent().length).toBe(original.length);
    expect(findExifApp1(fake.getCurrent())?.payloadLength).toBe(segment.payloadLength);
    expect(hasBytes(fake.getCurrent(), 'GPano:ProjectionType=equirectangular')).toBe(true);

    const firstGps = readGps(fake.getCurrent());
    expect(firstGps.lat).toBeCloseTo(-33.8688, 5);
    expect(firstGps.lon).toBeCloseTo(151.2093, 5);

    // A second move uses the cached segment and stays on the fast path too.
    await writeGps(fake.handle, { lat: 48.8566, lon: 2.3522 });

    expect(fake.getHeaderSlices()).toBe(1);
    expect(fake.getWrites()).toHaveLength(2);
    expect(fake.getWrites()[1].position).toBe(segment.offset);
    expect(fake.getWrites()[1].data.length).toBe(4 + segment.payloadLength);
    expect(fake.getCurrent().length).toBe(original.length);

    const secondGps = readGps(fake.getCurrent());
    expect(secondGps.lat).toBeCloseTo(48.8566, 5);
    expect(secondGps.lon).toBeCloseTo(2.3522, 5);
  });

  it('falls back to a full rewrite when there is no EXIF segment', async () => {
    const original = fromBase64(TINY_JPEG_BASE64);
    const fake = makeHandle(original);

    await writeGps(fake.handle, { lat: -33.8688, lon: 151.2093 });

    expect(fake.getWritableOptions()).toBeUndefined();
    expect(fake.getWrites()).toHaveLength(1);
    expect(fake.getWrites()[0].position).toBe(0);

    const gps = readGps(fake.getCurrent());
    expect(gps.lat).toBeCloseTo(-33.8688, 5);
    expect(gps.lon).toBeCloseTo(151.2093, 5);
  });
});
