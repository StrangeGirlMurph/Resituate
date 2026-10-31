import type { Photo } from './types';
import { formatCoord, formatDateTime, formatSize } from './util';

export interface PreviewHandle {
  close: () => void;
}

export async function openPreview(
  photo: Photo,
  onClose: () => void,
): Promise<PreviewHandle> {
  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'preview';
  let ratio = photo.is360
    ? 2
    : photo.width > 0 && photo.height > 0
      ? photo.width / photo.height
      : 1.5;

  const header = document.createElement('div');
  header.className = 'preview-header';

  const heading = document.createElement('div');
  heading.className = 'preview-heading';

  const title = document.createElement('div');
  title.className = 'preview-title';
  title.textContent = photo.relPath;

  const meta = document.createElement('div');
  meta.className = 'preview-meta';
  const parts = [
    formatDateTime(photo.captureTime),
    photo.gps ? formatCoord(photo.gps.lat, photo.gps.lon) : 'without GPS',
    formatSize(photo.sizeBytes),
  ];
  if (photo.is360) parts.push('360°');
  meta.textContent = parts.join(' · ');

  heading.append(title, meta);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'preview-close';
  closeButton.title = 'Close preview (Esc)';
  closeButton.setAttribute('aria-label', 'Close preview (Esc)');
  closeButton.textContent = 'Close (Esc)';

  header.append(heading, closeButton);

  const body = document.createElement('div');
  body.className = 'preview-body';
  body.textContent = 'Loading…';

  panel.append(header, body);
  overlay.append(panel);
  document.body.append(overlay);

  const updateSize = (): void => {
    const maxWidth = window.innerWidth * 0.88;
    const maxHeight = window.innerHeight * 0.88;
    const headerHeight = header.getBoundingClientRect().height || 64;
    const width = Math.min(maxWidth, (maxHeight - headerHeight) * ratio);
    const height = width / ratio + headerHeight;
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  };

  updateSize();
  window.addEventListener('resize', updateSize);

  let viewer: PannellumViewer | null = null;
  let url: string | null = null;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('resize', updateSize);
    try {
      viewer?.destroy();
    } catch {
      // Pannellum can throw if it is destroyed before it finishes loading.
    }
    viewer = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
    overlay.remove();
    onClose();
  };

  closeButton.addEventListener('click', close);

  try {
    const file = await photo.handle.getFile();
    if (closed) return { close };
    url = URL.createObjectURL(file);

    if (photo.is360) {
      await import('pannellum');
      await import('pannellum/build/pannellum.css');
      if (closed) return { close };

      if (!window.pannellum) {
        body.textContent = 'Pannellum failed to load.';
        return { close };
      }

      body.textContent = '';
      viewer = window.pannellum.viewer(body, {
        type: 'equirectangular',
        panorama: url,
        autoLoad: true,
        hfov: 120,
        minHfov: 50,
        maxHfov: 140,
        ignoreGPanoXMP: true,
        showControls: false,
        showFullscreenCtrl: false,
        showZoomCtrl: false,
        compass: false,
        mouseZoom: true,
        disableKeyboardCtrl: true,
        backgroundColor: [0, 0, 0],
      });
      viewer.on('error', () => {
        body.textContent = 'Could not load the panorama.';
      });
    } else {
      const image = document.createElement('img');
      image.alt = photo.name;
      image.onload = () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          ratio = image.naturalWidth / image.naturalHeight;
          updateSize();
        }
      };
      image.onerror = () => {
        body.textContent = 'This image cannot be displayed in the browser.';
      };
      image.src = url;
      body.textContent = '';
      body.append(image);
    }
  } catch (error) {
    body.textContent =
      error instanceof Error ? `Could not load the image: ${error.message}` : 'Could not load the image.';
  }

  return { close };
}
