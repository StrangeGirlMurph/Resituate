import { del, get, set } from 'idb-keyval';
import type { Photo, PhotoKind, ScanItem } from '../types';
import { mapLimit } from '../util';
import { readPhotoMeta } from './exif';

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe']);
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.jpe',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.dng',
  '.bmp',
]);
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '@eaDir',
  '__MACOSX',
  '.thumbnails',
  '$RECYCLE.BIN',
  'System Volume Information',
]);
const STORAGE_KEY = 'resituate:folder';

function extension(name: string): string {
  const match = name.toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : '';
}

function kindForName(name: string): PhotoKind | null {
  const ext = extension(name);
  if (JPEG_EXTENSIONS.has(ext)) return 'jpeg';
  if (IMAGE_EXTENSIONS.has(ext)) return 'unsupported';
  return null;
}

export async function scanDirectory(
  root: FileSystemDirectoryHandle,
  onProgress?: (count: number) => void,
): Promise<ScanItem[]> {
  const items: ScanItem[] = [];

  async function walk(directory: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory') {
        if (name.startsWith('.') || IGNORED_DIRECTORIES.has(name)) continue;
        await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        continue;
      }

      const kind = kindForName(name);
      if (!kind) continue;

      items.push({
        relPath: `${prefix}${name}`,
        name,
        handle: handle as FileSystemFileHandle,
        parent: directory,
        kind,
      });
      onProgress?.(items.length);
    }
  }

  await walk(root, '');
  items.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return items;
}

export async function scanFiles(
  handles: FileSystemFileHandle[],
): Promise<ScanItem[]> {
  const items: ScanItem[] = [];
  for (const handle of handles) {
    const kind = kindForName(handle.name);
    if (!kind) continue;
    try {
      await handle.getFile();
    } catch {
      // The file was deleted or is no longer accessible.
      continue;
    }
    items.push({ relPath: handle.name, name: handle.name, handle, kind });
  }
  items.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return items;
}

async function loadPhoto(item: ScanItem): Promise<Photo> {
  const base = {
    id: item.relPath,
    name: item.name,
    relPath: item.relPath,
    handle: item.handle,
    parent: item.parent,
  };

  let file: File;
  try {
    file = await item.handle.getFile();
  } catch {
    return {
      ...base,
      kind: 'unsupported',
      gps: null,
      origGps: null,
      captureTime: new Date(0),
      is360: false,
      width: 0,
      height: 0,
      sizeBytes: 0,
    };
  }

  if (item.kind === 'unsupported') {
    return {
      ...base,
      kind: 'unsupported',
      gps: null,
      origGps: null,
      captureTime: new Date(file.lastModified),
      is360: false,
      width: 0,
      height: 0,
      sizeBytes: file.size,
    };
  }

  try {
    const meta = await readPhotoMeta(file);
    return {
      ...base,
      kind: 'jpeg',
      gps: meta.gps,
      origGps: meta.gps ? { ...meta.gps } : null,
      captureTime: meta.captureTime,
      is360: meta.is360,
      width: meta.width,
      height: meta.height,
      sizeBytes: file.size,
    };
  } catch {
    return {
      ...base,
      kind: 'unsupported',
      gps: null,
      origGps: null,
      captureTime: new Date(file.lastModified),
      is360: false,
      width: 0,
      height: 0,
      sizeBytes: file.size,
    };
  }
}

export async function loadPhotos(
  items: ScanItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Photo[]> {
  let done = 0;
  return mapLimit(items, 6, async (item) => {
    const photo = await loadPhoto(item);
    done += 1;
    onProgress?.(done, items.length);
    return photo;
  });
}

export async function deletePhoto(photo: Photo): Promise<void> {
  if (photo.parent?.removeEntry) {
    await photo.parent.removeEntry(photo.name);
    return;
  }
  if (typeof photo.handle.remove === 'function') {
    await photo.handle.remove();
    return;
  }
  throw new Error('This browser cannot delete files; use your file manager.');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function ensurePermission(handle: FileSystemHandle): Promise<boolean> {
  if (typeof handle.queryPermission !== 'function') return true;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (typeof handle.requestPermission !== 'function') return false;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) {
    throw new Error('This browser does not support folder access. Use Chromium.');
  }
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (error) {
    if (isAbortError(error)) return null;
    throw error;
  }
}

export async function pickFiles(): Promise<FileSystemFileHandle[]> {
  if (!window.showOpenFilePicker) {
    throw new Error('This browser does not support file access. Use Chromium.');
  }
  try {
    return await window.showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: 'JPEG images',
          accept: { 'image/jpeg': ['.jpg', '.jpeg', '.jpe'] },
        },
      ],
    });
  } catch (error) {
    if (isAbortError(error)) return [];
    throw error;
  }
}

export async function storeFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await set(STORAGE_KEY, handle);
  } catch {
    // Persistence is a convenience; ignore quota/private-mode failures.
  }
}

export async function loadStoredFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await get<FileSystemDirectoryHandle>(STORAGE_KEY);
  } catch {
    return undefined;
  }
}

export async function clearStoredFolder(): Promise<void> {
  try {
    await del(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
