export interface ScoreBreakdown {
  roads: number;
  greenery: number;
  quiet: number;
  surface: number;
  slope: number;
}

export interface RouteScore {
  total: number;
  breakdown: ScoreBreakdown;
}

export interface AreaStats {
  routeCount: number;
  score: number; // nearest walkable route to the dropped pin
  factors: ScoreBreakdown;
}

// Weights must sum to 1.0
export const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  roads: 0.4,
  greenery: 0.1,
  quiet: 0.3,
  surface: 0.1,
  slope: 0.1,
};

// Raw values (any positive scale) — normalizes them into WEIGHTS in-place.
export function setWeights(raw: Record<keyof ScoreBreakdown, number>): void {
  const total = (Object.values(raw) as number[]).reduce((s, v) => s + v, 0);
  if (total === 0) return;
  for (const k of Object.keys(raw) as (keyof ScoreBreakdown)[]) {
    WEIGHTS[k] = raw[k] / total;
  }
}

type Props = Record<string, unknown>;

export const WALKABLE_CLASSES = new Set([
  "path",
  "pedestrian",
  "footway",
  "track",
  "steps",
]);
export const WALKABLE_SUBCLASSES = new Set([
  "footway",
  "path",
  "sidewalk",
  "crossing",
  "steps",
  "bridleway",
  "cycleway",
]);

// Traffic intensity by road class: 0 = quiet street, 1 = freeway-level.
// Only classes listed here are indexed for proximity checks.
export const ROAD_CLASS_INTENSITY: Record<string, number> = {
  motorway: 1.0,
  trunk: 1.0,
  primary: 0.65,
  secondary: 0.38,
};

// Proximity radius (meters) per road class.
// Bigger/faster roads affect walkers from further away (noise, danger, exhaust).
export const ROAD_CLASS_PROXIMITY: Record<string, number> = {
  motorway: 150,
  trunk: 150,
  primary: 90,
  secondary: 60,
};

export function isWalkable(props: Props): boolean {
  return (
    WALKABLE_CLASSES.has(String(props.class ?? "")) ||
    WALKABLE_SUBCLASSES.has(String(props.subclass ?? ""))
  );
}

function s(props: Props, key: string): string {
  return String(props[key] ?? "").toLowerCase();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function scoreSurface(props: Props): number {
  const surf = s(props, "surface");
  const cls = s(props, "class"),
    sub = s(props, "subclass");

  const NATURAL_SURFACES = [
    "unpaved",
    "dirt",
    "earth",
    "ground",
    "grass",
    "compacted",
    "fine_gravel",
    "gravel",
    "pebblestone",
    "wood",
  ];

  // Trails have no pavement expectation — dirt/grass is normal, not a penalty.
  // Sidewalks and pedestrian areas expect paving — unpaved is genuinely bad there.
  // A footway with an explicit natural surface tag is a park path, not a sidewalk — trust the tag.
  const isTrail =
    cls === "track" ||
    sub === "bridleway" ||
    (cls === "path" &&
      sub !== "sidewalk" &&
      sub !== "pedestrian" &&
      (sub !== "footway" || NATURAL_SURFACES.includes(surf)));

  if (!surf) {
    if (
      cls === "pedestrian" ||
      sub === "sidewalk" ||
      cls === "footway" ||
      sub === "footway"
    )
      return 0.82;
    if (cls === "steps" || sub === "steps") return 0.72;
    if (isTrail) return 0.78; // natural surface assumed — fine for a trail
    return 0.65;
  }

  // Hard surfaces are good everywhere
  if (
    [
      "asphalt",
      "concrete",
      "concrete:plates",
      "paved",
      "paving_stones",
      "sett",
    ].includes(surf)
  )
    return 0.92;

  if (isTrail) {
    // Packed/gravel — typical maintained trail surface
    if (
      ["compacted", "fine_gravel", "gravel", "pebblestone", "wood"].includes(
        surf,
      )
    )
      return 0.85;
    // Natural bare earth — totally normal trail surface
    if (["unpaved", "dirt", "earth", "ground", "grass"].includes(surf))
      return 0.78;
    // Genuinely difficult even on trails
    if (["mud", "sand"].includes(surf)) return 0.35;
    return 0.78;
  }

  // Paved-expectation paths (sidewalks, footways, pedestrian areas)
  if (
    ["cobblestone", "wood", "metal", "compacted", "fine_gravel"].includes(surf)
  )
    return 0.65;
  if (["gravel", "pebblestone"].includes(surf)) return 0.48;
  if (
    ["unpaved", "dirt", "earth", "ground", "grass", "mud", "sand"].includes(
      surf,
    )
  )
    return 0.28;
  return 0.6;
}

// roadIntensity: 0 = no indexed road nearby, 1 = right beside motorway/trunk
function scoreRoads(props: Props, roadIntensity: number): number {
  const cls = s(props, "class"),
    sub = s(props, "subclass");
  // [best score when isolated, worst score at max road intensity]
  let best: number, worst: number;
  if (sub === "sidewalk") {
    best = 0.72;
    worst = 0.06;
  } else if (sub === "cycleway") {
    best = 0.58;
    worst = 0.22;
  } else if (cls === "pedestrian") {
    best = 0.72;
    worst = 0.38;
  } else if (cls === "footway" || sub === "footway") {
    best = 0.78;
    worst = 0.44;
  } else if (cls === "steps" || sub === "steps") {
    best = 0.65;
    worst = 0.52;
  } else if (sub === "bridleway" || cls === "track") {
    best = 0.88;
    worst = 0.68;
  } else if (cls === "path") {
    best = 0.9;
    worst = 0.48;
  } else {
    best = 0.62;
    worst = 0.32;
  }
  return lerp(best, worst, roadIntensity);
}

function scoreGreenery(props: Props): number {
  const cls = s(props, "class"),
    sub = s(props, "subclass");
  if (cls === "track" || sub === "bridleway") return 0.9;
  if (cls === "path" && sub !== "sidewalk") return 0.82;
  if (sub === "footway" || cls === "footway") return 0.7;
  if (cls === "steps" || sub === "steps") return 0.58;
  if (cls === "pedestrian") return 0.42;
  if (sub === "cycleway") return 0.52;
  if (sub === "sidewalk") return 0.28;
  return 0.55;
}

function scoreQuiet(props: Props, roadIntensity: number): number {
  const i = Math.max(0, Math.min(1, roadIntensity));

  // Quietness is primarily acoustic: how much road noise reaches this path.
  // Linear decay from near-silence (intensity 0) to very loud (intensity 1).
  const acoustic = Math.max(0.95 - i * 0.88, 0.05);

  // Small ambient bonus for natural-setting paths (softer background even with no roads nearby).
  // Fades away near loud roads — no point adjusting when a freeway is 10 m away.
  const cls = s(props, "class"),
    sub = s(props, "subclass");
  const isNatural =
    cls === "track" ||
    sub === "bridleway" ||
    (cls === "path" && sub !== "sidewalk" && sub !== "cycleway");
  const naturalBonus = isNatural ? 0.07 * (1 - i) : 0;

  return Math.min(acoustic + naturalBonus, 1.0);
}

// grade: actual percent slope from DEM elevation samples, or null → fall back to OSM tags
function scoreSlope(props: Props, grade: number | null): number {
  const cls = s(props, "class"),
    sub = s(props, "subclass");
  if (cls === "steps" || sub === "steps") return 0.12; // always steep by definition

  if (grade !== null) {
    if (grade < 3) return 0.95; // flat
    if (grade < 6) return 0.82; // gentle
    if (grade < 10) return 0.65; // moderate
    if (grade < 15) return 0.45; // steep
    if (grade < 20) return 0.28; // very steep
    return 0.15; // extreme
  }

  // OSM-tag fallback when DEM tiles haven't loaded yet
  if (s(props, "brunnel") === "bridge") return 0.7;
  if (props.ramp === 1 || props.ramp === "1") return 0.75;
  return 0.88;
}

// roadIntensity: 0 (no roads nearby) → 1 (motorway/trunk at closest point)
// grade: measured percent slope from DEM, or null to fall back to OSM tags
export function scoreRoute(
  props: Props,
  roadIntensity = 0,
  grade: number | null = null,
): RouteScore {
  const breakdown: ScoreBreakdown = {
    roads: scoreRoads(props, roadIntensity),
    greenery: scoreGreenery(props),
    quiet: scoreQuiet(props, roadIntensity),
    surface: scoreSurface(props),
    slope: scoreSlope(props, grade),
  };
  const total = Math.round(
    (Object.keys(WEIGHTS) as (keyof ScoreBreakdown)[]).reduce(
      (sum, k) => sum + breakdown[k] * WEIGHTS[k] * 100,
      0,
    ),
  );
  return { total, breakdown };
}

export function scoreToHex(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  let r: number, g: number, b: number;
  if (s <= 50) {
    const t = s / 50;
    r = Math.round(231 + (241 - 231) * t);
    g = Math.round(76 + (196 - 76) * t);
    b = Math.round(60 + (15 - 60) * t);
  } else {
    const t = (s - 50) / 50;
    r = Math.round(241 + (39 - 241) * t);
    g = Math.round(196 + (174 - 196) * t);
    b = Math.round(15 + (96 - 15) * t);
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function scoreLabel(score: number): string {
  if (score >= 85) return '"excellent"';
  if (score >= 70) return '"great"';
  if (score >= 55) return '"fair"';
  return '"rough"';
}
