import * as L from 'leaflet';

export type BaseLayerId = 'osm' | 'arcgis';

export interface BaseLayerOption {
  id: BaseLayerId;
  label: string;
  layer: L.TileLayer;
}

export interface LayerSwitcherControl extends L.Control {
  toggle: () => void;
}

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';

const ARCGIS_ATTRIBUTION =
  '<a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Powered by Esri</a> | ' +
  'Source: Esri, Vantor, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, ' +
  'AeroGRID, IGN, and the GIS User Community';

const ARCGIS_KEY = (import.meta.env.VITE_ARCGIS_KEY ?? '').trim();

// World Imagery is the raster base layer of the documented ArcGIS:Imagery
// basemap style. Esri's style JSON references this exact service, so the app
// uses it directly to get pure satellite imagery without the gray label/street
// overlay that the style's reference layer adds.
// https://developers.arcgis.com/rest/basemap-styles/
const ARCGIS_IMAGERY_URL =
  'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// This endpoint validates the key (HTTP 401 / code 498 for a bad key) and is
// what the app uses to confirm the key is authorized before offering the layer.
const ARCGIS_STYLE_URL =
  'https://basemaps-api.arcgis.com/arcgis/rest/services/styles/ArcGIS:Imagery';

export function createBaseLayers(): BaseLayerOption[] {
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    // OSM has native tiles up to zoom 19. Allow closer zooms by scaling those
    // tiles instead of stopping at the native limit.
    maxZoom: 22,
    maxNativeZoom: 19,
    attribution: OSM_ATTRIBUTION,
    className: 'tile-256',
  });

  const options: BaseLayerOption[] = [
    {
      id: 'osm',
      label: 'OpenStreetMap',
      layer: osm,
    },
  ];

  if (ARCGIS_KEY) {
    const arcgis = L.tileLayer(
      `${ARCGIS_IMAGERY_URL}?token=${encodeURIComponent(ARCGIS_KEY)}`,
      {
        maxZoom: 22,
        crossOrigin: true,
        attribution: ARCGIS_ATTRIBUTION,
        className: 'tile-256',
      },
    );

    let reportedTileError = false;
    arcgis.on('tileerror', () => {
      if (reportedTileError) return;
      reportedTileError = true;
      console.error(
        'ArcGIS satellite tiles failed to load. VITE_ARCGIS_KEY is being sent, ' +
          'but the World Imagery service rejected it. Check that the key is valid, ' +
          'has the premium:user:basemaps privilege, and allows this page as a referrer. ' +
          `Tiles are requested from ${ARCGIS_IMAGERY_URL}.`,
      );
    });

    options.push({
      id: 'arcgis',
      label: 'Satellite imagery',
      layer: arcgis,
    });
  } else if (import.meta.env.DEV) {
    console.warn(
      'VITE_ARCGIS_KEY is not set; the ArcGIS satellite imagery layer is disabled.',
    );
  }

  return options;
}

export interface ArcgisKeyCheck {
  ok: boolean;
  message?: string;
}

/**
 * Ask the ArcGIS Basemap Styles service to authorize the key. This endpoint
 * validates the token (HTTP 401 / code 498 for a bad key), unlike the
 * World_Imagery tile endpoint itself, which will serve tiles for any non-empty
 * token. It returns Esri's ArcGIS:Imagery web map, whose base layer is the
 * World Imagery service used by the satellite layer.
 */
export async function validateArcgisKey(): Promise<ArcgisKeyCheck | null> {
  if (!ARCGIS_KEY) return null;

  const url = `${ARCGIS_STYLE_URL}?type=webmap&token=${encodeURIComponent(ARCGIS_KEY)}`;
  try {
    const response = await fetch(url);
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: number; message?: string } }
      | null;
    if (response.ok && body && !body.error) return { ok: true };

    const code = body?.error?.code ?? response.status;
    const detail = body?.error?.message ?? response.statusText;
    return {
      ok: false,
      message:
        `ArcGIS rejected VITE_ARCGIS_KEY (${code}: ${detail}). ` +
        'Create a key with the premium:user:basemaps privilege and matching referrers.',
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not verify VITE_ARCGIS_KEY: ${String(error)}`,
    };
  }
}

export function createLayerSwitcher(
  options: BaseLayerOption[],
  initialId: BaseLayerId,
): LayerSwitcherControl {
  const control = new L.Control({ position: 'topright' }) as LayerSwitcherControl;
  let menuId = 0;
  let toggleImpl: (() => void) | null = null;
  control.toggle = () => toggleImpl?.();

  control.onAdd = (map: L.Map): HTMLElement => {
    const container = L.DomUtil.create('div', 'leaflet-control layer-switcher');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layer-switcher-toggle';
    button.textContent = 'Layers';
    button.title = 'Choose basemap (L)';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-keyshortcuts', 'L');

    const menu = document.createElement('div');
    menu.className = 'layer-switcher-menu';
    menu.hidden = true;
    menu.id = `layer-switcher-menu-${++menuId}`;
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Basemap');
    button.setAttribute('aria-controls', menu.id);

    let selectedId = initialId;
    const inputs = new Map<BaseLayerId, HTMLInputElement>();

    function closeMenu(): void {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }

    function openMenu(): void {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      const checked = menu.querySelector<HTMLInputElement>('input:checked');
      checked?.focus();
    }

    function select(id: BaseLayerId, focusButton = true): void {
      if (id === selectedId) {
        closeMenu();
        return;
      }

      const previous = options.find((option) => option.id === selectedId);
      const next = options.find((option) => option.id === id);
      if (!previous || !next) return;

      map.removeLayer(previous.layer);
      map.addLayer(next.layer);
      selectedId = id;
      for (const [optionId, input] of inputs) {
        input.checked = optionId === id;
      }
      closeMenu();
      if (focusButton) button.focus();
    }

    for (const option of options) {
      const label = document.createElement('label');
      label.className = 'layer-switcher-option';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = menu.id;
      input.value = option.id;
      input.checked = option.id === initialId;
      input.addEventListener('change', () => select(option.id));
      inputs.set(option.id, input);

      const text = document.createElement('span');
      text.textContent = option.label;

      label.append(input, text);
      menu.append(label);
    }

    toggleImpl = (): void => {
      const index = options.findIndex((option) => option.id === selectedId);
      if (index < 0 || options.length < 2) return;
      const next = options[(index + 1) % options.length];
      select(next.id, false);
    };

    button.addEventListener('click', () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    const onPointerDown = (event: PointerEvent): void => {
      if (!container.contains(event.target as Node)) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu();
        button.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    control.onRemove = (): void => {
      toggleImpl = null;
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    container.append(button, menu);
    return container;
  };

  return control;
}
