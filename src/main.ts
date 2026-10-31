import './styles.css';
import { createInteractions, createMapView, type SelectionTool } from './map';
import { validateArcgisKey } from './basemaps';
import {
  clearSelection,
  createProject,
  removePhotos,
  selectAll,
  selectOnly,
  selectedPhotos,
  setSelection,
  setPhotos,
  subscribe,
  toggle,
  toggleMany,
} from './state';
import {
  clearStoredFolder,
  deletePhoto,
  ensurePermission,
  loadPhotos,
  loadStoredFolder,
  pickDirectory,
  pickFiles,
  scanDirectory,
  scanFiles,
  storeFolder,
} from './io/fs';
import { prefetchGps } from './io/gps';
import { writePhotos } from './io/write';
import type { Gps, Photo } from './types';
import { createLanding, createSidebar, createStatusBar, createToolbar } from './ui';
import { message, sameGps } from './util';

type Source =
  | { kind: 'folder'; handle: FileSystemDirectoryHandle }
  | { kind: 'files'; handles: FileSystemFileHandle[] };

interface MoveItem {
  id: string;
  before: Gps;
  after: Gps;
}

interface MoveOperation {
  items: MoveItem[];
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

const project = createProject();
const mapEl = document.createElement('div');
mapEl.id = 'map';

const mapViewEl = document.createElement('section');
mapViewEl.className = 'map-view';
mapViewEl.hidden = true;

const status = createStatusBar();

const toolbar = createToolbar({
  onOpenFolder: () => void openFolder(),
  onOpenImages: () => void openFiles(),
  onRescan: () => void rescan(),
  onUndo: () => void undo(),
  onRedo: () => void redo(),
  onHelp: () => showLanding(),
});

const sidebar = createSidebar({
  onSelectOnly: (id) => selectOnly(project, id),
  onToggle: (id) => toggle(project, id),
  onSetSelection: (ids) => setSelection(project, ids),
  onToggleMany: (ids) => toggleMany(project, ids),
  onPreview: (id) => {
    const photo = project.byId.get(id);
    if (photo) void showPreview(photo);
  },
});

const landing = createLanding({
  onOpenFolder: () => void openFolder(),
  onOpenImages: () => void openFiles(),
  onReconnect: () => void reconnect(),
  onBack: () => showMap(),
});

mapViewEl.append(toolbar.element, mapEl, sidebar.element, status.element);
app.append(landing.element, mapViewEl);

const mapView = createMapView(mapEl);

let source: Source | null = null;
let storedHandle: FileSystemDirectoryHandle | undefined;
let tool: SelectionTool = 'rect';
let pendingWrite: Promise<void> = Promise.resolve();
let previewClose: (() => void) | null = null;
let previewPhotoId: string | null = null;
let previewGeneration = 0;
let prefetchTimer: number | undefined;
let prefetchGeneration = 0;
let pendingDiskOperations = 0;
const undoStack: MoveOperation[] = [];
const redoStack: MoveOperation[] = [];

function beginDiskOperation(): void {
  pendingDiskOperations += 1;
}

function endDiskOperation(): void {
  pendingDiskOperations = Math.max(0, pendingDiskOperations - 1);
}

function trackDiskOperation<T>(operation: Promise<T>): Promise<T> {
  beginDiskOperation();
  return operation.finally(endDiskOperation);
}

window.addEventListener('beforeunload', (event) => {
  if (pendingDiskOperations === 0) return;
  event.preventDefault();
  event.returnValue = '';
});

const interactions = createInteractions(mapEl, {
  view: mapView,
  photos: () => project.photos,
  selection: () => project.selection,
  tool: () => tool,
  onSelectOnly: (id) => selectOnly(project, id),
  onToggle: (id) => toggle(project, id),
  onSetSelection: (ids) => setSelection(project, ids),
  onToggleMany: (ids) => toggleMany(project, ids),
  onPreview: (photo) => void showPreview(photo),
  onMoveCommit: (photos, before) => commitMove(photos, before),
  onLiveMove: (photos) => liveMove(photos),
  onPhotoDrop: (id, gps) => placePhoto(id, gps),
});

function render(): void {
  mapView.syncSelection(project.selection);
  sidebar.render(project);
  status.render(project);
  toolbar.setHistory(undoStack.length > 0, redoStack.length > 0);
}

function refreshMap(): void {
  mapView.setPhotos(project.photos);
  render();
}

/**
 * Warm the small EXIF headers for the current selection after a short pause.
 * This takes the 1 MB header read out of the first write without prefetching
 * hundreds of megabytes of image data.
 */
function scheduleSelectionPrefetch(): void {
  prefetchGeneration += 1;
  if (prefetchTimer !== undefined) window.clearTimeout(prefetchTimer);

  const targets = selectedPhotos(project).filter((photo) => photo.kind === 'jpeg');
  if (targets.length === 0) {
    prefetchTimer = undefined;
    return;
  }

  const generation = prefetchGeneration;
  prefetchTimer = window.setTimeout(() => {
    prefetchTimer = undefined;
    void prefetchHeaders(targets, generation);
  }, 150);
}

async function prefetchHeaders(photos: Photo[], generation: number): Promise<void> {
  let next = 0;

  async function worker(): Promise<void> {
    while (next < photos.length) {
      if (generation !== prefetchGeneration) return;
      const photo = photos[next++];
      await prefetchGps(photo.handle);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(4, photos.length) }, () => worker()),
  );
}

function cancelSelectionPrefetch(): void {
  prefetchGeneration += 1;
  if (prefetchTimer !== undefined) {
    window.clearTimeout(prefetchTimer);
    prefetchTimer = undefined;
  }
}

subscribe(project, () => {
  render();
  scheduleSelectionPrefetch();
});

const MAP_HASH = '#map';

function showMap(addHistory = true): void {
  landing.element.hidden = true;
  mapViewEl.hidden = false;
  mapView.invalidate();
  if (addHistory && window.location.hash !== MAP_HASH) {
    history.pushState({ view: 'map' }, '', MAP_HASH);
  }
}

function showLanding(addHistory = true): void {
  closePreview();
  landing.setHasProject(project.photos.length > 0);
  landing.element.hidden = false;
  mapViewEl.hidden = true;
  if (addHistory && window.location.hash) {
    history.pushState(
      { view: 'landing' },
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }
}

function applyRoute(): void {
  if (window.location.hash === MAP_HASH) showMap(false);
  else showLanding(false);
}

window.addEventListener('popstate', applyRoute);

// A folder or file selection cannot be restored from a URL, so a reload on
// #map starts at the landing page and lets the user reconnect instead.
if (window.location.hash) {
  history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
}
showLanding(false);

async function openFolder(): Promise<void> {
  if (
    project.photos.length > 0 &&
    !window.confirm('Open a new folder and replace the current project?')
  ) {
    return;
  }

  try {
    const handle = await pickDirectory();
    if (!handle) return;
    await loadFolder(handle);
  } catch (error) {
    status.setError(message(error));
  }
}

async function openFiles(): Promise<void> {
  if (
    project.photos.length > 0 &&
    !window.confirm('Open images and replace the current project?')
  ) {
    return;
  }

  try {
    const handles = await pickFiles();
    if (handles.length === 0) return;
    await loadFiles(handles);
  } catch (error) {
    status.setError(message(error));
  }
}

async function reconnect(): Promise<void> {
  if (!storedHandle) return;
  try {
    await loadFolder(storedHandle);
  } catch (error) {
    status.setError(message(error));
  }
}

async function loadFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  if (!(await ensurePermission(handle))) {
    status.setError('Folder access was not granted.');
    return;
  }

  await pendingWrite;
  closePreview();
  showMap();
  undoStack.length = 0;
  redoStack.length = 0;
  status.setError(null);
  status.setActivity('Scanning…');
  source = null;
  setPhotos(project, []);
  refreshMap();

  try {
    const items = await scanDirectory(handle, (count) => {
      status.setActivity(`Scanning… ${count} files`);
    });

    if (items.length === 0) {
      landing.setHasProject(false);
      status.setActivity(null);
      status.setError('No JPEG images found in this folder.');
      return;
    }

    status.setActivity(`Reading ${items.length} files…`);
    const photos = await loadPhotos(items, (done, total) => {
      status.setActivity(`Reading ${done}/${total}…`);
    });

    source = { kind: 'folder', handle };
    storedHandle = handle;
    await storeFolder(handle);
    landing.setStoredName(handle.name);
    landing.setHasProject(photos.length > 0);

    setPhotos(project, photos);
    refreshMap();
    mapView.fit(photos);
    status.setActivity(null);
    status.setError(null);
  } catch (error) {
    status.setActivity(null);
    status.setError(message(error));
  }
}

async function loadFiles(handles: FileSystemFileHandle[]): Promise<void> {
  await pendingWrite;
  closePreview();
  showMap();
  undoStack.length = 0;
  redoStack.length = 0;
  status.setError(null);
  status.setActivity('Loading…');
  source = null;
  setPhotos(project, []);
  refreshMap();

  try {
    const items = await scanFiles(handles);
    if (items.length === 0) {
      status.setActivity(null);
      status.setError('No JPEG images were selected.');
      return;
    }

    const photos = await loadPhotos(items, (done, total) => {
      status.setActivity(`Reading ${done}/${total}…`);
    });

    source = { kind: 'files', handles };
    storedHandle = undefined;
    await clearStoredFolder();
    landing.setStoredName(undefined);
    landing.setHasProject(photos.length > 0);

    setPhotos(project, photos);
    refreshMap();
    mapView.fit(photos);
    status.setActivity(null);
  } catch (error) {
    status.setActivity(null);
    status.setError(message(error));
  }
}

async function rescan(): Promise<void> {
  if (!source) {
    status.setError('Open a folder or images first.');
    return;
  }

  await pendingWrite;
  status.setError(null);
  status.setActivity('Scanning…');

  try {
    const items =
      source.kind === 'folder'
        ? await scanDirectory(source.handle, (count) => {
            status.setActivity(`Scanning… ${count} files`);
          })
        : await scanFiles(source.handles);

    if (items.length === 0) {
      status.setActivity(null);
      status.setError('No images found.');
      return;
    }

    const photos = await loadPhotos(items, (done, total) => {
      status.setActivity(`Reading ${done}/${total}…`);
    });

    setPhotos(project, photos, true);
    refreshMap();
    mapView.fit(photos);
    status.setActivity(null);
  } catch (error) {
    status.setActivity(null);
    status.setError(message(error));
  }
}

async function deletePhotos(
  photos: Photo[],
): Promise<{ removed: string[]; failed: number }> {
  const removed: string[] = [];
  let failed = 0;

  beginDiskOperation();
  try {
    for (const photo of photos) {
      try {
        await deletePhoto(photo);
        removed.push(photo.id);
      } catch {
        failed += 1;
      }
    }
  } finally {
    endDiskOperation();
  }

  return { removed, failed };
}

async function deleteSelected(): Promise<void> {
  if (previewPhotoId) return;

  const selected = selectedPhotos(project);
  if (selected.length === 0) return;

  const text = `This will permanently delete ${selected.length} file(s) from your device. They will NOT go into the trash. This cannot be undone.`;
  if (!window.confirm(text)) return;

  await pendingWrite;
  status.setActivity('Deleting…');
  const { removed, failed } = await deletePhotos(selected);

  removePhotos(project, removed);
  // Keep the current viewport after deletion; only an explicit reload or
  // rescan should refit the map to the remaining photos.
  refreshMap();
  status.setActivity(null);
  if (failed > 0) status.setError(`${failed} file(s) could not be deleted.`);
  else status.setError(null);
}

async function deletePreviewedPhoto(): Promise<void> {
  const photo = previewPhotoId ? project.byId.get(previewPhotoId) : undefined;
  if (!photo) return;

  // Find the next image before removing this one, so the preview continues at
  // the same position in the filename order (wrapping at the end).
  const photos = previewOrder();
  const index = photos.findIndex((item) => item.id === photo.id);
  const next =
    index >= 0 && photos.length > 1
      ? photos[(index + 1) % photos.length]
      : null;

  const text = `This will permanently delete ${photo.name} from your device. It will NOT go into the trash. This cannot be undone.`;
  if (!window.confirm(text)) return;

  await pendingWrite;
  status.setActivity('Deleting…');
  const { removed, failed } = await deletePhotos([photo]);
  status.setActivity(null);

  if (removed.length === 0) {
    render();
    status.setError(failed > 0 ? `${photo.name} could not be deleted.` : null);
    return;
  }

  removePhotos(project, removed);
  refreshMap();
  status.setError(null);

  if (next) await showPreview(next);
  else closePreview();
}

function liveMove(photos: Photo[]): void {
  for (const photo of photos) mapView.updateMarker(photo);
}

/**
 * A photo dragged from the "Without GPS" sidebar section onto the map. It has
 * no previous position to restore, so placements are not added to undo/redo;
 * once placed, later marker drags are recorded like any other move.
 */
function placePhoto(id: string, gps: Gps): void {
  const photo = project.byId.get(id);
  if (!photo || photo.kind !== 'jpeg' || photo.gps) return;

  cancelSelectionPrefetch();
  photo.gps = { ...gps };
  photo.writeError = undefined;

  mapView.updateMarker(photo);
  selectOnly(project, id);

  status.setActivity('Saving 1 file…');
  pendingWrite = trackDiskOperation(
    writePhotos([photo], (done, total) => {
      status.setActivity(`Saving ${done}/${total}…`);
    }),
  )
    .then((result) => {
      // A failed write restores gps to null, so rebuild the map to drop the
      // marker that was shown optimistically while the file was saving.
      refreshMap();
      status.setActivity(null);
      if (result.failed > 0) {
        status.setError(`${photo.name} could not be saved.`);
      } else {
        status.setError(null);
      }
    })
    .catch((error) => {
      status.setActivity(null);
      status.setError(message(error));
    });
}

function commitMove(photos: Photo[], startGps: Map<string, Gps>): void {
  if (photos.length === 0) return;
  cancelSelectionPrefetch();

  const historyItems: MoveItem[] = [];
  for (const photo of photos) {
    const before = startGps.get(photo.id);
    if (before && photo.gps) {
      historyItems.push({
        id: photo.id,
        before: { ...before },
        after: { ...photo.gps },
      });
    }
  }

  status.setActivity(`Saving ${photos.length} file(s)…`);
  pendingWrite = trackDiskOperation(
    writePhotos(photos, (done, total) => {
      status.setActivity(`Saving ${done}/${total}…`);
    }),
  )
    .then((result) => {
      const successful = historyItems.filter((item) => {
        const photo = project.byId.get(item.id);
        return photo && !photo.writeError && sameGps(photo.gps, item.after);
      });
      if (successful.length > 0) {
        undoStack.push({ items: successful });
        redoStack.length = 0;
      }

      refreshMap();
      status.setActivity(null);
      if (result.failed > 0) {
        status.setError(`${result.failed} file(s) could not be saved.`);
      } else {
        status.setError(null);
      }
    })
    .catch((error) => {
      status.setActivity(null);
      status.setError(message(error));
    });
}

async function applyHistory(
  operation: MoveOperation,
  which: 'before' | 'after',
): Promise<boolean> {
  const photos: Photo[] = [];

  for (const item of operation.items) {
    const photo = project.byId.get(item.id);
    if (!photo) continue;
    photo.gps = { ...item[which] };
    photo.writeError = undefined;
    photos.push(photo);
  }

  if (photos.length === 0) return true;

  setSelection(project, photos.map((photo) => photo.id));

  // Move the markers immediately, before the disk writes finish.
  refreshMap();

  cancelSelectionPrefetch();
  status.setActivity(`Saving ${photos.length} file(s)…`);
  const result = await trackDiskOperation(
    writePhotos(photos, (done, total) => {
      status.setActivity(`Saving ${done}/${total}…`);
    }),
  );

  refreshMap();
  status.setActivity(null);

  if (result.failed > 0) {
    status.setError(`${result.failed} file(s) could not be saved.`);
    return false;
  }

  status.setError(null);
  return true;
}

async function undo(): Promise<void> {
  if (undoStack.length === 0) return;
  await pendingWrite;

  const operation = undoStack.pop();
  if (!operation) return;

  const job = applyHistory(operation, 'before');
  pendingWrite = job.then(() => undefined);
  const ok = await job;
  if (ok) redoStack.push(operation);
  else undoStack.push(operation);
  render();
}

async function redo(): Promise<void> {
  if (redoStack.length === 0) return;
  await pendingWrite;

  const operation = redoStack.pop();
  if (!operation) return;

  const job = applyHistory(operation, 'after');
  pendingWrite = job.then(() => undefined);
  const ok = await job;
  if (ok) undoStack.push(operation);
  else redoStack.push(operation);
  render();
}

function previewOrder(): Photo[] {
  return [...project.photos].sort((a, b) => {
    return (
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      }) || a.relPath.localeCompare(b.relPath)
    );
  });
}

function openAdjacent(delta: number): void {
  if (!previewPhotoId) return;
  const photos = previewOrder();
  if (photos.length === 0) return;
  const index = photos.findIndex((photo) => photo.id === previewPhotoId);
  if (index < 0) return;
  const next = photos[(index + delta + photos.length) % photos.length];
  void showPreview(next);
}

async function showPreview(photo: Photo): Promise<void> {
  closePreview();
  const generation = ++previewGeneration;
  previewPhotoId = photo.id;

  try {
    const { openPreview } = await import('./preview');
    const handle = await openPreview(photo, () => {
      if (generation !== previewGeneration) return;
      previewGeneration += 1;
      previewClose = null;
      previewPhotoId = null;
    });

    // The preview was closed or replaced while it was loading.
    if (generation !== previewGeneration) {
      handle.close();
      return;
    }
    previewClose = handle.close;
  } catch (error) {
    if (generation !== previewGeneration) return;
    previewPhotoId = null;
    status.setError(message(error));
  }
}

function closePreview(): void {
  previewGeneration += 1;
  const close = previewClose;
  previewClose = null;
  previewPhotoId = null;
  close?.();
}

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const inField =
    !!target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable);

  if (event.key === 'Escape') {
    if (previewPhotoId) {
      closePreview();
      event.preventDefault();
      return;
    }
    if (interactions.handleEsc()) {
      event.preventDefault();
      return;
    }
    if (project.selection.size > 0) {
      clearSelection(project);
      event.preventDefault();
    }
    return;
  }

  if (previewPhotoId) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      openAdjacent(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      openAdjacent(1);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      void deletePreviewedPhoto();
      return;
    }
  }

  if (mapViewEl.hidden) return;

  if (
    !previewPhotoId &&
    !inField &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'l'
  ) {
    event.preventDefault();
    mapView.toggleBaseLayer();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
    if (inField) return;
    event.preventDefault();
    void undo();
    return;
  }

  if (
    (event.ctrlKey || event.metaKey) &&
    (event.key.toLowerCase() === 'y' ||
      (event.shiftKey && event.key.toLowerCase() === 'z'))
  ) {
    if (inField) return;
    event.preventDefault();
    void redo();
    return;
  }

  if (event.key === 'Tab') {
    if (previewPhotoId || inField) return;
    event.preventDefault();
    tool = tool === 'rect' ? 'lasso' : 'rect';
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (previewPhotoId || inField) return;
    event.preventDefault();
    void deleteSelected();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    if (inField) return;
    event.preventDefault();
    selectAll(project);
  }
});

void (async () => {
  const stored = await loadStoredFolder();
  if (stored) {
    storedHandle = stored;
    landing.setStoredName(stored.name);
  }
  render();
})();

void validateArcgisKey().then((check) => {
  if (!check || check.ok || !check.message) return;
  console.error(check.message);
  status.setError(check.message);
});
