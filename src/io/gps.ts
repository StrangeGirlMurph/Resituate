import piexif from 'piexifjs';
import type { Gps } from '../types';

const HEADER_READ_SIZE = 1024 * 1024;

interface App1Segment {
  offset: number;
  payloadOffset: number;
  payloadLength: number;
}

interface CachedExif {
  offset: number;
  segment: Uint8Array;
  payloadLength: number;
  size: number;
  lastModified: number;
}

function cacheMatches(file: File, cached: CachedExif | undefined): cached is CachedExif {
  return !!cached && cached.size === file.size && cached.lastModified === file.lastModified;
}

type ExifDict = ReturnType<typeof piexif.load>;

const cache = new WeakMap<FileSystemFileHandle, CachedExif>();
const operations = new WeakMap<FileSystemFileHandle, Promise<void>>();

/** Serializes prefetch and writes for one file so a slower read cannot cache stale bytes. */
function serialize<T>(handle: FileSystemFileHandle, task: () => Promise<T>): Promise<T> {
  const previous = operations.get(handle) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  operations.set(handle, run.then(() => undefined, () => undefined));
  return run;
}

function toBinaryString(bytes: Uint8Array): string {
  let result = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return result;
}

function fromBinaryString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function setGps(exif: ExifDict, lat: number, lon: number): void {
  if (!exif.GPS) exif.GPS = {};
  exif.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
  exif.GPS[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
  exif.GPS[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? 'E' : 'W';
  exif.GPS[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lon));
}

function findExifApp1(bytes: Uint8Array): App1Segment | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

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
      bytes[payloadOffset] === 0x45 && // E
      bytes[payloadOffset + 1] === 0x78 && // x
      bytes[payloadOffset + 2] === 0x69 && // i
      bytes[payloadOffset + 3] === 0x66 && // f
      bytes[payloadOffset + 4] === 0x00 &&
      bytes[payloadOffset + 5] === 0x00
    ) {
      return { offset, payloadOffset, payloadLength };
    }

    offset += 2 + length;
  }

  return null;
}

export function updateGpsBuffer(buffer: Uint8Array, lat: number, lon: number): Uint8Array {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    throw new Error('Invalid GPS coordinates');
  }

  const binary = toBinaryString(buffer);
  const exif = piexif.load(binary);
  setGps(exif, lat, lon);
  return fromBinaryString(piexif.insert(piexif.dump(exif), binary));
}

/**
 * Reads and caches the small EXIF APP1 segment of a JPEG. The UI calls this
 * for the current selection, so a drag does not pay for reading the headers.
 */
export function prefetchGps(handle: FileSystemFileHandle): Promise<void> {
  return serialize(handle, async () => {
    try {
      const file = await handle.getFile();
      if (cacheMatches(file, cache.get(handle))) return;

      const header = new Uint8Array(
        await file.slice(0, Math.min(file.size, HEADER_READ_SIZE)).arrayBuffer(),
      );
      const segment = findExifApp1(header);
      if (!segment) return;

      // Do not install data for a file that was replaced while it was read.
      const current = await handle.getFile();
      if (current.size !== file.size || current.lastModified !== file.lastModified) return;

      const segmentBytes = new Uint8Array(4 + segment.payloadLength);
      segmentBytes.set(
        header.subarray(segment.offset, segment.offset + 4 + segment.payloadLength),
      );
      cache.set(handle, {
        offset: segment.offset,
        segment: segmentBytes,
        payloadLength: segment.payloadLength,
        size: file.size,
        lastModified: file.lastModified,
      });
    } catch {
      // Prefetching is best-effort.
    }
  });
}

/**
 * Fast path: read only the JPEG header, patch the small EXIF segment with
 * piexifjs, and replace just that APP1 segment in place. Every other byte of
 * the JPEG (including XMP/GPano) stays untouched. Returns false when the file
 * does not fit this path, in which case the caller uses the full rewrite.
 */
async function writeGpsFast(handle: FileSystemFileHandle, target: Gps): Promise<boolean> {
  const file = await handle.getFile();
  const cached = cache.get(handle);
  let offset: number;
  let oldPayload: Uint8Array;
  let payloadLength: number;

  if (cacheMatches(file, cached)) {
    offset = cached.offset;
    oldPayload = cached.segment.subarray(4);
    payloadLength = cached.payloadLength;
  } else {
    const header = new Uint8Array(
      await file.slice(0, Math.min(file.size, HEADER_READ_SIZE)).arrayBuffer(),
    );
    const segment = findExifApp1(header);
    if (!segment) return false;
    offset = segment.offset;
    oldPayload = header.subarray(
      segment.payloadOffset,
      segment.payloadOffset + segment.payloadLength,
    );
    payloadLength = segment.payloadLength;
  }

  const exif = piexif.load(toBinaryString(oldPayload));
  setGps(exif, target.lat, target.lon);
  const newPayload = fromBinaryString(piexif.dump(exif));

  // piexifjs canonicalizes the EXIF structure, so the first rewrite is often
  // slightly smaller than the original segment. Keep the original byte length
  // by zero-padding; the trailing bytes are ignored by EXIF readers. This lets
  // the very first move use the fast path instead of rewriting the whole JPEG.
  // If the new payload is larger, the rest of the JPEG would have to shift.
  if (newPayload.length > payloadLength) return false;

  const segmentBytes = new Uint8Array(4 + payloadLength);
  segmentBytes[0] = 0xff;
  segmentBytes[1] = 0xe1;
  new DataView(segmentBytes.buffer).setUint16(2, payloadLength + 2, false);
  segmentBytes.set(newPayload, 4);

  const output = new ArrayBuffer(segmentBytes.length);
  new Uint8Array(output).set(segmentBytes);

  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await writable.write({
      type: 'write',
      position: offset,
      data: output,
    });
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // The original stays intact when the temporary write is aborted.
    }
    throw error;
  }

  let size = file.size;
  let lastModified = file.lastModified;
  try {
    const updated = await handle.getFile();
    size = updated.size;
    lastModified = updated.lastModified;
  } catch {
    // A failed metadata refresh only means the next write re-reads the header.
  }

  cache.set(handle, {
    offset,
    segment: segmentBytes,
    payloadLength,
    size,
    lastModified,
  });

  return true;
}

async function writeGpsFull(handle: FileSystemFileHandle, target: Gps): Promise<void> {
  const file = await handle.getFile();
  const buffer = new Uint8Array(await file.arrayBuffer());
  const patched = updateGpsBuffer(buffer, target.lat, target.lon);
  const output = new ArrayBuffer(patched.byteLength);
  new Uint8Array(output).set(patched);
  const writable = await handle.createWritable();

  try {
    await writable.write(output);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // The original file is left intact when the stream is aborted.
    }
    throw error;
  }
}

export function writeGps(
  handle: FileSystemFileHandle,
  target: Gps,
): Promise<void> {
  return serialize(handle, async () => {
    try {
      if (await writeGpsFast(handle, target)) return;
    } catch {
      // Fall back to the full rewrite for non-standard files or write errors.
    }

    // The full rewrite changes the segment layout, so any cached header data is stale.
    cache.delete(handle);
    await writeGpsFull(handle, target);
  });
}
