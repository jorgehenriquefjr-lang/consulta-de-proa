const API_BASE = "https://consulta-proas-backend.onrender.com";

const form = document.getElementById("search-form");
const input = document.getElementById("icao-input");
const statusEl = document.getElementById("status");
const resultCard = document.getElementById("result-card");
const historyBody = document.getElementById("history-body");
const historyEmpty = document.getElementById("history-empty");

const rotaForm = document.getElementById("rota-form");
const rotaInput = document.getElementById("rota-input");
const rotaStatusEl = document.getElementById("rota-status");

// Gere sua chave grátis em openaip.net (conta > API keys) e cole aqui.
const OPENAIP_API_KEY = "c78fad77a276a17e092101fc1c2753b4";

const ORIGEM = { icao: "SBNV", lat: -16.625556, lon: -49.349444 };

const map = L.map("map").setView([ORIGEM.lat, ORIGEM.lon], 5);

const baseLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 17,
  subdomains: "abc",
  attribution:
    "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)",
}).addTo(map);

const openAipLayer = L.tileLayer(
  `https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=${OPENAIP_API_KEY}`,
  {
    subdomains: "abc",
    minZoom: 7,
    maxZoom: 18,
    attribution: "Airspace data &copy; OpenAIP",
  }
);

L.control
  .layers(null, { "Espaço aéreo (OpenAIP)": openAipLayer }, { collapsed: false })
  .addTo(map);

let originMarker = L.marker([ORIGEM.lat, ORIGEM.lon])
  .addTo(map)
  .bindPopup("SBNV - Aeródromo Nacional de Aviação (Goiânia/GO)");

let destMarker = null;
let routeLine = null;
let lastDestino = null;
const fplLayer = L.layerGroup().addTo(map);

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function setRotaStatus(text, kind) {
  rotaStatusEl.textContent = text || "";
  rotaStatusEl.className = "status" + (kind ? " " + kind : "");
}

function drawFplRoute(pontosRota) {
  fplLayer.clearLayers();

  const pontos = [
    { ident: ORIGEM.icao, tipo: "origem", lat: ORIGEM.lat, lon: ORIGEM.lon },
    ...pontosRota,
    ...(lastDestino
      ? [{ ident: lastDestino.icao, tipo: "destino", lat: lastDestino.lat, lon: lastDestino.lon }]
      : []),
  ];

  pontos.forEach((p, i) => {
    const isEndpoint = i === 0 || i === pontos.length - 1;
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: isEndpoint ? 7 : 5,
      color: isEndpoint ? "#f59e0b" : "#16a34a",
      weight: 2,
      fillColor: isEndpoint ? "#f59e0b" : "#16a34a",
      fillOpacity: 0.85,
    }).bindPopup(`<b>${p.ident}</b><br>${p.tipo}<br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
    fplLayer.addLayer(marker);
  });

  const latlngs = pontos.map((p) => [p.lat, p.lon]);
  const line = L.polyline(latlngs, { color: "#16a34a", weight: 3, dashArray: "6 6" });
  fplLayer.addLayer(line);

  map.fitBounds(line.getBounds(), { padding: [30, 30] });
}

function drawRoute(origem, destino) {
  if (destMarker) map.removeLayer(destMarker);
  if (routeLine) map.removeLayer(routeLine);

  destMarker = L.marker([destino.lat, destino.lon])
    .addTo(map)
    .bindPopup(`${destino.icao} - ${destino.name}`);

  routeLine = L.polyline(
    [
      [origem.lat, origem.lon],
      [destino.lat, destino.lon],
    ],
    { color: "#1d4ed8", weight: 3 }
  ).addTo(map);

  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
}

function formatHeading(deg) {
  const rounded = Math.round(deg) % 360;
  return `H${String(rounded).padStart(3, "0")}`;
}

function showResult(data) {
  lastDestino = data.destino;
  resultCard.classList.remove("hidden");
  document.getElementById("result-name").textContent =
    `${data.destino.icao} - ${data.destino.name}`;
  document.getElementById("result-sub").textContent =
    `${data.destino.city}/${data.destino.state}`;
  document.getElementById("result-proa").textContent =
    formatHeading(data.proa_magnetica);
  document.getElementById("result-milhas").textContent =
    `${data.distancia_nm.toFixed(1)} NM`;
  document.getElementById("result-true").textContent =
    `Verdadeira: ${data.proa_verdadeira.toFixed(1)}°`;
  document.getElementById("result-decl").textContent =
    `${data.declinacao_magnetica.toFixed(1)}°`;

  drawRoute(data.origem, data.destino);
}

async function loadHistory() {
  try {
    const resp = await fetch(`${API_BASE}/api/historico?limit=25`);
    const data = await resp.json();
    const rows = data.resultados || [];
    historyBody.innerHTML = "";
    historyEmpty.classList.toggle("hidden", rows.length > 0);
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.consultado_em ?? ""}</td>
        <td>${r.destino?.icao ?? ""}</td>
        <td>${r.destino?.name ?? ""}</td>
        <td>${typeof r.proa_magnetica === "number" ? formatHeading(r.proa_magnetica) : r.proa_magnetica}</td>
        <td>${r.distancia_nm?.toFixed ? r.distancia_nm.toFixed(1) : r.distancia_nm} NM</td>
      `;
      historyBody.appendChild(tr);
    });
  } catch (e) {
    // histórico é secundário; falha silenciosa não deve travar a busca
  }
}

// Coordenada do Campo 18 do FPL, sem segundos (ex.: 1454S05104W ou 1526S05024W)
const FPL_COORD_REGEX = /^\d{4}[NS]\d{5}[EW]$/;

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const raw = input.value.trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return;

  let icao, coord;
  if (FPL_COORD_REGEX.test(raw)) {
    // Só a coordenada, sem indicador (localidade tipo ZZZZ)
    icao = "ZZZZ";
    coord = raw;
  } else if (raw.startsWith("ZZZZ") && FPL_COORD_REGEX.test(raw.slice(4))) {
    // "ZZZZ" + coordenada colados ou com espaço
    icao = "ZZZZ";
    coord = raw.slice(4);
  } else {
    icao = raw;
    coord = "";
  }

  setStatus(icao === "ZZZZ" ? "Calculando a partir da coordenada..." : "Consultando AISWEB...", "loading");
  resultCard.classList.add("hidden");

  const params = new URLSearchParams({ icao });
  if (icao === "ZZZZ") params.set("coord", coord);

  try {
    const resp = await fetch(`${API_BASE}/api/buscar_proa?${params.toString()}`);
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(data.error || "Erro ao consultar.", "error");
      return;
    }
    setStatus("");
    showResult(data);
    loadHistory();
  } catch (e) {
    setStatus("Falha de conexão com o servidor.", "error");
  }
});

rotaForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const rota = rotaInput.value.trim();
  if (!rota) return;

  setRotaStatus("Interpretando rota...", "loading");

  try {
    const resp = await fetch(`${API_BASE}/api/rota_fpl?${new URLSearchParams({ rota })}`);
    const data = await resp.json();
    if (!resp.ok) {
      setRotaStatus(data.error || "Erro ao interpretar a rota.", "error");
      return;
    }

    drawFplRoute(data.pontos);

    const naoResolvidos = data.nao_resolvidos || [];
    if (naoResolvidos.length) {
      setRotaStatus(
        `Rota traçada com ${data.pontos.length} ponto(s). Não reconhecidos: ${naoResolvidos.join(", ")}.`,
        "error"
      );
    } else {
      setRotaStatus(`Rota traçada com ${data.pontos.length} ponto(s).`, "");
    }
  } catch (e) {
    setRotaStatus("Falha de conexão com o servidor.", "error");
  }
});

loadHistory();
