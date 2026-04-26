import maplibregl from 'maplibre-gl';
import type { Map as MaplibreMap, Marker, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import type { FeatureCollection, Feature } from 'geojson';
import {
  scoreRoute, scoreToHex, scoreLabel, isWalkable,
  ROAD_CLASS_INTENSITY, ROAD_CLASS_PROXIMITY,
  type AreaStats, type ScoreBreakdown,
} from './scorer';

const SCORED_SOURCE   = 'scored-routes';
const SCORED_LAYER    = 'scored-routes-line';
const RADIUS_SOURCE   = 'score-radius';
const RADIUS_FILL_LYR = 'score-radius-fill';
const RADIUS_EDGE_LYR = 'score-radius-edge';

let dropMarker: Marker | null = null;
let pendingIdle: (() => void) | null = null;
let scoredCb: ((stats: AreaStats) => void) | null = null;
let transportationSourceId: string | null = null;

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

  // Returns the distance to the nearest indexed point within r metres, or Infinity if none.
  minDistWithin(pt: [number, number], r: number): number {
    const span = Math.ceil(r / (this.cell * 111320));
    const bx = Math.floor(pt[0] / this.cell);
    const by = Math.floor(pt[1] / this.cell);
    let best = Infinity;
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const bucket = this.cells.get(`${bx+dx},${by+dy}`);
        if (bucket) {
          for (const p of bucket) {
            const d = haversine(pt, p);
            if (d < r && d < best) best = d;
          }
        }
      }
    }
    return best;
  }

  private key([x, y]: [number, number]): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
}

// Returns the steepest percent grade found along the path using terrain DEM elevation,
// or null when DEM tiles aren't loaded yet (caller falls back to OSM tags).
function slopeGrade(map: MaplibreMap, coords: [number, number][]): number | null {
  if (coords.length < 2) return null;
  // Sample start, middle, and end so we catch the steepest section on longer segments.
  const indices = [0, Math.floor((coords.length - 1) / 2), coords.length - 1];
  const elevs: [number, number, number][] = []; // [lng, lat, elev]
  for (const i of indices) {
    const e = map.queryTerrainElevation(coords[i]);
    if (e === null) return null; // tile not yet loaded — skip entirely
    elevs.push([coords[i][0], coords[i][1], e]);
  }
  let maxGrade = 0;
  for (let i = 0; i < elevs.length - 1; i++) {
    const horiz = haversine([elevs[i][0], elevs[i][1]], [elevs[i+1][0], elevs[i+1][1]]);
    if (horiz < 5) continue;
    const grade = Math.abs(elevs[i+1][2] - elevs[i][2]) / horiz * 100;
    if (grade > maxGrade) maxGrade = grade;
  }
  return maxGrade;
}

function lineSegments(geom: Feature['geometry']): [number, number][][] {
  if (geom.type === 'LineString')      return [geom.coordinates as [number, number][]];
  if (geom.type === 'MultiLineString') return geom.coordinates as [number, number][][];
  return [];
}

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function initScoringLayers(map: MaplibreMap, onScored?: (stats: AreaStats) => void): void {
  scoredCb = onScored ?? null;

  // Find which source carries transportation data so we can use querySourceFeatures
  const style = map.getStyle();
  for (const layer of style?.layers ?? []) {
    const sl = (layer as Record<string, unknown>)['source-layer'] as string | undefined;
    if (sl === 'transportation') {
      transportationSourceId = (layer as Record<string, unknown>)['source'] as string;
      break;
    }
  }

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

  // Hover tooltip showing the individual route score
  const tooltip = document.createElement('div');
  tooltip.className = 'route-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  map.on('mousemove', (e) => {
    const feats = map.queryRenderedFeatures(e.point, { layers: [SCORED_LAYER] });
    if (feats.length) {
      const score = feats[0].properties?.score as number ?? 0;
      const color = feats[0].properties?.color as string ?? '#888';
      tooltip.innerHTML =
        `<span class="route-tooltip-score" style="color:${color}">${score}</span>` +
        `<span class="route-tooltip-label">${scoreLabel(score)}</span>`;
      tooltip.style.display = 'flex';
      tooltip.style.left = `${e.originalEvent.clientX + 14}px`;
      tooltip.style.top  = `${e.originalEvent.clientY - 48}px`;
      map.getCanvas().style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      map.getCanvas().style.cursor = '';
    }
  });
}

export function scoreArea(map: MaplibreMap, center: [number, number], radiusMeters: number): void {
  if (dropMarker) dropMarker.remove();
  dropMarker = new maplibregl.Marker({ color: '#1a1a1a', scale: 0.85 })
    .setLngLat(center).addTo(map);

  (map.getSource(RADIUS_SOURCE) as GeoJSONSource).setData(circleGeoJSON(center, radiusMeters));

  if (pendingIdle) { map.off('idle', pendingIdle); pendingIdle = null; }

  const run = () => { pendingIdle = null; applyScoring(map, center, radiusMeters); };
  pendingIdle = run;

  // Center on click; zoom to at least 14 so tiles contain fine path detail (sidewalks, footways)
  map.flyTo({ center, zoom: Math.max(map.getZoom(), 14), duration: 600 });
  map.once('idle', run);
}

function applyScoring(map: MaplibreMap, center: [number, number], radiusMeters: number): void {
  // querySourceFeatures returns all loaded tile features regardless of style rendering,
  // which fixes the issue where sidewalks/footways are invisible at lower zoom styles.
  const rawFeatures: MapGeoJSONFeature[] = transportationSourceId
    ? (map.querySourceFeatures(transportationSourceId, { sourceLayer: 'transportation' }) as MapGeoJSONFeature[])
    : (() => {
        const { clientWidth: w, clientHeight: h } = map.getContainer();
        return map.queryRenderedFeatures([[0, 0], [w, h]]);
      })();

  // One GridIndex per road class tier; keyed by class name
  const roadIndexes = new Map<string, GridIndex>();
  const walkable: Array<{ props: Record<string,unknown>; geom: Feature['geometry']; coords: [number,number][] }> = [];
  const seen = new Set<string>();

  for (const feat of rawFeatures) {
    // querySourceFeatures returns GeoJSONFeature (no sourceLayer prop); queryRenderedFeatures returns
    // MapGeoJSONFeature (has sourceLayer). When sourceLayer is present, filter to transportation only.
    if (feat.sourceLayer !== undefined && feat.sourceLayer !== 'transportation') continue;
    const props = feat.properties ?? {};

    // Process each sub-line independently so MultiLineString sub-lines aren't joined.
    for (const coords of lineSegments(feat.geometry)) {
      if (!coords.length) continue;

      // Key includes start, end, and vertex count so distinct geometries don't collide
      // when feat.id is missing (some tile sources don't populate it) — without this,
      // walkways that share an endpoint with another way at an intersection would dedup
      // down to a single segment.
      const last = coords[coords.length - 1];
      const key = `${feat.sourceLayer ?? 'transportation'}:${feat.id ?? 'noid'}:${coords.length}:${coords[0][0].toFixed(5)},${coords[0][1].toFixed(5)}:${last[0].toFixed(5)},${last[1].toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cls = String(props.class ?? '');
      if (cls in ROAD_CLASS_INTENSITY) {
        let idx = roadIndexes.get(cls);
        if (!idx) { idx = new GridIndex(); roadIndexes.set(cls, idx); }
        for (let i = 0; i < coords.length; i += 4) idx.insert(coords[i]);
      } else if (isWalkable(props)) {
        const geom: Feature['geometry'] = { type: 'LineString', coordinates: coords };
        walkable.push({ props, geom, coords });
      }
    }
  }

  const features: Feature[] = [];
  let nearestDist = Infinity;
  let nearestScore = 0;
  let nearestBreakdown: ScoreBreakdown = { roads: 0, greenery: 0, quiet: 0, surface: 0, slope: 0 };

  for (const { props, geom, coords } of walkable) {
    // Centroid of a long path can be outside the radius even when part of the path is inside.
    // Include the path if any vertex is within the radius.
    if (!coords.some(pt => haversine(center, pt) <= radiusMeters)) continue;
    const c = lineCentroid(coords);
    const dist = haversine(center, c);

    // Road intensity decays linearly with distance: full intensity at 0 m, zero at the class's max radius.
    // A path 10 m from a motorway scores very differently from one 140 m away.
    let roadIntensity = 0;
    for (const [cls, idx] of roadIndexes) {
      const maxR = ROAD_CLASS_PROXIMITY[cls];
      const dist  = idx.minDistWithin(c, maxR);
      if (dist < Infinity) {
        const contribution = ROAD_CLASS_INTENSITY[cls] * (1 - dist / maxR);
        if (contribution > roadIntensity) roadIntensity = contribution;
      }
    }

    const grade = slopeGrade(map, coords);
    const { total, breakdown } = scoreRoute(props, roadIntensity, grade);
    features.push({ type: 'Feature', properties: { score: total, color: scoreToHex(total) }, geometry: geom });

    if (dist < nearestDist) {
      nearestDist = dist;
      nearestScore = total;
      nearestBreakdown = breakdown;
    }
  }

  (map.getSource(SCORED_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features });

  if (scoredCb && features.length > 0) {
    scoredCb({ routeCount: features.length, score: nearestScore, factors: nearestBreakdown });
  }
}

export function clearScoring(map: MaplibreMap): void {
  if (pendingIdle) { map.off('idle', pendingIdle); pendingIdle = null; }
  if (dropMarker) { dropMarker.remove(); dropMarker = null; }
  (map.getSource(SCORED_SOURCE) as GeoJSONSource).setData(empty());
  (map.getSource(RADIUS_SOURCE) as GeoJSONSource).setData(empty());
}
