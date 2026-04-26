import type { Map } from "maplibre-gl";
import { scoreToHex, scoreLabel, type AreaStats } from "./scorer";

type LayerGroup = "footway" | "roads" | "parks" | "water" | "buildings";

const SOURCE_LAYER_PATTERNS: Record<LayerGroup, string[]> = {
  footway: ["transportation"],
  roads: ["transportation"],
  parks: ["park", "landcover", "landuse"],
  water: ["water", "waterway"],
  buildings: ["building"],
};

const ID_PATTERNS: Record<LayerGroup, string[]> = {
  footway: ["footway", "path", "pedestrian", "steps", "track", "bridleway", "cycleway", "sidewalk"],
  roads: ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"],
  parks: ["park", "grass", "wood", "forest", "meadow", "landcover", "landuse"],
  water: ["water", "waterway", "river", "lake"],
  buildings: ["building"],
};

const FACTOR_LABELS: Record<string, string> = {
  roads:    "road exposure",
  greenery: "greenery",
  quiet:    "quietness",
  surface:  "pavement",
  lighting: "night lighting",
  slope:    "flatness",
};

export interface UIControls {
  showScoreCard: (stats: AreaStats) => void;
  hideScoreCard: () => void;
}

export function setupUI(_map: Map): UIControls {
  const card = document.getElementById("score-card")!;
  const scoreNum = document.getElementById("score-num")!;
  const scoreSub = document.getElementById("score-sub")!;
  const routeCount = document.getElementById("route-count")!;
  const scoreBars = document.getElementById("score-bars")!;
  const hint = document.getElementById("legend-hint")!;

  function showScoreCard(stats: AreaStats): void {
    scoreNum.textContent = String(stats.score);
    scoreNum.style.color = scoreToHex(stats.score);
    scoreSub.textContent = `/ 100 · ${scoreLabel(stats.score)}`;
    routeCount.textContent = String(stats.routeCount);
    hint.textContent = "click map to re-score";

    scoreBars.innerHTML = Object.entries(stats.factors).map(([key, val]) => {
      const pct = Math.round(val * 100);
      const color = scoreToHex(pct);
      return `
        <div class="bar-label">${FACTOR_LABELS[key] ?? key}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="bar-value">${pct}</div>
      `;
    }).join("");

    card.style.display = "block";
  }

  function hideScoreCard(): void {
    card.style.display = "none";
    hint.textContent = "click map to score";
  }

  return { showScoreCard, hideScoreCard };
}

export function toggleLayers(map: Map, group: LayerGroup, visible: boolean): void {
  const style = map.getStyle();
  if (!style?.layers) return;
  const vis = visible ? "visible" : "none";
  const sourcePatterns = SOURCE_LAYER_PATTERNS[group];
  const idPatterns = ID_PATTERNS[group];

  for (const layer of style.layers) {
    const sourceLayer =
      ((layer as Record<string, unknown>)["source-layer"] as string | undefined) ?? "";
    const id = layer.id.toLowerCase();
    const matchesSource = sourcePatterns.some(p => sourceLayer.toLowerCase().includes(p));
    const matchesId = idPatterns.some(p => id.includes(p));
    if (matchesSource && matchesId) {
      try { map.setLayoutProperty(layer.id, "visibility", vis); } catch { /* skip */ }
    }
  }
}
