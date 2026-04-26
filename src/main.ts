import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { setupUI } from "./ui";
import { initScoringLayers, scoreArea, clearScoring } from "./scoring-layer";
import { initRoutingLayers, placeRouteMarker, runRoute, clearRouting } from "./routing";
import { setWeights } from "./scorer";

const DEFAULT_RADIUS_MILES = 1;

const map = new maplibregl.Map({
  container: "map",
  style:
    "https://uw-hack-bucket-23480234.s3.us-east-1.amazonaws.com/style.json",
  center: [-122.33, 47.61],
  zoom: 10,
  attributionControl: false,
});

const radiusSlider = document.getElementById("radius-slider") as HTMLInputElement;
const radiusValueEl = document.getElementById("radius-value")!;
const radiusFooterEl = document.getElementById("radius-footer")!;

function getRadiusMeters(): number {
  return parseFloat(radiusSlider.value) * 1609.34;
}

function updateRadiusDisplay(): void {
  const miles = parseFloat(radiusSlider.value);
  const label = miles === 1 ? "1 mi" : `${miles} mi`;
  radiusValueEl.textContent = label;
  radiusFooterEl.textContent = `~${label} radius`;
}

radiusSlider.value = String(DEFAULT_RADIUS_MILES);
updateRadiusDisplay();

// --- Priorities panel ---
const PRIORITY_DEFAULTS = { roads: 4, quiet: 3, greenery: 1, surface: 1, slope: 1 } as const;
type WeightKey = keyof typeof PRIORITY_DEFAULTS;

function readPrioritySliders(): Record<WeightKey, number> {
  return {
    roads:    parseInt((document.getElementById("pw-roads") as HTMLInputElement).value),
    quiet:    parseInt((document.getElementById("pw-quiet") as HTMLInputElement).value),
    greenery: parseInt((document.getElementById("pw-greenery") as HTMLInputElement).value),
    surface:  parseInt((document.getElementById("pw-surface") as HTMLInputElement).value),
    slope:    parseInt((document.getElementById("pw-slope") as HTMLInputElement).value),
  };
}

function applyPrioritySliders(): void {
  const raw = readPrioritySliders();
  setWeights(raw);
  if (currentCenter) scoreArea(map, currentCenter, getRadiusMeters());
}

for (const key of Object.keys(PRIORITY_DEFAULTS) as WeightKey[]) {
  const slider = document.getElementById(`pw-${key}`) as HTMLInputElement;
  const valEl  = document.getElementById(`pv-${key}`)!;
  slider.addEventListener("input", () => {
    valEl.textContent = slider.value;
    applyPrioritySliders();
  });
}

document.getElementById("priorities-reset")!.addEventListener("click", () => {
  for (const [key, def] of Object.entries(PRIORITY_DEFAULTS) as [WeightKey, number][]) {
    const slider = document.getElementById(`pw-${key}`) as HTMLInputElement;
    const valEl  = document.getElementById(`pv-${key}`)!;
    slider.value = String(def);
    valEl.textContent = String(def);
  }
  applyPrioritySliders();
});

// --- Mode state ---
type AppMode = "score" | "route";
let appMode: AppMode = "score";
let routeStep: 0 | 1 = 0; // 0 = waiting for A, 1 = waiting for B
let routeA: [number, number] | null = null;
let currentCenter: [number, number] | null = null;

map.on("load", () => {
  // Hide buildings and address/housenumber labels from the base style
  const style = map.getStyle();
  for (const layer of style?.layers ?? []) {
    const sl = ((layer as Record<string, unknown>)["source-layer"] as string ?? "").toLowerCase();
    const id = layer.id.toLowerCase();
    if (
      sl === "building" || sl === "housenumber" ||
      id.includes("building") || id.includes("housenumber") || id.includes("address")
    ) {
      try { map.setLayoutProperty(layer.id, "visibility", "none"); } catch { /* skip */ }
    }
  }

  map.addSource("terrain-dem", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    tileSize: 256,
    encoding: "terrarium",
    maxzoom: 14,
  });
  map.setTerrain({ source: "terrain-dem", exaggeration: 0 });

  const { showScoreCard, hideScoreCard, showRouteCard, hideRouteCard } = setupUI(map);

  initScoringLayers(map, (stats) => showScoreCard(stats));
  initRoutingLayers(map, (result) => {
    if (appMode === "route") showRouteCard(result, "no walkable route found — try closer points");
  });

  // --- Mode toggle ---
  const tabScore = document.getElementById("tab-score")!;
  const tabRoute = document.getElementById("tab-route")!;

  function setMode(mode: AppMode) {
    appMode = mode;
    tabScore.dataset.active = String(mode === "score");
    tabRoute.dataset.active = String(mode === "route");

    if (mode === "score") {
      hideRouteCard();
      clearRouting(map);
      routeStep = 0;
      routeA = null;
    } else {
      hideScoreCard();
      clearScoring(map);
      currentCenter = null;
      routeStep = 0;
      routeA = null;
      showRouteCard(null, "click map to place A");
    }
  }

  tabScore.addEventListener("click", () => setMode("score"));
  tabRoute.addEventListener("click", () => setMode("route"));

  // --- Map clicks ---
  map.on("click", (e) => {
    const pos: [number, number] = [e.lngLat.lng, e.lngLat.lat];

    if (appMode === "score") {
      currentCenter = pos;
      scoreArea(map, currentCenter, getRadiusMeters());
    } else {
      if (routeStep === 0) {
        // Placing A — clear any previous route
        clearRouting(map);
        routeA = pos;
        placeRouteMarker(map, "A", pos);
        routeStep = 1;
        showRouteCard(null, "click map to place B");
      } else {
        // Placing B — run the route
        placeRouteMarker(map, "B", pos);
        showRouteCard(null, "computing route…");
        runRoute(map, routeA!, pos);
        // After route is shown, next click will re-place A
        routeStep = 0;
        routeA = null;
      }
    }
  });

  // --- Controls ---
  radiusSlider.addEventListener("input", () => {
    updateRadiusDisplay();
    if (currentCenter) scoreArea(map, currentCenter, getRadiusMeters());
  });

  document.getElementById("clear-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    clearScoring(map);
    currentCenter = null;
    hideScoreCard();
  });

  document.getElementById("route-clear-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    clearRouting(map);
    routeStep = 0;
    routeA = null;
    showRouteCard(null, "click map to place A");
  });
});
