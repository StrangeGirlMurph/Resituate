import { hasFileSystemAccess } from './browser';
import type { Project } from './state';
import type { Photo } from './types';
import { formatDateTime, PHOTO_DRAG_TYPE } from './util';

export interface LandingHandlers {
  onOpenFolder: () => void;
  onOpenImages: () => void;
  onReconnect: () => void;
  onBack: () => void;
}

export interface LandingView {
  element: HTMLElement;
  setStoredName: (name?: string) => void;
  setHasProject: (value: boolean) => void;
}

function setupBrowserWarning(element: HTMLElement): void {
  if (hasFileSystemAccess()) return;

  element.hidden = false;

  const title = document.createElement('strong');
  title.textContent = 'This browser cannot edit photos in place';

  const text = document.createElement('p');
  text.textContent =
    'Resituate needs a Chromium based browser with File System Access API support. Try again with Ungoogled-Chromium, Chromium, Chrome, Edge, Opera, Brave, etc.';

  element.append(title, text);
}

export function createLanding(handlers: LandingHandlers): LandingView {
  const element = document.createElement('section');
  element.className = 'landing';
  element.innerHTML = `
    <h1>Resituate - Geotagged Image Cleanup</h1>
    <div id="browser-warning" class="browser-warning" role="alert" hidden></div>
    <p class="lead">
      Open local geotagged JPEGs, delete, preview or see them on a map and correct their GPS coordinates <strong>in place on your local disk</strong>. Supports
      360° equirectangular images. Nothing is uploaded. Mainly built for cleaning up sequences of street-level 360° imagery.
    </p>

    <div class="landing-actions">
      <button id="open-folder" type="button" title="Choose a local folder. Subfolders are scanned recursively.">Open folder…</button>
      <button id="open-images" type="button" title="Select individual JPEG files.">Open images…</button>
      <button id="reconnect" type="button" title="Reconnect to the last folder and restore its files." hidden>Reconnect</button>
      <button id="back-to-map" type="button" title="Return to the current map." hidden>Back to map</button>
    </div>

    <h2>How to use</h2>

    <ol>
      <li><strong>Open a folder</strong> (or individual JPEG images). Subfolders are scanned recursively. Your last folder is remembered so you can reconnect later.</li>
      <li><strong>Review the images.</strong> The sidebar lists images without GPS data or in an unsupported format (.png, .webp, etc.). Drag an image without GPS from the sidebar onto the map to give it a location.</li>
      <li><strong>Select the photos to fix.</strong> Click a marker, or drag a window around several. Add or remove from your selection as needed.</li>
      <li><strong>Move your selection</strong> to a new location to correct for GPS drift. The whole selection moves together, and the new GPS coordinates are written to the files when you release the mouse. Undo/redo moves.</li>
      <li><strong>Clean up.</strong> Delete unwanted files permanently (files are not moved to the system trash).</li>
      <li><strong>Check the result.</strong> Switch layers and zoom or pan to confirm the new positions.</li>
    </ol>

     <p>
      For the complete picture see the Usage section below.
    </p>

    <h2>Notes</h2>
    <ul>
      <li>
        Only <strong>EXIF GPS</strong> is read and written. GPS stored in XMP is
        ignored. If a camera duplicated GPS into XMP, other apps may still show
        the old position.
      </li>
      <li>Only <strong>latitude and longitude</strong> are changed. Altitude and GPS timestamps are preserved.</li>
      <li>Only <strong>JPEG</strong> images are editable because of EXIF metadata limitations. Non-JPEG images are listed as unsupported. They can be selected, deleted, and previewed when the browser can display them.</li>
    </ul>

    <h2>Usage</h2>
    <table>
      <thead><tr><th>Input</th><th>Action</th></tr></thead>
      <tbody>
        <tr class="table-group"><th colspan="2">Mouse</th></tr>
        <tr><td>Left-click a marker</td><td>Preview the image</td></tr>
        <tr><td>Left-click in the sidebar</td><td>Select and preview</td></tr>
        <tr><td>Left-drag a marker</td><td>Move the selected marker(s)</td></tr>
        <tr><td>Left-drag a sidebar row without GPS onto the map</td><td>Set the image's GPS position</td></tr>
        <tr><td>Left-drag on the map</td><td>Select an area</td></tr>
        <tr><td>Right-drag</td><td>Pan the map</td></tr>
        <tr><td>Wheel / double-click</td><td>Zoom in or out</td></tr>

        <tr class="table-group"><th colspan="2">Mouse + keyboard</th></tr>
        <tr><td><kbd>Ctrl/Cmd</kbd> + Left-click in the sidebar</td><td>Toggle selection</td></tr>
        <tr><td><kbd>Shift</kbd> + Left-click in the sidebar</td><td>Shift selects a range</td></tr>
        <tr><td><kbd>Ctrl/Cmd</kbd> + Left-click a marker</td><td>Toggle the marker in the selection</td></tr>
        <tr><td><kbd>Ctrl/Cmd</kbd> + Left-drag on the map</td><td>Toggle every marker in the drawn area</td></tr>

        <tr class="table-group"><th colspan="2">Keyboard</th></tr>
        <tr><td><kbd>Ctrl/Cmd</kbd> + <kbd>A</kbd></td><td>Select all images</td></tr>
        <tr><td><kbd>Tab</kbd></td><td>Switch between rectangle and lasso selection</td></tr>
        <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>Previous / next image while previewing (follows the file names)</td></tr>
        <tr><td><kbd>L</kbd></td><td>Switch between the imagery options</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close the preview, cancel a drag, or clear the selection</td></tr>
        <tr><td><kbd>Delete</kbd> / <kbd>Backspace</kbd></td><td>Delete the selected files from disk. In a preview, delete the current image and show the next</td></tr>
        <tr><td><kbd>Ctrl/Cmd</kbd> + <kbd>Z</kbd></td><td>Undo the last GPS move</td></tr>
        <tr><td><kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> / <kbd>Ctrl</kbd> + <kbd>Y</kbd></td><td>Redo the last GPS move</td></tr>
      </tbody>
    </table>

    <h2>Browser support</h2>
    <p>
      Resituate works only in Chromium based browsers (Ungoogled-Chromium, Chromium, Chrome, Edge, Opera, Brave, etc.), because it relies on the
      <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API"
         target="_blank" rel="noopener noreferrer">File System Access API</a>. It's also really meant to be used on a desktop with a mouse and keyboard. Touch and mobile layouts are not supported.
    </p>

    <h2>Privacy</h2>
    <p>
      Resituate runs entirely in your browser. It's a simple static website hosted on GitHub Pages. No images, GPS coordinates, or
      file contents ever leave your device, and nothing is uploaded or shared.
      It sets no cookies, uses no analytics or tracking, has no accounts, and
      collects no personal data.
    </p>
    <p>
      The only external requests are for map tiles and basemap metadata, which
      load from OpenStreetMap or Esri depending on the selected layer, as they
      would for any embedded map. Your last folder is remembered locally in your
      browser so you can reconnect.
    </p>

    <h2>Feedback</h2>
    <p>
      Please report issues or feature requests over <a href="https://github.com/StrangeGirlMurph/Resituate/issues">GitHub Issues</a> or via <a href="mailto:work@murphy.science">Email</a>.
    </p>

    <footer>Resituate 0.1.0 - <a href="https://github.com/StrangeGirlMurph/Resituate">Source code on GitHub</a></footer>
  `;

  const openFolder = element.querySelector<HTMLButtonElement>('#open-folder')!;
  const openImages = element.querySelector<HTMLButtonElement>('#open-images')!;
  const reconnect = element.querySelector<HTMLButtonElement>('#reconnect')!;
  const back = element.querySelector<HTMLButtonElement>('#back-to-map')!;

  setupBrowserWarning(element.querySelector<HTMLElement>('#browser-warning')!);

  openFolder.addEventListener('click', handlers.onOpenFolder);
  openImages.addEventListener('click', handlers.onOpenImages);
  reconnect.addEventListener('click', handlers.onReconnect);
  back.addEventListener('click', handlers.onBack);

  return {
    element,
    setStoredName(name?: string): void {
      reconnect.hidden = !name;
      reconnect.textContent = name ? `Reconnect to ${name}` : 'Reconnect';
    },
    setHasProject(value: boolean): void {
      back.hidden = !value;
    },
  };
}

export interface ToolbarHandlers {
  onOpenFolder: () => void;
  onOpenImages: () => void;
  onRescan: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onHelp: () => void;
}

export interface ToolbarView {
  element: HTMLElement;
  setHistory: (canUndo: boolean, canRedo: boolean) => void;
}

export function createToolbar(handlers: ToolbarHandlers): ToolbarView {
  const element = document.createElement('div');
  element.className = 'toolbar';
  element.innerHTML = `
    <button id="toolbar-folder" type="button" title="Choose a local folder. Subfolders are scanned recursively. Replaces the current project.">Open folder</button>
    <button id="toolbar-images" type="button" title="Select individual JPEG files. Replaces the current project.">Open images</button>
    <button id="toolbar-rescan" type="button" title="Re-read the source folder/files and refresh positions. Pending GPS writes are saved first.">Rescan</button>
    <button id="toolbar-undo" type="button" title="Undo the last GPS move (Ctrl/Cmd+Z)" disabled>Undo</button>
    <button id="toolbar-redo" type="button" title="Redo the last undone GPS move (Ctrl/Cmd+Shift+Z or Ctrl+Y)" disabled>Redo</button>
    <button id="toolbar-help" type="button" title="Show the help page, shortcuts, and metadata limitations.">Help</button>
    <a class="toolbar-link" href="https://github.com/StrangeGirlMurph/Resituate/issues" target="_blank" rel="noopener noreferrer" title="Report an issue or request a feature.">Feedback</a>
  `;

  element.querySelector<HTMLButtonElement>('#toolbar-folder')!.addEventListener(
    'click',
    handlers.onOpenFolder,
  );
  element.querySelector<HTMLButtonElement>('#toolbar-images')!.addEventListener(
    'click',
    handlers.onOpenImages,
  );
  element.querySelector<HTMLButtonElement>('#toolbar-rescan')!.addEventListener(
    'click',
    handlers.onRescan,
  );
  element.querySelector<HTMLButtonElement>('#toolbar-undo')!.addEventListener(
    'click',
    handlers.onUndo,
  );
  element.querySelector<HTMLButtonElement>('#toolbar-redo')!.addEventListener(
    'click',
    handlers.onRedo,
  );
  element.querySelector<HTMLButtonElement>('#toolbar-help')!.addEventListener(
    'click',
    handlers.onHelp,
  );

  const undoButton = element.querySelector<HTMLButtonElement>('#toolbar-undo')!;
  const redoButton = element.querySelector<HTMLButtonElement>('#toolbar-redo')!;

  return {
    element,
    setHistory(canUndo: boolean, canRedo: boolean): void {
      undoButton.disabled = !canUndo;
      redoButton.disabled = !canRedo;
    },
  };
}

export interface SidebarHandlers {
  onSelectOnly: (id: string) => void;
  onToggle: (id: string) => void;
  onSetSelection: (ids: string[]) => void;
  onToggleMany: (ids: string[]) => void;
  onPreview: (id: string) => void;
}

export interface SidebarView {
  element: HTMLElement;
  render: (project: Project) => void;
}

function byCaptureTime(a: Photo, b: Photo): number {
  const time = a.captureTime.getTime() - b.captureTime.getTime();
  return time || a.relPath.localeCompare(b.relPath);
}

function rangeBetween(ids: string[], from: string, to: string): string[] {
  const start = ids.indexOf(from);
  const end = ids.indexOf(to);
  if (start < 0 || end < 0) return [to];
  const [low, high] = start <= end ? [start, end] : [end, start];
  return ids.slice(low, high + 1);
}

export function createSidebar(handlers: SidebarHandlers): SidebarView {
  const element = document.createElement('aside');
  element.className = 'sidebar';
  let anchorId: string | null = null;

  function render(project: Project): void {
    const scrollTop = element.scrollTop;
    element.innerHTML = '';

    const noGps = project.photos
      .filter((photo) => photo.kind === 'jpeg' && !photo.gps)
      .sort(byCaptureTime);
    const unsupported = project.photos
      .filter((photo) => photo.kind === 'unsupported')
      .sort(byCaptureTime);

    if (noGps.length === 0 && unsupported.length === 0) {
      element.hidden = true;
      element.innerHTML = '';
      return;
    }

    element.hidden = false;

    const renderSection = (title: string, photos: Photo[], canPlace = false): void => {
      if (photos.length === 0) return;
      const section = document.createElement('div');
      section.className = 'sidebar-section';

      const heading = document.createElement('div');
      heading.className = 'sidebar-heading';
      heading.textContent = `${title} (${photos.length})`;
      section.append(heading);

      const sectionIds = photos.map((photo) => photo.id);

      for (const photo of photos) {
        const row = document.createElement('div');
        row.className = 'sidebar-row';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        if (project.selection.has(photo.id)) row.classList.add('selected');
        if (canPlace) {
          row.draggable = true;
          row.classList.add('sidebar-row-draggable');
          row.title = 'Drag onto the map to set a location';
          row.addEventListener('dragstart', (event) => {
            if (!event.dataTransfer) return;
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData(PHOTO_DRAG_TYPE, photo.id);
            event.dataTransfer.setData('text/plain', photo.relPath);
          });
        }

        const path = document.createElement('div');
        path.className = 'sidebar-path';
        path.textContent = photo.relPath;

        const date = document.createElement('div');
        date.className = 'sidebar-date';
        date.textContent = formatDateTime(photo.captureTime);

        row.append(path, date);

        const activate = (event: MouseEvent | KeyboardEvent): void => {
          const ctrl = event.ctrlKey || event.metaKey;
          if (event.shiftKey && anchorId && sectionIds.includes(anchorId)) {
            const range = rangeBetween(sectionIds, anchorId, photo.id);
            if (ctrl) handlers.onToggleMany(range);
            else handlers.onSetSelection(range);
          } else if (ctrl) {
            handlers.onToggle(photo.id);
            anchorId = photo.id;
          } else {
            handlers.onSelectOnly(photo.id);
            anchorId = photo.id;
            handlers.onPreview(photo.id);
          }
        };

        row.addEventListener('click', activate);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(event);
          }
        });

        section.append(row);
      }

      element.append(section);
    };

    renderSection('Without GPS', noGps, true);
    renderSection('Unsupported', unsupported);
    element.scrollTop = scrollTop;
  }

  return { element, render };
}

export interface StatusView {
  element: HTMLElement;
  render: (project: Project) => void;
  setActivity: (value: string | null) => void;
  setError: (value: string | null) => void;
}

export function createStatusBar(): StatusView {
  const element = document.createElement('div');
  element.className = 'statusbar';
  let lastProject: Project | null = null;
  let activity: string | null = null;
  let error: string | null = null;

  function render(project: Project): void {
    lastProject = project;
    const total = project.photos.length;
    const onMap = project.photos.filter((photo) => photo.gps).length;
    const noGps = project.photos.filter(
      (photo) => photo.kind === 'jpeg' && !photo.gps,
    ).length;
    const unsupported = project.photos.filter(
      (photo) => photo.kind === 'unsupported',
    ).length;

    let text = `${total} files · ${onMap} on map · ${noGps} without GPS · ${unsupported} unsupported · ${project.selection.size} selected`;
    if (activity) text += ` · ${activity}`;
    if (error) text += ` · ${error}`;
    element.textContent = text;
  }

  return {
    element,
    render,
    setActivity(value: string | null): void {
      activity = value;
      if (lastProject) render(lastProject);
    },
    setError(value: string | null): void {
      error = value;
      if (lastProject) render(lastProject);
    },
  };
}
