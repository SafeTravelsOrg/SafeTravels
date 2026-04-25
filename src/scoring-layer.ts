import maplibregl from 'maplibre-gl';
import type { Map as MaplibreMap, Marker, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, Feature } from 'geojson';
import {
  scoreRoute, scoreToHex, isWalkable, HEAVY_ROAD_CLASSES,
  type AreaStats, type ScoreBreakdown,
} from './scorer';

const RADIUS_METERS = 5 * 1609.34; // 5 miles

const SCORED_SOURCE   = 'scored-routes';
const SCORED_LAYER    = 'scored-routes-line';
const RADIUS_SOURCE   = 'score-radius';
const RADIUS_FILL_LYR = 'score-radius-fill';
const RADIUS_EDGE_LYR = 'score-radius-edge';

let dropMarker: Marker | null = null;
let pendingIdle: (() => void) | null = null;
let scoredCb: ((stats: AreaStats) => void) | null = null;

function haversine([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function lineCentroid(coords: [number, number][]): [number, number] {
  let lng = 0, lat = 0;
  for (const [x, y] of coords) { lng += x; lat += y; }
  return [lng / coords.length, lat / coords.length];
}

function circleGeoJSON(center: [number, number], r: number): FeatureCollection {
  const [lng, lat] = center;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lng + (r / mPerDegLng) * Math.cos(a), lat + (r / mPerDegLat) * Math.sin(a)]);
  }
  return { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [pts] },
  }]};
}

function radiusBounds(center: [number, number], r: number): [[number,number],[number,number]] {
  const dLat = r / 111320;
  const dLng = r / (111320 * Math.cos(center[1] * Math.PI / 180));
  return [[center[0] - dLng, center[1] - dLat], [center[0] + dLng, center[1] + dLat]];
}

// Grid spatial index — fast proximity queries without O(n²) search
class GridIndex {
  private cells = new Map<string, [number, number][]>();
  private readonly cell = 0.0009; // ~100 m per cell

  insert(pt: [number, number]) {
    const k = this.key(pt);
    let bucket = this.cells.get(k);
    if (!bucket) { bucket = []; this.cells.set(k, bucket); }
    bucket.push(pt);
  }

  hasWithin(pt: [number, number], r: number): boolean {
    const span = Math.ceil(r / (this.cell * 111320));
    const bx = Math.floor(pt[0] / this.cell);
    const by = Math.floor(pt[1] / this.cell);
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const bucket = this.cells.get(`${bx+dx},${by+dy}`);
        if (bucket?.some(p => haversine(pt, p) < r)) return true;
      }
    }
    return false;
  }

  private key([x, y]: [number, number]): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
}

function lineCoords(geom: Feature['geometry']): [number, number][] {
  if (geom.type === 'LineString')      return geom.coordinates as [number, number][];
  if (geom.type === 'MultiLineString') return (geom.coordinates as [number,number][][]).flat();
  return [];
}

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function initScoringLayers(map: MaplibreMap, onScored?: (stats: AreaStats) => void): void {
  scoredCb = onScored ?? null;

  map.addSource(RADIUS_SOURCE, { type: 'geojson', data: empty() });
  map.addSource(SCORED_SOURCE, { type: 'geojson', data: empty() });

  map.addLayer({ id: RADIUS_FILL_LYR, type: 'fill', source: RADIUS_SOURCE,
    paint: { 'fill-color': '#4a90d9', 'fill-opacity': 0.05 } });
  map.addLayer({ id: RADIUS_EDGE_LYR, type: 'line', source: RADIUS_SOURCE,
    paint: { 'line-color': '#4a90d9', 'line-width': 1.5, 'line-dasharray': [4, 3] } });
  map.addLayer({ id: SCORED_LAYER, type: 'line', source: SCORED_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.8, 14, 4.5, 17, 7],
      'line-opacity': 0.88,
    },
  });
}

export function scoreArea(map: MaplibreMap, center: [number, number]): void {
  if (dropMarker) dropMarker.remove();
  dropMarker = new maplibregl.Marker({ color: '#1a1a1a', scale: 0.85 })
    .setLngLat(center).addTo(map);

  (map.getSource(RADIUS_SOURCE) as GeoJSONSource).setData(circleGeoJSON(center, RADIUS_METERS));

  // Cancel any queued scoring from a previous click
  if (pendingIdle) { map.off('idle', pendingIdle); pendingIdle = null; }

  const run = () => { pendingIdle = null; applyScoring(map, center); };
  pendingIdle = run;
  map.fitBounds(radiusBounds(center, RADIUS_METERS), { padding: 48, maxZoom: 14, duration: 800 });
  map.once('idle', run);
}

function applyScoring(map: MaplibreMap, center: [number, number]): void {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const all = map.queryRenderedFeatures([[0, 0], [w, h]]);

  const roadIdx = new GridIndex();
  const walkable: Array<{ props: Record<string,unknown>; geom: Feature['geometry']; coords: [number,number][] }> = [];
  const seen = new Set<string>();

  for (const feat of all) {
    if (feat.sourceLayer !== 'transportation') continue;
    const props = feat.properties ?? {};
    const coords = lineCoords(feat.geometry);
    if (!coords.length) continue;

    // Deduplicate: same OSM way can appear in multiple tile boundaries or style layers
    const key = feat.id != null
      ? `${feat.sourceLayer}:${feat.id}`
      : `${feat.sourceLayer}:${coords[0][0].toFixed(5)},${coords[0][1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (HEAVY_ROAD_CLASSES.has(String(props.class ?? ''))) {
      // Sample points into the road index for proximity checks
      for (let i = 0; i < coords.length; i += 4) roadIdx.insert(coords[i]);
    } else if (isWalkable(props)) {
      walkable.push({ props, geom: feat.geometry, coords });
    }
  }

  const features: Feature[] = [];
  let scoreSum = 0;
  const factorSum: ScoreBreakdown = { roads: 0, greenery: 0, quiet: 0, surface: 0, lighting: 0, slope: 0 };

  for (const { props, geom, coords } of walkable) {
    const c = lineCentroid(coords);
    if (haversine(center, c) > RADIUS_METERS) continue;

    const nearHeavy = roadIdx.hasWithin(c, 90);
    const { total, breakdown } = scoreRoute(props, nearHeavy);

    features.push({ type: 'Feature', properties: { score: total, color: scoreToHex(total) }, geometry: geom });
    scoreSum += total;
    for (const k of Object.keys(factorSum) as (keyof ScoreBreakdown)[]) {
      factorSum[k] += breakdown[k];
    }
  }

  (map.getSource(SCORED_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features });

  const n = features.length;
  if (scoredCb && n > 0) {
    const factors = Object.fromEntries(
      (Object.keys(factorSum) as (keyof ScoreBreakdown)[]).map(k => [k, factorSum[k] / n]),
    ) as unknown as ScoreBreakdown;
    scoredCb({ routeCount: n, avgScore: Math.round(scoreSum / n), factors });
  }
}

export function clearScoring(map: MaplibreMap): void {
  if (pendingIdle) { map.off('idle', pendingIdle); pendingIdle = null; }
  if (dropMarker) { dropMarker.remove(); dropMarker = null; }
  (map.getSource(SCORED_SOURCE) as GeoJSONSource).setData(empty());
  (map.getSource(RADIUS_SOURCE) as GeoJSONSource).setData(empty());
}
