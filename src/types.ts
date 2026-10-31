export interface Gps {
  lat: number;
  lon: number;
}

export type PhotoKind = 'jpeg' | 'unsupported';

export interface Photo {
  id: string;
  name: string;
  relPath: string;
  kind: PhotoKind;
  handle: FileSystemFileHandle;
  parent?: FileSystemDirectoryHandle;
  gps: Gps | null;
  origGps: Gps | null;
  captureTime: Date;
  is360: boolean;
  width: number;
  height: number;
  sizeBytes: number;
  writeError?: string;
}

export interface ScanItem {
  relPath: string;
  name: string;
  handle: FileSystemFileHandle;
  parent?: FileSystemDirectoryHandle;
  kind: PhotoKind;
}
