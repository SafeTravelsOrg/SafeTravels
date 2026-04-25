export interface ScoreBreakdown {
  roads: number;
  greenery: number;
  quiet: number;
  surface: number;
  lighting: number;
  slope: number;
}

export interface RouteScore {
  total: number;
  breakdown: ScoreBreakdown;
}

export interface AreaStats {
  routeCount: number;
  avgScore: number;
  factors: ScoreBreakdown;
}

// Weights must sum to 1.0
const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  roads:    0.20,
  greenery: 0.18,
  quiet:    0.17,
  surface:  0.20,
  lighting: 0.10,
  slope:    0.15,
};

type Props = Record<string, unknown>;

export const WALKABLE_CLASSES    = new Set(['path', 'pedestrian', 'footway', 'track', 'steps']);
export const WALKABLE_SUBCLASSES = new Set(['footway', 'path', 'sidewalk', 'steps', 'bridleway', 'cycleway']);
export const HEAVY_ROAD_CLASSES  = new Set(['motorway', 'trunk', 'primary']);

export function isWalkable(props: Props): boolean {
  return WALKABLE_CLASSES.has(String(props.class ?? '')) ||
         WALKABLE_SUBCLASSES.has(String(props.subclass ?? ''));
}

function s(props: Props, key: string): string {
  return String(props[key] ?? '').toLowerCase();
}

function scoreSurface(props: Props): number {
  const surf = s(props, 'surface');
  if (!surf) {
    const cls = s(props, 'class'), sub = s(props, 'subclass');
    if (cls === 'pedestrian' || sub === 'sidewalk' || cls === 'footway' || sub === 'footway') return 0.82;
    if (cls === 'steps' || sub === 'steps') return 0.72;
    if (cls === 'path' || sub === 'path') return 0.62;
    if (cls === 'track') return 0.45;
    return 0.65;
  }
  if (['asphalt','concrete','concrete:plates','paved','paving_stones','sett'].includes(surf)) return 0.92;
  if (['cobblestone','wood','metal','compacted','fine_gravel'].includes(surf)) return 0.65;
  if (['gravel','pebblestone'].includes(surf)) return 0.48;
  if (['unpaved','dirt','earth','ground','grass','mud','sand'].includes(surf)) return 0.28;
  return 0.60;
}

function scoreRoads(props: Props, nearHeavy: boolean): number {
  const cls = s(props, 'class'), sub = s(props, 'subclass');
  if (sub === 'sidewalk')                          return nearHeavy ? 0.15 : 0.42;
  if (sub === 'cycleway')                          return nearHeavy ? 0.35 : 0.58;
  if (cls === 'pedestrian')                        return nearHeavy ? 0.52 : 0.72;
  if (cls === 'footway' || sub === 'footway')      return nearHeavy ? 0.58 : 0.78;
  if (cls === 'steps' || sub === 'steps')          return 0.65;
  if (sub === 'bridleway' || cls === 'track')      return 0.88;
  if (cls === 'path')                              return nearHeavy ? 0.62 : 0.90;
  return 0.62;
}

function scoreGreenery(props: Props): number {
  const cls = s(props, 'class'), sub = s(props, 'subclass');
  if (cls === 'track' || sub === 'bridleway')      return 0.90;
  if (cls === 'path' && sub !== 'sidewalk')        return 0.82;
  if (sub === 'footway' || cls === 'footway')      return 0.70;
  if (cls === 'steps' || sub === 'steps')          return 0.58;
  if (cls === 'pedestrian')                        return 0.42;
  if (sub === 'cycleway')                          return 0.52;
  if (sub === 'sidewalk')                          return 0.28;
  return 0.55;
}

function scoreQuiet(props: Props, nearHeavy: boolean): number {
  const cls = s(props, 'class'), sub = s(props, 'subclass');
  let base: number;
  if (cls === 'track' || sub === 'bridleway')                       base = 0.92;
  else if (cls === 'path' && sub !== 'sidewalk' && sub !== 'cycleway') base = 0.82;
  else if (cls === 'steps' || sub === 'steps')                      base = 0.72;
  else if (sub === 'footway' || cls === 'footway')                  base = 0.66;
  else if (cls === 'pedestrian')                                    base = 0.52;
  else if (sub === 'cycleway')                                      base = 0.55;
  else if (sub === 'sidewalk')                                      base = 0.38;
  else base = 0.60;
  return nearHeavy ? Math.max(base * 0.52, 0.08) : base;
}

function scoreLighting(props: Props): number {
  const lit = s(props, 'lit');
  if (lit === 'yes' || lit === '24/7')            return 0.95;
  if (lit === 'automatic' || lit === 'limited')   return 0.75;
  if (lit === 'no')                               return 0.10;
  const cls = s(props, 'class'), sub = s(props, 'subclass');
  if (cls === 'pedestrian')                       return 0.80;
  if (sub === 'sidewalk')                         return 0.72;
  if (sub === 'footway' || cls === 'footway')     return 0.62;
  if (sub === 'steps' || cls === 'steps')         return 0.50;
  if (sub === 'cycleway')                         return 0.55;
  if (cls === 'path')                             return 0.35;
  if (cls === 'track')                            return 0.15;
  return 0.45;
}

function scoreSlope(props: Props): number {
  const cls = s(props, 'class'), sub = s(props, 'subclass');
  const brunnel = s(props, 'brunnel');
  const ramp = props.ramp;
  if (cls === 'steps' || sub === 'steps')   return 0.12;
  if (brunnel === 'bridge')                 return 0.62;
  if (ramp === 1 || ramp === '1')           return 0.75;
  return 0.88;
}

export function scoreRoute(props: Props, nearHeavyRoad = false): RouteScore {
  const breakdown: ScoreBreakdown = {
    roads:    scoreRoads(props, nearHeavyRoad),
    greenery: scoreGreenery(props),
    quiet:    scoreQuiet(props, nearHeavyRoad),
    surface:  scoreSurface(props),
    lighting: scoreLighting(props),
    slope:    scoreSlope(props),
  };
  const total = Math.round(
    (Object.keys(WEIGHTS) as (keyof ScoreBreakdown)[])
      .reduce((sum, k) => sum + breakdown[k] * WEIGHTS[k] * 100, 0),
  );
  return { total, breakdown };
}

export function scoreToHex(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  let r: number, g: number, b: number;
  if (s <= 50) {
    const t = s / 50;
    r = Math.round(231 + (241 - 231) * t);
    g = Math.round(76  + (196 - 76)  * t);
    b = Math.round(60  + (15  - 60)  * t);
  } else {
    const t = (s - 50) / 50;
    r = Math.round(241 + (39  - 241) * t);
    g = Math.round(196 + (174 - 196) * t);
    b = Math.round(15  + (96  - 15)  * t);
  }
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

export function scoreLabel(score: number): string {
  if (score >= 85) return '"excellent"';
  if (score >= 70) return '"great"';
  if (score >= 55) return '"pleasant"';
  if (score >= 40) return '"fair"';
  if (score >= 25) return '"rough"';
  return '"hazardous"';
}
