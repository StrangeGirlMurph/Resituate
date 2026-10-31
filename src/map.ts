import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  createBaseLayers,
  createLayerSwitcher,
  type LayerSwitcherControl,
} from './basemaps';
import type { Gps, Photo } from './types';
import { clampLat, clampLon, PHOTO_DRAG_TYPE, sameGps } from './util';

export type SelectionTool = 'rect' | 'lasso';

export interface MapView {
  map: L.Map;
  setPhotos(photos: Photo[]): void;
  syncSelection(selection: Set<string>): void;
  updateMarker(photo: Photo): void;
  fit(photos: Photo[]): void;
  hitTest(point: L.Point): Photo | null;
  invalidate(): void;
  toggleBaseLayer(): void;
}

const MARKER_STYLE: L.CircleMarkerOptions = {
  radius: 6,
  color: '#ffffff',
  weight: 1,
  fillColor: '#1f6feb',
  fillOpacity: 1,
};

const SELECTION_STYLE: L.PolylineOptions = {
  color: '#1f6feb',
  weight: 1.5,
  dashArray: '5 3',
  fillOpacity: 0.08,
  interactive: false,
};

// Web Mercator's maximum extent. Keeping the map inside it (and starting the
// minimum zoom at the level where the world fills the viewport) prevents
// zooming or panning out into empty space.
const WORLD_BOUNDS = L.latLngBounds([
  [-85.05112878, -180],
  [85.05112878, 180],
]);

export function createMapView(container: HTMLElement): MapView {
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    boxZoom: false,
    keyboard: false,
    doubleClickZoom: true,
    scrollWheelZoom: true,
    maxBounds: WORLD_BOUNDS,
    maxBoundsViscosity: 1,
    maxZoom: 22,
  });

  const baseLayers = createBaseLayers();
  L.control.attribution({ position: 'bottomright' }).addTo(map);
  baseLayers[0].layer.addTo(map);

  let layerSwitcher: LayerSwitcherControl | null = null;
  if (baseLayers.length > 1) {
    layerSwitcher = createLayerSwitcher(baseLayers, baseLayers[0].id);
    layerSwitcher.addTo(map);
  }

  map.setView([0, 0], 2);

  function syncMinZoom(): void {
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return;
    // getBoundsZoom clamps to the current minZoom, so reset it first to allow
    // the limit to drop again when the window is made smaller.
    map.setMinZoom(0);
    map.setMinZoom(map.getBoundsZoom(WORLD_BOUNDS, true));
  }

  syncMinZoom();
  map.on('resize', syncMinZoom);

  const layer = L.layerGroup().addTo(map);
  const markers = new Map<string, L.CircleMarker>();
  const photosById = new Map<string, Photo>();

  function addMarker(photo: Photo): void {
    if (!photo.gps) return;
    const marker = L.circleMarker([photo.gps.lat, photo.gps.lon], MARKER_STYLE)
      .bindTooltip(photo.name, { direction: 'top', offset: [0, -6] })
      .addTo(layer);
    markers.set(photo.id, marker);
  }

  return {
    map,

    setPhotos(photos: Photo[]): void {
      layer.clearLayers();
      markers.clear();
      photosById.clear();
      for (const photo of photos) {
        photosById.set(photo.id, photo);
        addMarker(photo);
      }
    },

    syncSelection(selection: Set<string>): void {
      for (const [id, marker] of markers) {
        marker.setStyle({ fillColor: selection.has(id) ? '#e0a020' : '#1f6feb' });
      }
    },

    updateMarker(photo: Photo): void {
      photosById.set(photo.id, photo);
      const marker = markers.get(photo.id);
      if (!photo.gps) {
        if (marker) {
          layer.removeLayer(marker);
          markers.delete(photo.id);
        }
        return;
      }
      if (marker) {
        marker.setLatLng([photo.gps.lat, photo.gps.lon]);
      } else {
        addMarker(photo);
      }
    },

    fit(photos: Photo[]): void {
      const geotagged = photos.filter((photo) => photo.gps);
      if (geotagged.length === 0) {
        map.setView([0, 0], 2);
        return;
      }
      if (geotagged.length === 1) {
        const { lat, lon } = geotagged[0].gps!;
        map.setView([lat, lon], 18);
        return;
      }
      map.fitBounds(
        L.latLngBounds(geotagged.map((photo) => [photo.gps!.lat, photo.gps!.lon])),
        { padding: [40, 40], maxZoom: 16 },
      );
    },

    hitTest(point: L.Point): Photo | null {
      let closest: Photo | null = null;
      let closestDistance = 10;
      for (const photo of photosById.values()) {
        if (!photo.gps) continue;
        const markerPoint = map.latLngToContainerPoint([photo.gps.lat, photo.gps.lon]);
        const distance = markerPoint.distanceTo(point);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = photo;
        }
      }
      return closest;
    },

    invalidate(): void {
      map.invalidateSize();
      syncMinZoom();
    },

    toggleBaseLayer(): void {
      layerSwitcher?.toggle();
    },
  };
}

interface InteractionOptions {
  view: MapView;
  photos: () => Photo[];
  selection: () => Set<string>;
  tool: () => SelectionTool;
  onSelectOnly: (id: string) => void;
  onToggle: (id: string) => void;
  onSetSelection: (ids: string[]) => void;
  onToggleMany: (ids: string[]) => void;
  onPreview: (photo: Photo) => void;
  onMoveCommit: (photos: Photo[], before: Map<string, Gps>) => void;
  onLiveMove: (photos: Photo[]) => void;
  onPhotoDrop: (id: string, gps: Gps) => void;
}

type InteractionState =
  | { kind: 'idle' }
  | { kind: 'pan'; x: number; y: number; pointerId: number }
  | {
      kind: 'pressing';
      photo: Photo;
      start: L.Point;
      x: number;
      y: number;
      pointerId: number;
    }
  | {
      kind: 'pressing-empty';
      start: L.Point;
      ctrl: boolean;
      x: number;
      y: number;
      pointerId: number;
    }
  | {
      kind: 'window';
      start: L.Point;
      current: L.Point;
      ctrl: boolean;
      tool: SelectionTool;
      points: L.Point[];
      shape: L.Rectangle | L.Polygon;
      pointerId: number;
    }
  | {
      kind: 'move';
      start: L.LatLng;
      startGps: Map<string, Gps>;
      moved: Photo[];
      pointerId: number;
    };

function containerPoint(container: HTMLElement, event: MouseEvent): L.Point {
  const rect = container.getBoundingClientRect();
  return L.point(event.clientX - rect.left, event.clientY - rect.top);
}

function isPhotoDrag(event: DragEvent): boolean {
  return !!event.dataTransfer && event.dataTransfer.types.includes(PHOTO_DRAG_TYPE);
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.leaflet-control');
}

function pointInPolygon(points: L.Point[], point: L.Point): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function createInteractions(
  container: HTMLElement,
  options: InteractionOptions,
): { handleEsc: () => boolean } {
  const { view } = options;
  const map = view.map;
  let state: InteractionState = { kind: 'idle' };

  function capture(pointerId: number): void {
    try {
      container.setPointerCapture(pointerId);
    } catch {
      // Best effort.
    }
  }

  function release(pointerId: number): void {
    try {
      container.releasePointerCapture(pointerId);
    } catch {
      // Best effort.
    }
  }

  function reset(): void {
    state = { kind: 'idle' };
  }

  function updateWindow(): void {
    if (state.kind !== 'window') return;
    if (state.tool === 'rect') {
      (state.shape as L.Rectangle).setBounds(
        L.latLngBounds(
          map.containerPointToLatLng(state.start),
          map.containerPointToLatLng(state.current),
        ),
      );
    } else {
      (state.shape as L.Polygon).setLatLngs(
        state.points.map((point) => map.containerPointToLatLng(point)),
      );
    }
  }

  function selectionIds(): string[] {
    if (state.kind !== 'window') return [];
    const result: string[] = [];
    for (const photo of options.photos()) {
      if (!photo.gps) continue;
      const point = map.latLngToContainerPoint([photo.gps.lat, photo.gps.lon]);
      const inside =
        state.tool === 'rect'
          ? point.x >= Math.min(state.start.x, state.current.x) &&
            point.x <= Math.max(state.start.x, state.current.x) &&
            point.y >= Math.min(state.start.y, state.current.y) &&
            point.y <= Math.max(state.start.y, state.current.y)
          : pointInPolygon(state.points, point);
      if (inside) result.push(photo.id);
    }
    return result;
  }

  function cancel(): void {
    if (state.kind === 'window') {
      map.removeLayer(state.shape);
    }
    if (state.kind === 'move') {
      for (const [id, gps] of state.startGps) {
        const photo = options.photos().find((item) => item.id === id);
        if (photo) photo.gps = { ...gps };
      }
      options.onLiveMove(state.moved);
    }
    if (state.kind !== 'idle') release(state.pointerId);
    reset();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button === 2) {
      state = { kind: 'pan', x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      capture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (event.button !== 0 || isControl(event.target)) return;

    const point = containerPoint(container, event);
    const photo = view.hitTest(point);
    const ctrl = event.ctrlKey || event.metaKey;

    if (photo) {
      if (ctrl) {
        options.onToggle(photo.id);
        return;
      }
      if (!options.selection().has(photo.id)) options.onSelectOnly(photo.id);
      state = {
        kind: 'pressing',
        photo,
        start: point,
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
      capture(event.pointerId);
      return;
    }

    state = {
      kind: 'pressing-empty',
      start: point,
      ctrl,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
    };
    capture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (state.kind === 'idle') return;

    if (state.kind === 'pan') {
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      map.panBy([-dx, -dy], { animate: false });
      state.x = event.clientX;
      state.y = event.clientY;
      event.preventDefault();
      return;
    }

    if (state.kind === 'pressing') {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) <= 4) return;
      const selected = options
        .photos()
        .filter((photo) => options.selection().has(photo.id) && photo.gps);
      if (selected.length === 0) {
        reset();
        return;
      }
      state = {
        kind: 'move',
        start: map.containerPointToLatLng(state.start),
        startGps: new Map(selected.map((photo) => [photo.id, { ...photo.gps! }])),
        moved: selected,
        pointerId: state.pointerId,
      };
    }

    if (state.kind === 'pressing-empty') {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) <= 4) return;
      const tool = options.tool();
      const startLatLng = map.containerPointToLatLng(state.start);
      const shape =
        tool === 'rect'
          ? L.rectangle(L.latLngBounds(startLatLng, startLatLng), SELECTION_STYLE).addTo(map)
          : L.polygon([startLatLng], SELECTION_STYLE).addTo(map);
      state = {
        kind: 'window',
        start: state.start,
        current: state.start,
        ctrl: state.ctrl,
        tool,
        points: [state.start],
        shape,
        pointerId: state.pointerId,
      };
    }

    if (state.kind === 'window') {
      state.current = containerPoint(container, event);
      if (state.tool === 'lasso') state.points.push(state.current);
      updateWindow();
      event.preventDefault();
      return;
    }

    if (state.kind === 'move') {
      const startGps = state.startGps;
      const current = map.containerPointToLatLng(containerPoint(container, event));
      const deltaLat = current.lat - state.start.lat;
      const deltaLon = current.lng - state.start.lng;
      for (const [id, gps] of startGps) {
        const photo = options.photos().find((item) => item.id === id);
        if (!photo) continue;
        photo.gps = {
          lat: clampLat(gps.lat + deltaLat),
          lon: clampLon(gps.lon + deltaLon),
        };
      }
      const moved = options.photos().filter((photo) => startGps.has(photo.id));
      options.onLiveMove(moved);
      event.preventDefault();
    }
  }

  function onPointerUp(): void {
    if (state.kind === 'pressing') {
      options.onPreview(state.photo);
      release(state.pointerId);
      reset();
      return;
    }

    if (state.kind === 'pressing-empty') {
      // A plain click on empty map clears the selection, matching Esc.
      // Modifier-clicks are reserved for additive selection.
      if (!state.ctrl) options.onSetSelection([]);
      release(state.pointerId);
      reset();
      return;
    }

    if (state.kind === 'window') {
      const ids = selectionIds();
      if (state.ctrl) options.onToggleMany(ids);
      else options.onSetSelection(ids);
      map.removeLayer(state.shape);
      release(state.pointerId);
      reset();
      return;
    }

    if (state.kind === 'move') {
      // Commit only this drag's selection and only photos that actually moved.
      // Do not sweep in positions left over from an earlier save in progress.
      const moved = state.moved;
      const startGps = state.startGps;
      const changed = moved.filter((photo) => {
        const before = startGps.get(photo.id);
        return !!photo.gps && !!before && !sameGps(photo.gps, before);
      });
      options.onMoveCommit(changed, new Map(startGps));
      release(state.pointerId);
      reset();
      return;
    }

    if (state.kind === 'pan') {
      release(state.pointerId);
      reset();
    }
  }

  function onPointerCancel(): void {
    cancel();
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }

  function onDragOver(event: DragEvent): void {
    if (!isPhotoDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    container.classList.add('map-drop-target');
  }

  function onDragLeave(event: DragEvent): void {
    if (!isPhotoDrag(event)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && container.contains(next)) return;
    container.classList.remove('map-drop-target');
  }

  function onDrop(event: DragEvent): void {
    container.classList.remove('map-drop-target');
    if (!isPhotoDrag(event)) return;
    event.preventDefault();
    const id = event.dataTransfer?.getData(PHOTO_DRAG_TYPE);
    if (!id) return;
    const latLng = map.containerPointToLatLng(containerPoint(container, event));
    options.onPhotoDrop(id, {
      lat: clampLat(latLng.lat),
      lon: clampLon(latLng.lng),
    });
  }

  /** Clears the highlight when a drag is cancelled without leaving the map. */
  function onDocumentDragEnd(): void {
    container.classList.remove('map-drop-target');
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerCancel);
  container.addEventListener('contextmenu', onContextMenu);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  document.addEventListener('dragend', onDocumentDragEnd);

  return {
    handleEsc(): boolean {
      if (state.kind === 'idle') return false;
      cancel();
      return true;
    },
  };
}
