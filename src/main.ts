import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { setupUI } from "./ui";
import { initScoringLayers, scoreArea, clearScoring } from "./scoring-layer";

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

  // Add elevation DEM source for slope scoring; exaggeration 0 = invisible but tiles load and
  // queryTerrainElevation() becomes available.
  map.addSource('terrain-dem', {
    type: 'raster-dem',
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    tileSize: 256,
    encoding: 'terrarium',
    maxzoom: 14,
  });
  map.setTerrain({ source: 'terrain-dem', exaggeration: 0 });

  const { showScoreCard, hideScoreCard } = setupUI(map);

  initScoringLayers(map, (stats) => showScoreCard(stats));

  map.on("click", (e) => {
    currentCenter = [e.lngLat.lng, e.lngLat.lat];
    scoreArea(map, currentCenter, getRadiusMeters());
  });

  radiusSlider.addEventListener("input", () => {
    updateRadiusDisplay();
    if (currentCenter) {
      scoreArea(map, currentCenter, getRadiusMeters());
    }
  });

  document.getElementById("clear-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    clearScoring(map);
    currentCenter = null;
    hideScoreCard();
  });
});
