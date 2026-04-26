import maplibregl from 'maplibre-gl';
import type { Map as MaplibreMap, Marker, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import {
  isWalkable, scoreRoute, scoreToHex,
  ROAD_CLASS_INTENSITY, ROAD_CLASS_PROXIMITY,
} from './scorer';

// Walking a path with score 0 costs (1 + DETOUR_TOLERANCE)× its distance vs. a score-100 path.
// At 0.4, the router accepts up to a 40% longer detour to get a perfect-scoring route.
const DETOUR_TOLERANCE = 0.4;

const ROUTE_SOURCE = 'routing-path';
const ROUTE_CASING = 'routing-casing';
const ROUTE_LINE   = 'routing-line';

export interface RouteResult {
  distanceMeters: number;
  avgScore: number;
}

interface GraphEdge {
  toId: string;
  dist: number;   // metres
  cost: number;   // score-weighted distance
  score: number;  // 0–100, for colouring
}

interface GraphNode {
  pos: [number, number];
  edges: GraphEdge[];
}

let markerA: Marker | null = null;
let markerB: Marker | null = null;
let transportSrcId: string | null = null;
let onRouteCb: ((r: RouteResult | null) => void) | null = null;
let pendingIdle: (() => void) | null = null;

// --- Utilities (local copies; routing.ts is intentionally self-contained) ---

function haversine([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nodeKey([lng, lat]: [number, number]): string {
  // ~1 m precision — merges path endpoints that meet at an OSM node
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

class GridIndex {
  private cells = new Map<string, [number, number][]>();
  private readonly cell = 0.0009; // ~100 m per cell
  insert(pt: [number, number]) {
    const k = this.key(pt);
    let b = this.cells.get(k); if (!b) { b = []; this.cells.set(k, b); } b.push(pt);
  }
  minDistWithin(pt: [number, number], r: number): number {
    const span = Math.ceil(r / (this.cell * 111320));
    const bx = Math.floor(pt[0] / this.cell), by = Math.floor(pt[1] / this.cell);
    let best = Infinity;
    for (let dx = -span; dx <= span; dx++)
      for (let dy = -span; dy <= span; dy++)
        for (const p of this.cells.get(`${bx+dx},${by+dy}`) ?? []) {
          const d = haversine(pt, p); if (d < r && d < best) best = d;
        }
    return best;
  }
  private key([x, y]: [number, number]) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
}

// Spatial index that snaps nearby node positions to an existing node ID.
// Bridges small OSM gaps (path endpoints that are metres apart but should connect).
class NodeSnapIndex {
  private cells = new Map<string, Array<{ id: string; pos: [number, number] }>>();
  private readonly cell = 0.00009; // ~10 m per cell

  nearest(pos: [number, number], maxDist: number): string | null {
    const span = Math.ceil(maxDist / (this.cell * 111320));
    const bx = Math.floor(pos[0] / this.cell), by = Math.floor(pos[1] / this.cell);
    let bestId: string | null = null, bestDist = maxDist;
    for (let dx = -span; dx <= span; dx++)
      for (let dy = -span; dy <= span; dy++)
        for (const e of this.cells.get(`${bx+dx},${by+dy}`) ?? []) {
          const d = haversine(pos, e.pos);
          if (d < bestDist) { bestDist = d; bestId = e.id; }
        }
    return bestId;
  }

  insert(id: string, pos: [number, number]) {
    const k = `${Math.floor(pos[0] / this.cell)},${Math.floor(pos[1] / this.cell)}`;
    let b = this.cells.get(k); if (!b) { b = []; this.cells.set(k, b); }
    b.push({ id, pos });
  }
}

// --- Min-heap for A* open set ---

class MinHeap<T> {
  private data: Array<[number, T]> = [];
  get size() { return this.data.length; }
  push(priority: number, value: T) {
    this.data.push([priority, value]); this.bubbleUp(this.data.length - 1);
  }
  pop(): [number, T] | undefined {
    if (!this.data.length) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length) { this.data[0] = last; this.sinkDown(0); }
    return top;
  }
  private bubbleUp(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p][0] <= this.data[i][0]) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]]; i = p;
    }
  }
  private sinkDown(i: number) {
    const n = this.data.length;
    for (;;) {
      let m = i; const l = 2*i+1, r = 2*i+2;
      if (l < n && this.data[l][0] < this.data[m][0]) m = l;
      if (r < n && this.data[r][0] < this.data[m][0]) m = r;
      if (m === i) break;
      [this.data[m], this.data[i]] = [this.data[i], this.data[m]]; i = m;
    }
  }
}

// --- Graph construction ---

function buildGraph(map: MaplibreMap): Map<string, GraphNode> {
  const raw: MapGeoJSONFeature[] = transportSrcId
    ? map.querySourceFeatures(transportSrcId, { sourceLayer: 'transportation' }) as MapGeoJSONFeature[]
    : (() => {
        const { clientWidth: w, clientHeight: h } = map.getContainer();
        return map.queryRenderedFeatures([[0, 0], [w, h]]) as MapGeoJSONFeature[];
      })();

  const roadIdxs = new Map<string, GridIndex>();
  const walkableSegs: Array<{ props: Record<string, unknown>; coords: [number, number][] }> = [];
  const seen = new Set<string>();

  for (const feat of raw) {
    if (feat.sourceLayer !== undefined && feat.sourceLayer !== 'transportation') continue;
    const props = feat.properties ?? {};
    const g = feat.geometry;

    // Collect individual linestrings — MultiLineString sub-lines must stay separate;
    // flattening them would create phantom edges between unconnected sub-line endpoints.
    const lines: [number, number][][] = [];
    if (g.type === 'LineString') lines.push(g.coordinates as [number, number][]);
    else if (g.type === 'MultiLineString') lines.push(...g.coordinates as [number, number][][]);
    if (!lines.length) continue;

    const cls = String((props ?? {}).class ?? '');
    for (const coords of lines) {
      if (!coords.length) continue;

      // Key includes start, end, and vertex count so distinct geometries don't collide
      // when feat.id is missing — otherwise walkways meeting at shared intersection
      // nodes get dedup'd to one, and the graph loses edges through those intersections.
      const last = coords[coords.length - 1];
      const key = `${feat.sourceLayer ?? 'transportation'}:${feat.id ?? 'noid'}:${coords.length}:${coords[0][0].toFixed(5)},${coords[0][1].toFixed(5)}:${last[0].toFixed(5)},${last[1].toFixed(5)}`;
      if (seen.has(key)) continue; seen.add(key);

      if (cls in ROAD_CLASS_INTENSITY) {
        let idx = roadIdxs.get(cls); if (!idx) { idx = new GridIndex(); roadIdxs.set(cls, idx); }
        for (let i = 0; i < coords.length; i += 4) idx.insert(coords[i]);
      } else if (isWalkable(props)) {
        walkableSegs.push({ props, coords });
      }
    }
  }

  const graph = new Map<string, GraphNode>();
  const snapIdx = new NodeSnapIndex();
  // Snap within 8 m — closes typical OSM endpoint gaps without merging distinct intersections.
  const SNAP_DIST = 8;
  const node = (pos: [number, number]): string => {
    const existing = snapIdx.nearest(pos, SNAP_DIST);
    if (existing) return existing;
    const id = nodeKey(pos);
    graph.set(id, { pos, edges: [] });
    snapIdx.insert(id, pos);
    return id;
  };

  for (const { props, coords } of walkableSegs) {
    // Score the whole segment from its midpoint (same approach as applyScoring)
    const mid = coords[Math.floor(coords.length / 2)];
    let roadIntensity = 0;
    for (const [cls, idx] of roadIdxs) {
      const maxR = ROAD_CLASS_PROXIMITY[cls];
      const d = idx.minDistWithin(mid, maxR);
      if (d < Infinity) {
        const c = ROAD_CLASS_INTENSITY[cls] * (1 - d / maxR);
        if (c > roadIntensity) roadIntensity = c;
      }
    }
    const score = scoreRoute(props, roadIntensity, null).total;
    // Score 100 → 1× distance; score 0 → (1 + DETOUR_TOLERANCE)× distance.
    const costMult = 1 + DETOUR_TOLERANCE * (1 - score / 100);

    for (let i = 0; i < coords.length - 1; i++) {
      const aId = node(coords[i]);
      const bId = node(coords[i + 1]);
      if (aId === bId) continue;
      const dist = haversine(coords[i], coords[i + 1]);
      const cost = dist * costMult;
      graph.get(aId)!.edges.push({ toId: bId, dist, cost, score });
      graph.get(bId)!.edges.push({ toId: aId, dist, cost, score });
    }
  }

  return graph;
}

// --- A* with score-weighted costs ---

function astar(graph: Map<string, GraphNode>, startId: string, goalId: string): string[] | null {
  if (startId === goalId) return [startId];
  const goalPos = graph.get(goalId)!.pos;

  const gScore = new Map<string, number>([[startId, 0]]);
  const parent = new Map<string, string | null>([[startId, null]]);
  const closed  = new Set<string>();
  const heap    = new MinHeap<string>();
  heap.push(haversine(graph.get(startId)!.pos, goalPos), startId);

  while (heap.size > 0) {
    const [, curId] = heap.pop()!;
    if (closed.has(curId)) continue; // stale heap entry

    if (curId === goalId) {
      const path: string[] = [];
      for (let n: string | null = curId; n !== null; n = parent.get(n) ?? null) path.unshift(n);
      return path;
    }

    closed.add(curId);
    const curG = gScore.get(curId)!;

    for (const edge of graph.get(curId)!.edges) {
      if (closed.has(edge.toId)) continue;
      const tentG = curG + edge.cost;
      if (tentG < (gScore.get(edge.toId) ?? Infinity)) {
        gScore.set(edge.toId, tentG);
        parent.set(edge.toId, curId);
        heap.push(tentG + haversine(graph.get(edge.toId)!.pos, goalPos), edge.toId);
      }
    }
  }
  return null;
}

// Snap a lat/lng click to the nearest graph node within maxDist metres.
function snapToGraph(pos: [number, number], graph: Map<string, GraphNode>, maxDist = 500): string | null {
  let bestId: string | null = null, bestDist = maxDist;
  for (const [id, n] of graph) {
    const d = haversine(pos, n.pos);
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId;
}

// Build a GeoJSON FeatureCollection of per-segment coloured lines for the found route.
function routeGeoJSON(path: string[], graph: Map<string, GraphNode>): FeatureCollection {
  const features: Feature[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = graph.get(path[i])!;
    const b = graph.get(path[i + 1])!;
    const edge = a.edges.find(e => e.toId === path[i + 1]);
    const score = edge?.score ?? 50;
    features.push({
      type: 'Feature',
      properties: { score, color: scoreToHex(score) },
      geometry: { type: 'LineString', coordinates: [a.pos, b.pos] },
    });
  }
  return { type: 'FeatureCollection', features };
}

// --- Marker elements ---

function markerEl(label: 'A' | 'B'): HTMLElement {
  const el = document.createElement('div');
  el.className = `route-marker route-marker-${label.toLowerCase()}`;
  el.textContent = label;
  return el;
}

// --- Public API ---

export function initRoutingLayers(map: MaplibreMap, cb: (r: RouteResult | null) => void): void {
  onRouteCb = cb;

  const style = map.getStyle();
  for (const layer of style?.layers ?? []) {
    const sl = (layer as Record<string, unknown>)['source-layer'] as string | undefined;
    if (sl === 'transportation') {
      transportSrcId = (layer as Record<string, unknown>)['source'] as string;
      break;
    }
  }

  const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: empty });

  // Casing layer gives a dark outline so the route stands out against the base map.
  map.addLayer({
    id: ROUTE_CASING, type: 'line', source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#1a1a1a',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 5, 14, 10, 17, 16],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: ROUTE_LINE, type: 'line', source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 14, 7, 17, 12],
      'line-opacity': 1,
    },
  });
}

export function placeRouteMarker(map: MaplibreMap, which: 'A' | 'B', pos: [number, number]): void {
  if (which === 'A') {
    markerA?.remove();
    markerA = new maplibregl.Marker({ element: markerEl('A'), anchor: 'bottom' }).setLngLat(pos).addTo(map);
  } else {
    markerB?.remove();
    markerB = new maplibregl.Marker({ element: markerEl('B'), anchor: 'bottom' }).setLngLat(pos).addTo(map);
  }
}

export function runRoute(map: MaplibreMap, posA: [number, number], posB: [number, number]): void {
  // Cancel any in-flight route that hasn't fired yet
  if (pendingIdle) { map.off('idle', pendingIdle); pendingIdle = null; }

  const execute = () => {
    pendingIdle = null;

    let graph: Map<string, GraphNode>;
    try {
      graph = buildGraph(map);
    } catch (err) {
      console.error('[routing] buildGraph threw:', err);
      onRouteCb?.(null); return;
    }

    console.log(`[routing] graph: ${graph.size} nodes`);
    if (graph.size === 0) {
      console.warn('[routing] empty graph — no walkable features in loaded tiles');
      onRouteCb?.(null); return;
    }

    const startId = snapToGraph(posA, graph);
    const goalId  = snapToGraph(posB, graph);
    console.log(`[routing] snap: A=${startId ? 'ok' : 'null (>500m from any path)'}, B=${goalId ? 'ok' : 'null (>500m from any path)'}`);

    const setEmpty = () => {
      (map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
    };

    if (!startId || !goalId) { setEmpty(); onRouteCb?.(null); return; }

    const path = astar(graph, startId, goalId);
    console.log(`[routing] path: ${path ? path.length + ' nodes' : 'null (disconnected)'}`);
    if (!path || path.length < 2) { setEmpty(); onRouteCb?.(null); return; }

    let totalDist = 0, totalScore = 0, segs = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const edge = graph.get(path[i])!.edges.find(e => e.toId === path[i + 1]);
      if (edge) { totalDist += edge.dist; totalScore += edge.score; segs++; }
    }

    (map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData(routeGeoJSON(path, graph));
    onRouteCb?.({
      distanceMeters: totalDist,
      avgScore: Math.round(totalScore / Math.max(segs, 1)),
    });
  };

  pendingIdle = execute;

  // Fit the viewport to the A–B bounding box so all tiles along the path are loaded
  // before graph building runs. minZoom 14 ensures footway/path tiles are present.
  // Padding gives room for routes that deviate from the straight line.
  const sw: [number, number] = [Math.min(posA[0], posB[0]), Math.min(posA[1], posB[1])];
  const ne: [number, number] = [Math.max(posA[0], posB[0]), Math.max(posA[1], posB[1])];
  map.fitBounds([sw, ne], { padding: 120, minZoom: 14, maxZoom: 17, duration: 500 });
  map.once('idle', execute);
}

export function clearRouting(map: MaplibreMap): void {
  if (pendingIdle) { map.off('idle', pendingIdle); pendingIdle = null; }
  markerA?.remove(); markerA = null;
  markerB?.remove(); markerB = null;
  (map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
}
