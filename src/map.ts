import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  createBaseLayers,
  createLayerSwitcher,
  type LayerSwitcherControl,
} from './basemaps';
import { crowdColor, neighborCounts } from './density';
import { nearestPointOnPolyline, type Point2D } from './geometry';
import type { Gps, Photo } from './types';
import { clampLat, clampLon, PHOTO_DRAG_TYPE, sameGps } from './util';

export type SelectionTool = 'rect' | 'lasso';
export type MapMode = 'select' | 'line';

export interface MapView {
  map: L.Map;
  setPhotos(photos: Photo[]): void;
  syncSelection(selection: Set<string>): void;
  updateMarker(photo: Photo): void;
  fit(photos: Photo[]): void;
  hitTest(point: L.Point): Photo | null;
  invalidate(): void;
  toggleBaseLayer(): void;
  setLineMode(active: boolean): void;
  setAuxiliaryLine(points: Gps[]): void;
  setAuxiliaryPreview(point: Gps | null): void;
  projectToAuxiliaryLine(gps: Gps): Gps | null;
}

const DEFAULT_CROWD_RADIUS = 3;
const MAX_CROWD_RADIUS = 10_000;

const MARKER_STYLE: L.CircleMarkerOptions = {
  radius: 6,
  color: '#ffffff',
  weight: 1,
  fillColor: crowdColor(0),
  fillOpacity: 1,
};

const SELECTION_STYLE: L.PolylineOptions = {
  color: '#1f6feb',
  weight: 1.5,
  dashArray: '5 3',
  fillOpacity: 0.08,
  interactive: false,
};

const SERIES_STYLE: L.PolylineOptions = {
  color: '#1f6feb',
  weight: 1,
  opacity: 0.7,
  pane: 'series',
  interactive: false,
};

const AUXILIARY_LINE_STYLE: L.PolylineOptions = {
  color: '#2b7a3d',
  weight: 3,
  opacity: 0.95,
  dashArray: '8 5',
  pane: 'auxiliary',
  interactive: false,
};

const AUXILIARY_POINT_STYLE: L.CircleMarkerOptions = {
  radius: 4,
  color: '#ffffff',
  weight: 1,
  fillColor: '#2b7a3d',
  fillOpacity: 1,
  pane: 'auxiliary',
  interactive: false,
};

// The segment from the last node to the cursor, shown while drawing.
const AUXILIARY_PREVIEW_STYLE: L.PolylineOptions = {
  color: '#2b7a3d',
  weight: 2,
  opacity: 0.5,
  dashArray: '4 6',
  pane: 'auxiliary',
  interactive: false,
};

// Project into Web Mercator at a fixed, high zoom so the snapping maths is
// independent of the current map view.
const PROJECTION_ZOOM = 20;

// Web Mercator's maximum extent. Keeping the map inside it (and starting the
// minimum zoom at the level where the world fills the viewport) prevents
// zooming or panning out into empty space.
const WORLD_BOUNDS = L.latLngBounds([
  [-85.05112878, -180],
  [85.05112878, 180],
]);

function createCrowdRadiusControl(
  initialRadius: number,
  onChange: (radius: number) => void,
): L.Control {
  const control = new L.Control({ position: 'topright' });

  control.onAdd = (): HTMLElement => {
    const container = L.DomUtil.create('div', 'leaflet-control crowd-radius');
    container.title =
      'Markers are coloured by how many other photos are within this distance: blue is sparse, red is crowded.';

    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = 'Crowdedness radius';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.1';
    input.max = String(MAX_CROWD_RADIUS);
    input.step = '0.5';
    input.value = String(initialRadius);
    input.setAttribute('aria-label', 'Crowdedness radius in meters');
    input.title = 'Distance in meters used to count nearby photos.';

    const unit = document.createElement('span');
    unit.textContent = 'm';

    let currentRadius = initialRadius;

    function readRadius(): number | null {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0) return null;
      return Math.min(value, MAX_CROWD_RADIUS);
    }

    input.addEventListener('input', () => {
      const value = readRadius();
      if (value === null) return;
      currentRadius = value;
      onChange(value);
    });

    input.addEventListener('change', () => {
      const value = readRadius();
      if (value !== null) currentRadius = value;
      input.value = String(currentRadius);
      onChange(currentRadius);
    });

    // Escape would otherwise clear the selection. Other shortcuts are already
    // ignored globally while an input has focus.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.blur();
        event.stopPropagation();
      }
    });

    label.append(text, input, unit);
    container.append(label);

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  };

  return control;
}

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
  L.control
    .scale({ position: 'bottomright', imperial: false, maxWidth: 110 })
    .addTo(map);
  baseLayers[0].layer.addTo(map);
  const seriesPane = map.createPane('series');
  seriesPane.style.zIndex = '390';
  const auxiliaryPane = map.createPane('auxiliary');
  auxiliaryPane.style.zIndex = '395';

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

  const series = L.layerGroup().addTo(map);
  const layer = L.layerGroup().addTo(map);
  const auxiliaryLine = L.layerGroup().addTo(map);
  const auxiliaryPreview = L.polyline([], AUXILIARY_PREVIEW_STYLE).addTo(map);
  let auxiliaryPoints: L.LatLng[] = [];
  let auxiliaryProjected: Point2D[] = [];
  const markers = new Map<string, L.CircleMarker>();
  const photosById = new Map<string, Photo>();
  const seriesLines = new Map<string, L.Polyline>();
  let seriesFrame: number | undefined;
  let selection = new Set<string>();
  let crowdRadius = DEFAULT_CROWD_RADIUS;
  let neighborCountsById = new Map<string, number>();
  let densityTimer: number | undefined;

  function seriesKey(photo: Photo): string {
    const separator = photo.relPath.lastIndexOf('/');
    return separator >= 0 ? photo.relPath.slice(0, separator) : '';
  }

  function byCaptureTime(a: Photo, b: Photo): number {
    return (
      a.captureTime.getTime() - b.captureTime.getTime() ||
      a.relPath.localeCompare(b.relPath)
    );
  }

  /**
   * Rebuild the path of every folder's sequence. Capture time gives the order,
   * so a series does not depend on lexicographic file names (IMG_10 would come
   * before IMG_2). Existing polylines are updated in place so live marker
   * dragging does not recreate the whole series layer on every pointer move.
   */
  function syncSeries(): void {
    const photosByDirectory = new Map<string, Photo[]>();
    for (const photo of photosById.values()) {
      if (!photo.gps) continue;
      const key = seriesKey(photo);
      const photos = photosByDirectory.get(key);
      if (photos) photos.push(photo);
      else photosByDirectory.set(key, [photo]);
    }

    for (const [key, photos] of photosByDirectory) {
      const line = seriesLines.get(key);
      if (photos.length < 2) {
        if (line) {
          series.removeLayer(line);
          seriesLines.delete(key);
        }
        continue;
      }
      photos.sort(byCaptureTime);
      const points = photos.map(
        (photo) => [photo.gps!.lat, photo.gps!.lon] as [number, number],
      );
      if (line) line.setLatLngs(points);
      else seriesLines.set(key, L.polyline(points, SERIES_STYLE).addTo(series));
    }

    for (const [key, line] of seriesLines) {
      if (photosByDirectory.has(key)) continue;
      series.removeLayer(line);
      seriesLines.delete(key);
    }
  }

  /**
   * Coalesce the per-photo `updateMarker` calls made while dragging a
   * selection into one series rebuild per animation frame.
   */
  function scheduleSeriesSync(): void {
    if (seriesFrame !== undefined) return;
    seriesFrame = requestAnimationFrame(() => {
      seriesFrame = undefined;
      syncSeries();
    });
  }

  function setAuxiliaryLine(points: Gps[]): void {
    auxiliaryLine.clearLayers();
    auxiliaryPoints = points.map((point) => L.latLng(point.lat, point.lon));
    auxiliaryProjected = auxiliaryPoints.map((point) => {
      const projected = map.project(point, PROJECTION_ZOOM);
      return { x: projected.x, y: projected.y };
    });

    if (auxiliaryPoints.length > 1) {
      L.polyline(auxiliaryPoints, AUXILIARY_LINE_STYLE).addTo(auxiliaryLine);
    }
    for (const point of auxiliaryPoints) {
      L.circleMarker(point, AUXILIARY_POINT_STYLE).addTo(auxiliaryLine);
    }
  }

  function setAuxiliaryPreview(point: Gps | null): void {
    if (!point || auxiliaryPoints.length === 0) {
      auxiliaryPreview.setLatLngs([]);
      return;
    }
    const last = auxiliaryPoints[auxiliaryPoints.length - 1];
    auxiliaryPreview.setLatLngs([last, L.latLng(point.lat, point.lon)]);
  }

  function projectToAuxiliaryLine(gps: Gps): Gps | null {
    if (auxiliaryProjected.length === 0) return null;
    const projected = map.project(L.latLng(gps.lat, gps.lon), PROJECTION_ZOOM);
    const nearest = nearestPointOnPolyline(
      { x: projected.x, y: projected.y },
      auxiliaryProjected,
    );
    if (!nearest) return null;
    const latLng = map.unproject(L.point(nearest.x, nearest.y), PROJECTION_ZOOM);
    return { lat: clampLat(latLng.lat), lon: clampLon(latLng.lng) };
  }

  function setLineMode(active: boolean): void {
    container.classList.toggle('line-mode', active);
    if (active) {
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
      setAuxiliaryPreview(null);
    }
  }

  function markerStyle(id: string): L.CircleMarkerOptions {
    const selected = selection.has(id);
    return {
      fillColor: selected ? '#e0a020' : crowdColor(neighborCountsById.get(id) ?? 0),
      // Selected markers replace the density colour with the selection orange;
      // unselected markers keep their crowding colour.
      color: '#ffffff',
      weight: 1,
    };
  }

  function applyMarkerStyle(id: string, marker: L.CircleMarker): void {
    marker.setStyle(markerStyle(id));
  }

  function applyMarkerStyles(): void {
    for (const [id, marker] of markers) applyMarkerStyle(id, marker);
  }

  function recomputeDensity(): void {
    const previousCounts = neighborCountsById;
    const nextCounts = neighborCounts([...photosById.values()], crowdRadius);
    neighborCountsById = nextCounts;
    for (const [id, count] of nextCounts) {
      if ((previousCounts.get(id) ?? 0) === count) continue;
      const marker = markers.get(id);
      if (marker) applyMarkerStyle(id, marker);
    }
  }

  function cancelDensitySync(): void {
    if (densityTimer === undefined) return;
    window.clearTimeout(densityTimer);
    densityTimer = undefined;
  }

  /**
   * Density is a review aid, not something that must keep up with every pixel
   * of a drag. Debouncing keeps a large selection from recomputing the whole
   * neighbourhood graph on every pointer move; the colours catch up as soon as
   * movement pauses.
   */
  function scheduleDensitySync(): void {
    cancelDensitySync();
    densityTimer = window.setTimeout(() => {
      densityTimer = undefined;
      recomputeDensity();
    }, 120);
  }

  function applyCrowdRadius(radius: number): void {
    if (!Number.isFinite(radius) || radius <= 0) return;
    crowdRadius = Math.min(radius, MAX_CROWD_RADIUS);
    cancelDensitySync();
    recomputeDensity();
  }

  function addMarker(photo: Photo): void {
    if (!photo.gps) return;
    const marker = L.circleMarker(
      [photo.gps.lat, photo.gps.lon],
      { ...MARKER_STYLE, ...markerStyle(photo.id) },
    )
      .bindTooltip(photo.name, { direction: 'top', offset: [0, -6] })
      .addTo(layer);
    markers.set(photo.id, marker);
  }

  const crowdRadiusControl = createCrowdRadiusControl(
    DEFAULT_CROWD_RADIUS,
    applyCrowdRadius,
  );
  crowdRadiusControl.addTo(map);

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
      if (seriesFrame !== undefined) {
        cancelAnimationFrame(seriesFrame);
        seriesFrame = undefined;
      }
      cancelDensitySync();
      recomputeDensity();
      syncSeries();
    },

    syncSelection(nextSelection: Set<string>): void {
      selection = nextSelection;
      applyMarkerStyles();
    },

    updateMarker(photo: Photo): void {
      photosById.set(photo.id, photo);
      const marker = markers.get(photo.id);
      if (!photo.gps) {
        if (marker) {
          layer.removeLayer(marker);
          markers.delete(photo.id);
        }
        scheduleSeriesSync();
        scheduleDensitySync();
        return;
      }
      if (marker) {
        marker.setLatLng([photo.gps.lat, photo.gps.lon]);
      } else {
        addMarker(photo);
      }
      scheduleSeriesSync();
      scheduleDensitySync();
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

    setLineMode,
    setAuxiliaryLine,
    setAuxiliaryPreview,
    projectToAuxiliaryLine,
  };
}

interface InteractionOptions {
  view: MapView;
  photos: () => Photo[];
  selection: () => Set<string>;
  tool: () => SelectionTool;
  mode: () => MapMode;
  onAddLinePoint: (gps: Gps) => void;
  onLinePreview: (gps: Gps | null) => void;
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

    if (options.mode() === 'line') {
      const latLng = map.containerPointToLatLng(containerPoint(container, event));
      options.onAddLinePoint({
        lat: clampLat(latLng.lat),
        lon: clampLon(latLng.lng),
      });
      // The new node sits under the cursor; the preview catches up on the next
      // pointer move.
      options.onLinePreview(null);
      event.preventDefault();
      return;
    }

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
    if (state.kind === 'pan') {
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      map.panBy([-dx, -dy], { animate: false });
      state.x = event.clientX;
      state.y = event.clientY;
      event.preventDefault();
      return;
    }

    if (state.kind === 'idle' && options.mode() === 'line') {
      const latLng = map.containerPointToLatLng(containerPoint(container, event));
      options.onLinePreview({
        lat: clampLat(latLng.lat),
        lon: clampLon(latLng.lng),
      });
      return;
    }

    if (state.kind === 'idle') return;

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

  function onPointerLeave(): void {
    if (options.mode() === 'line') options.onLinePreview(null);
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerCancel);
  container.addEventListener('pointerleave', onPointerLeave);
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
