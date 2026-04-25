import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { setupUI } from "./ui";
import { initScoringLayers, scoreArea, clearScoring } from "./scoring-layer";

const map = new maplibregl.Map({
  container: "map",
  style: "http://localhost:8080/styles/Walking/style.json",
  center: [-122.33, 47.61],
  zoom: 10,
  attributionControl: false,
});

map.on("load", () => {
  const { showScoreCard, hideScoreCard } = setupUI(map);

  initScoringLayers(map, (stats) => showScoreCard(stats));

  map.on("click", (e) => {
    scoreArea(map, [e.lngLat.lng, e.lngLat.lat]);
  });

  document.getElementById("clear-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    clearScoring(map);
    hideScoreCard();
  });
});
