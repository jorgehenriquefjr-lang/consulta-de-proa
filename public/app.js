const API_BASE = "https://consulta-proas-backend.onrender.com";

const form = document.getElementById("search-form");
const input = document.getElementById("icao-input");
const statusEl = document.getElementById("status");
const resultCard = document.getElementById("result-card");
const historyBody = document.getElementById("history-body");
const historyEmpty = document.getElementById("history-empty");

const metarTafBox = document.getElementById("metar-taf-box");
const metarTextEl = document.getElementById("metar-text");
const tafTextEl = document.getElementById("taf-text");

const avisosBox = document.getElementById("avisos-box");
const avisoAerodromoTextEl = document.getElementById("aviso-aerodromo-text");
const sigmetTextEl = document.getElementById("sigmet-text");
const airmetTextEl = document.getElementById("airmet-text");
const gametTextEl = document.getElementById("gamet-text");

const cartasBox = document.getElementById("cartas-box");
const cartasListEl = document.getElementById("cartas-list");

const rotaForm = document.getElementById("rota-form");
const rotaInput = document.getElementById("rota-input");
const rotaStatusEl = document.getElementById("rota-status");

const origemInput = document.getElementById("origem-input");
const origemFixarCheckbox = document.getElementById("origem-fixar");
const origemBrandEl = document.getElementById("origem-brand");
const savedPointsEl = document.getElementById("saved-points");

// Gere sua chave grátis em openaip.net (conta > API keys) e cole aqui.
const OPENAIP_API_KEY = "c78fad77a276a17e092101fc1c2753b4";

// Origem padrão (SBNV). O usuário pode consultar a partir de qualquer
// aeródromo/coordenada; "currentOrigem" é atualizada a cada busca com o que
// o backend resolveu, e refletida no marcador do mapa e no cabeçalho.
const ORIGEM = {
  icao: "SBNV",
  name: "AERÓDROMO NACIONAL DE AVIAÇÃO",
  city: "GOIÂNIA",
  state: "GO",
  lat: -16.625556,
  lon: -49.349444,
};
let currentOrigem = { ...ORIGEM };

// zoomControl fica em bottomright pra não colidir com o painel de ferramentas
// (docked em top:0/left:0 sobre o mapa em tela cheia).
const map = L.map("map", { zoomControl: false }).setView([ORIGEM.lat, ORIGEM.lon], 5);
L.control.zoom({ position: "bottomright" }).addTo(map);

const baseLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 17,
  subdomains: "abc",
  attribution:
    "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)",
}).addTo(map);

// Imagem de satélite (Esri World Imagery): gratuita, sem chave de API.
// maxNativeZoom é o nível real de resolução do Esri (varia por região; em
// área rural pode ser bem menor que em capitais); maxZoom acima disso deixa
// o Leaflet ampliar (upscale) o último tile carregado, permitindo "chegar
// mais perto do chão" pra conferir um ponto mesmo onde a imagem já não tem
// mais detalhe novo — é a forma de zoom mais próximo possível sem trocar de
// provedor (Google/Bing/Mapbox exigem chave paga ou violam termos de uso).
const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 22,
    maxNativeZoom: 19,
    attribution:
      "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  }
);

const openAipLayer = L.tileLayer(
  `https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=${OPENAIP_API_KEY}`,
  {
    subdomains: "abc",
    minZoom: 7,
    maxZoom: 18,
    attribution: "Airspace data &copy; OpenAIP",
  }
);

// No celular o painel de ferramentas ocupa a largura toda no topo, então o
// seletor de camadas (padrão: topright) vai pra um canto livre (bottomleft)
// pra não ficar embaixo do botão de fechar do painel.
const isCompactLayout = window.matchMedia("(max-width: 640px)").matches;
const layersControl = L.control
  .layers(
    { "Topográfico": baseLayer, "Satélite": satelliteLayer },
    { "Espaço aéreo (OpenAIP)": openAipLayer },
    {
      collapsed: true,
      position: isCompactLayout ? "bottomleft" : "topright",
    }
  )
  .addTo(map);

// Radar meteorológico (RainViewer): mosaico global gratuito, sem chave de API.
// Busca o frame mais recente e adiciona como mais uma camada no controle acima.
fetch("https://api.rainviewer.com/public/weather-maps.json")
  .then((resp) => resp.json())
  .then((data) => {
    const frames = data?.radar?.past;
    if (!frames || !frames.length) return;
    const ultimoFrame = frames[frames.length - 1];
    const radarLayer = L.tileLayer(
      `${data.host}${ultimoFrame.path}/256/{z}/{x}/{y}/2/1_1.png`,
      { opacity: 0.6, attribution: "Radar &copy; RainViewer" }
    );
    layersControl.addOverlay(radarLayer, "Radar meteorológico (RainViewer)");
  })
  .catch(() => {
    // radar é um extra; se o RainViewer estiver fora do ar, o resto do app segue normal
  });

// Radar meteorológico (REDEMET): imagem da estação mais próxima (Gama/DF),
// sobreposta no mapa nas coordenadas reais de cobertura (lat/lon min/max).
fetch(`${API_BASE}/api/radar`)
  .then((resp) => resp.json())
  .then((data) => {
    if (!data.path || data.lat_min == null || data.lon_min == null) return;
    const bounds = [
      [data.lat_min, data.lon_min],
      [data.lat_max, data.lon_max],
    ];
    const radarRedemetLayer = L.imageOverlay(data.path, bounds, {
      opacity: 0.6,
      attribution: `Radar &copy; REDEMET (${data.nome})`,
    });
    layersControl.addOverlay(radarRedemetLayer, "Radar meteorológico (REDEMET)");
  })
  .catch(() => {
    // radar é um extra; se a REDEMET estiver fora do ar, o resto do app segue normal
  });

// TSC (Tempo Severo Convectivo): células convectivas ativas, detectadas por
// radar/descargas atmosféricas. Cada ponto é uma célula de grade ~0.1°.
fetch(`${API_BASE}/api/tsc`)
  .then((resp) => resp.json())
  .then((data) => {
    const pontos = data.pontos || [];
    if (!pontos.length) return;
    const tscLayer = L.layerGroup(
      pontos.map((p) =>
        L.circleMarker([p.lat, p.lon], {
          radius: 3,
          color: "#dc2626",
          weight: 0,
          fillOpacity: 0.7,
        })
      )
    );
    layersControl.addOverlay(tscLayer, "Tempo Severo Convectivo (REDEMET)");
  })
  .catch(() => {
    // TSC é um extra; se a REDEMET estiver fora do ar, o resto do app segue normal
  });

// Tabuleiro METAR: status por categoria de voo (VFR/marginal/IFR) de todos os
// aeródromos do Brasil que têm METAR disponível, como no painel da REDEMET.
fetch(`${API_BASE}/api/status_aerodromos`)
  .then((resp) => resp.json())
  .then((data) => {
    const pontos = data.pontos || [];
    if (!pontos.length) return;
    const tabuleiroLayer = L.layerGroup(
      pontos.map((p) =>
        L.circleMarker([p.lat, p.lon], {
          radius: 7,
          color: "#fff",
          weight: 1,
          fillColor: p.cor,
          fillOpacity: 0.9,
        }).bindPopup(
          `<strong>${p.icao}</strong> - ${p.nome}<br><pre style="white-space:pre-wrap;margin:4px 0 0;font-size:11px">${
            p.info || ""
          }</pre>`
        )
      )
    ).addTo(map);
    layersControl.addOverlay(tabuleiroLayer, "Tabuleiro METAR (REDEMET)");
  })
  .catch(() => {
    // tabuleiro é um extra; se a REDEMET estiver fora do ar, o resto do app segue normal
  });

// Cartas oficiais do DECEA (GeoAISWEB): catálogo completo no painel de camadas
const GEOAISWEB_WMS = "https://geoaisweb.decea.gov.br/geoserver/ICA/wms";
// Abaixo de 100%, dá pra ver o satélite por trás da carta e conferir um ponto
// contra o terreno real; cada camada ativa tem seu próprio controle na aba
// "Selecionadas", partindo desse valor.
const DEFAULT_CHART_OPACITY = 0.7;
// Registro único de camadas "ativas" (aba Selecionadas), com opacidade — usado
// pelo catálogo de cartas WMS do DECEA e pelas cartas de aproximação (IAC/VAC)
// calibradas manualmente sobre o satélite, pra terem o mesmo controle de
// transparência sem duplicar a UI.
const activeLayers = new Map(); // nome -> { leaflet, label, opacity, onRemove }
const selectedListEl = document.getElementById("layers-selected-list");
const selectedEmptyEl = document.getElementById("layers-selected-empty");

function updateSelectedList() {
  selectedListEl.innerHTML = "";
  selectedEmptyEl.classList.toggle("hidden", activeLayers.size > 0);
  activeLayers.forEach((entry, name) => {
    const li = document.createElement("li");

    const row = document.createElement("div");
    row.className = "layers-selected-row";
    const span = document.createElement("span");
    span.textContent = entry.label;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remover";
    btn.addEventListener("click", () => (entry.onRemove ? entry.onRemove() : removeActiveLayer(name)));
    row.appendChild(span);
    row.appendChild(btn);

    // Transparência da carta sobre o mapa base (satélite/topográfico), pra
    // dar pra ver o terreno por baixo e conferir um ponto visualmente.
    const opacityRow = document.createElement("label");
    opacityRow.className = "layers-selected-opacity";
    const opacityText = document.createElement("span");
    opacityText.textContent = "Transparência";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "10";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(Math.round(entry.opacity * 100));
    slider.addEventListener("input", () => {
      entry.opacity = Number(slider.value) / 100;
      entry.leaflet.setOpacity(entry.opacity);
    });
    opacityRow.appendChild(opacityText);
    opacityRow.appendChild(slider);

    li.appendChild(row);
    li.appendChild(opacityRow);
    selectedListEl.appendChild(li);
  });
}

function addActiveLayer(name, label, leaflet, opacity = DEFAULT_CHART_OPACITY, onRemove = null) {
  leaflet.addTo(map);
  if (leaflet.setOpacity) leaflet.setOpacity(opacity);
  activeLayers.set(name, { leaflet, label, opacity, onRemove });
  updateSelectedList();
}

function removeActiveLayer(name) {
  const entry = activeLayers.get(name);
  if (entry) {
    map.removeLayer(entry.leaflet);
    activeLayers.delete(name);
  }
  updateSelectedList();
}

function decealChartLayer(layerName) {
  return L.tileLayer.wms(GEOAISWEB_WMS, {
    layers: layerName,
    format: "image/png",
    transparent: true,
    version: "1.1.0",
    opacity: DEFAULT_CHART_OPACITY,
    attribution: "Cartas aeronáuticas &copy; DECEA",
  });
}

function origemPopupText(origem) {
  const local = [origem.city, origem.state].filter(Boolean).join("/");
  return `${origem.icao} - ${origem.name}${local ? ` (${local})` : ""}`;
}

let originMarker = L.marker([currentOrigem.lat, currentOrigem.lon])
  .addTo(map)
  .bindPopup(origemPopupText(currentOrigem));

let destMarker = null;
let routeLine = null;
let lastDestino = null;
const fplLayer = L.layerGroup().addTo(map);

// ====== Medir distância e rumo (clique no mapa), como no REDEMET ======
const EARTH_RADIUS_KM = 6371.0088;
const KM_PARA_NM = 0.539957;

function calcularRumoDistancia(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);

  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanciaKm = EARTH_RADIUS_KM * c;

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const rumo = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  return { rumo, distanciaKm, distanciaNm: distanciaKm * KM_PARA_NM };
}

const medirLayer = L.layerGroup().addTo(map);
let medirPontos = [];

function medirAtivo() {
  const painelAberto = !document.getElementById("tool-panel").classList.contains("hidden");
  const abaMedir = !document.getElementById("tab-medir").classList.contains("hidden");
  return painelAberto && abaMedir;
}

function adicionarPontoMedicao(latlng) {
  const anterior = medirPontos[medirPontos.length - 1];
  medirPontos.push(latlng);

  L.circleMarker(latlng, {
    radius: 5,
    color: "#7c3aed",
    weight: 2,
    fillColor: "#7c3aed",
    fillOpacity: 0.9,
  }).addTo(medirLayer);

  if (anterior) {
    const { rumo, distanciaKm, distanciaNm } = calcularRumoDistancia(
      anterior.lat, anterior.lng, latlng.lat, latlng.lng
    );
    L.polyline([anterior, latlng], { color: "#7c3aed", weight: 3, dashArray: "4 8" })
      .bindTooltip(
        `${rumo.toFixed(1)}° · ${distanciaKm.toFixed(1)} km · ${distanciaNm.toFixed(1)} NM`,
        { permanent: true, direction: "center", className: "route-label" }
      )
      .addTo(medirLayer)
      .openTooltip();
  }
}

map.on("click", (e) => {
  if (medirAtivo()) adicionarPontoMedicao(e.latlng);
});

document.getElementById("medir-limpar").addEventListener("click", () => {
  medirLayer.clearLayers();
  medirPontos = [];
});

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

  // A rota do FPL já inclui origem e destino como pontos próprios; some com
  // a linha/marcador da busca direta pra não sobrepor duas linhas no mapa.
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  if (destMarker) {
    map.removeLayer(destMarker);
    destMarker = null;
  }

  const pontos = [
    { ident: currentOrigem.icao, tipo: "origem", lat: currentOrigem.lat, lon: currentOrigem.lon },
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

    if (i > 0) {
      const anterior = pontos[i - 1];
      const { rumo, distanciaNm } = calcularRumoDistancia(anterior.lat, anterior.lon, p.lat, p.lon);
      L.polyline(
        [
          [anterior.lat, anterior.lon],
          [p.lat, p.lon],
        ],
        { color: "#1d4ed8", weight: 3 }
      )
        .bindTooltip(`${formatHeading(rumo)} · ${distanciaNm.toFixed(1)} NM`, {
          permanent: true,
          direction: "center",
          className: "route-label",
        })
        .addTo(fplLayer);
    }
  });

  const bounds = L.latLngBounds(pontos.map((p) => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [30, 30] });
}

function updateOrigemUI(origem) {
  currentOrigem = origem;
  originMarker.setLatLng([origem.lat, origem.lon]).setPopupContent(origemPopupText(origem));
  const local = [origem.city, origem.state].filter(Boolean).join("/");
  origemBrandEl.textContent = `Origem: ${origem.icao}${local ? ` — ${local}` : ""}`;
}

function drawRoute(origem, destino, proaMagnetica, distanciaNm) {
  updateOrigemUI(origem);

  if (destMarker) map.removeLayer(destMarker);
  if (routeLine) map.removeLayer(routeLine);
  // Uma nova busca direta substitui a rota do FPL, se houver uma traçada.
  fplLayer.clearLayers();

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

  routeLine
    .bindTooltip(`${formatHeading(proaMagnetica)} · ${distanciaNm.toFixed(1)} NM`, {
      permanent: true,
      direction: "center",
      className: "route-label",
    })
    .openTooltip();

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

  drawRoute(data.origem, data.destino, data.proa_magnetica, data.distancia_nm);
  loadMetarTaf(data.destino.icao);
  loadAvisos(data.destino.icao);
  loadCartas(data.destino.icao);
}

async function loadMetarTaf(icao) {
  // ZZZZ (coordenada do Campo 18, sem indicador) não tem METAR/TAF pra buscar.
  if (!icao || icao === "ZZZZ") {
    metarTafBox.classList.add("hidden");
    return;
  }

  metarTafBox.classList.remove("hidden");
  metarTextEl.textContent = "Consultando...";
  tafTextEl.textContent = "Consultando...";

  try {
    const resp = await fetch(`${API_BASE}/api/metar_taf?icao=${icao}`);
    const data = await resp.json();
    if (!resp.ok) {
      metarTextEl.textContent = "Falha ao consultar.";
      tafTextEl.textContent = "Falha ao consultar.";
      return;
    }
    metarTextEl.textContent = data.metar || "Não disponível para este aeródromo.";
    tafTextEl.textContent = data.taf || "Não disponível para este aeródromo.";
  } catch (e) {
    metarTextEl.textContent = "Falha de conexão com o servidor.";
    tafTextEl.textContent = "Falha de conexão com o servidor.";
  }
}

function setAvisoText(el, mensagens, vazioTexto) {
  if (mensagens && mensagens.length > 0) {
    el.textContent = mensagens.map((m) => m.mens).join("\n\n");
    el.classList.add("mono-text-warn");
  } else {
    el.textContent = vazioTexto;
    el.classList.remove("mono-text-warn");
  }
}

async function loadAvisos(icao) {
  // ZZZZ (coordenada do Campo 18, sem indicador) não tem aviso de aeródromo pra buscar.
  if (!icao || icao === "ZZZZ") {
    avisosBox.classList.add("hidden");
    return;
  }

  avisosBox.classList.remove("hidden");
  avisoAerodromoTextEl.textContent = "Consultando...";
  sigmetTextEl.textContent = "Consultando...";
  airmetTextEl.textContent = "Consultando...";
  gametTextEl.textContent = "Consultando...";

  try {
    const resp = await fetch(`${API_BASE}/api/avisos?icao=${icao}`);
    const data = await resp.json();
    if (!resp.ok) {
      const erro = data.error || "Falha ao consultar.";
      avisoAerodromoTextEl.textContent = erro;
      sigmetTextEl.textContent = erro;
      airmetTextEl.textContent = erro;
      gametTextEl.textContent = erro;
      return;
    }
    setAvisoText(avisoAerodromoTextEl, data.aviso_aerodromo, "Nenhum aviso de aeródromo vigente.");
    setAvisoText(sigmetTextEl, data.sigmet, "Nenhum SIGMET vigente.");
    setAvisoText(airmetTextEl, data.airmet, "Nenhum AIRMET vigente.");
    setAvisoText(gametTextEl, data.gamet, "Nenhum GAMET vigente.");
  } catch (e) {
    avisoAerodromoTextEl.textContent = "Falha de conexão com o servidor.";
    sigmetTextEl.textContent = "Falha de conexão com o servidor.";
    airmetTextEl.textContent = "Falha de conexão com o servidor.";
    gametTextEl.textContent = "Falha de conexão com o servidor.";
  }
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

// Coordenada do Campo 18 do FPL, com ou sem segundos
// (ex.: 1454S05104W ou 145430S0510422W)
const FPL_COORD_REGEX = /^(?:\d{4}[NS]\d{5}|\d{6}[NS]\d{7})[EW]$/;

function parseIcaoOuCoord(raw) {
  raw = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (FPL_COORD_REGEX.test(raw)) {
    // Só a coordenada, sem indicador (localidade tipo ZZZZ)
    return { icao: "ZZZZ", coord: raw };
  }
  if (raw.startsWith("ZZZZ") && FPL_COORD_REGEX.test(raw.slice(4))) {
    // "ZZZZ" + coordenada colados ou com espaço
    return { icao: "ZZZZ", coord: raw.slice(4) };
  }
  return { icao: raw, coord: "" };
}

async function buscarProa(raw) {
  const { icao, coord } = parseIcaoOuCoord(raw);
  if (!icao) return;

  setStatus(icao === "ZZZZ" ? "Calculando a partir da coordenada..." : "Consultando AISWEB...", "loading");
  resultCard.classList.add("hidden");

  const params = new URLSearchParams({ icao });
  if (icao === "ZZZZ") params.set("coord", coord);

  // Origem: só manda pro backend quando o usuário customizou (padrão continua SBNV).
  const origemRaw = origemInput.value.trim().toUpperCase().replace(/\s+/g, "");
  if (origemRaw && origemRaw !== "SBNV") {
    const origemParsed = parseIcaoOuCoord(origemRaw);
    params.set("origem_icao", origemParsed.icao);
    if (origemParsed.icao === "ZZZZ") params.set("origem_coord", origemParsed.coord);
  }

  // O backend gratuito "dorme" após um tempo sem uso e pode levar até um
  // minuto para acordar na primeira consulta; avisa se estiver demorando.
  const slowHint = setTimeout(() => {
    setStatus("Ainda consultando... o servidor pode estar iniciando após ficar inativo (até ~1 min).", "loading");
  }, 4000);

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
  } finally {
    clearTimeout(slowHint);
  }
}

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  buscarProa(input.value);
});

// ====== Origem customizável (padrão SBNV, com opção de fixar) ======
const ORIGEM_STORAGE_KEY = "proa_origem_fixa";

function initOrigem() {
  const salva = localStorage.getItem(ORIGEM_STORAGE_KEY);
  if (salva) {
    origemInput.value = salva;
    origemFixarCheckbox.checked = true;
  }

  function salvarSeFixado() {
    if (origemFixarCheckbox.checked) {
      const valor = origemInput.value.trim().toUpperCase();
      if (valor) localStorage.setItem(ORIGEM_STORAGE_KEY, valor);
    } else {
      localStorage.removeItem(ORIGEM_STORAGE_KEY);
    }
  }

  // Os pontos VFR salvos (Abadia de Goiás, Hipódromo, Portão Trindade) são
  // referências próximas de SBNV, então só aparecem quando SBNV é digitado
  // de fato na origem — campo vazio (só com o placeholder) não conta. Com a
  // caixa de origem desativada (sistema fixo em SBNV), sempre mostra.
  const origemBox = document.getElementById("origin-box");
  function atualizarPontosSalvos() {
    if (origemBox.classList.contains("hidden")) {
      savedPointsEl.classList.remove("hidden");
      return;
    }
    const valor = origemInput.value.trim().toUpperCase();
    savedPointsEl.classList.toggle("hidden", valor !== "SBNV");
  }

  origemFixarCheckbox.addEventListener("change", salvarSeFixado);
  origemInput.addEventListener("change", salvarSeFixado);
  origemInput.addEventListener("input", atualizarPontosSalvos);

  atualizarPontosSalvos();
}

initOrigem();

document.querySelectorAll("#saved-points .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const coord = btn.dataset.coord;
    input.value = coord;
    buscarProa(coord);
  });
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

// ====== Painel de ferramentas (Buscar / Rota FPL / Camadas / Selecionadas / Histórico) ======
function initToolPanel() {
  const panel = document.getElementById("tool-panel");
  const closeBtn = document.getElementById("tool-panel-close");
  const toolbarBtns = document.querySelectorAll(".toolbar-tools .tool-btn");
  const panelTabs = document.querySelectorAll(".tool-panel-tabs .tool-tab");
  const tabPanels = {
    buscar: document.getElementById("tab-buscar"),
    rota: document.getElementById("tab-rota"),
    medir: document.getElementById("tab-medir"),
    camadas: document.getElementById("tab-camadas"),
    selecionadas: document.getElementById("tab-selecionadas"),
    historico: document.getElementById("tab-historico"),
  };

  function openTab(name) {
    panel.classList.remove("hidden");
    Object.entries(tabPanels).forEach(([key, el]) => el.classList.toggle("hidden", key !== name));
    panelTabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    toolbarBtns.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  }

  toolbarBtns.forEach((btn) => btn.addEventListener("click", () => openTab(btn.dataset.tab)));
  panelTabs.forEach((btn) => btn.addEventListener("click", () => openTab(btn.dataset.tab)));
  closeBtn.addEventListener("click", () => {
    panel.classList.add("hidden");
    toolbarBtns.forEach((t) => t.classList.remove("active"));
  });

  openTab("buscar");
}

initToolPanel();

// ====== Catálogo de camadas DECEA (GeoAISWEB) ======
async function initLayersTree() {
  const searchInput = document.getElementById("layers-search");
  const treeEl = document.getElementById("layers-tree");

  const checkboxByLayer = new Map(); // nome da camada -> <input> (só existe se já renderizado)

  function setLayerActive(name, label, active) {
    const checkbox = checkboxByLayer.get(name);
    if (checkbox) checkbox.checked = active;

    if (active) {
      if (!activeLayers.has(name)) {
        addActiveLayer(name, label, decealChartLayer(name), DEFAULT_CHART_OPACITY, () =>
          setLayerActive(name, label, false)
        );
      }
    } else {
      removeActiveLayer(name);
    }
  }

  function makeLayerItem(layer) {
    const div = document.createElement("div");
    div.className = "layers-item";
    const id = `layer-${layer.name}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.checked = activeLayers.has(layer.name);
    checkbox.addEventListener("change", () => setLayerActive(layer.name, layer.label, checkbox.checked));

    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = layer.label;

    div.appendChild(checkbox);
    div.appendChild(label);
    checkboxByLayer.set(layer.name, checkbox);
    return div;
  }

  function makeSubgroupNode(subgroup) {
    const details = document.createElement("details");
    details.className = "layers-group layers-subgroup";
    const summary = document.createElement("summary");
    summary.className = "layers-subgroup-header";
    summary.textContent = subgroup.label;
    details.appendChild(summary);

    const children = document.createElement("div");
    children.className = "layers-group-children";
    let built = false;
    details.addEventListener("toggle", () => {
      if (details.open && !built) {
        built = true;
        subgroup.layers.forEach((layer) => children.appendChild(makeLayerItem(layer)));
      }
    });
    details.appendChild(children);
    return details;
  }

  function makeGroupNode(group) {
    const details = document.createElement("details");
    details.className = "layers-group";
    const summary = document.createElement("summary");
    summary.className = "layers-group-header";
    summary.textContent = group.label;
    details.appendChild(summary);

    const children = document.createElement("div");
    children.className = "layers-group-children";
    let built = false;
    details.addEventListener("toggle", () => {
      if (details.open && !built) {
        built = true;
        (group.layers || []).forEach((layer) => children.appendChild(makeLayerItem(layer)));
        (group.subgroups || []).forEach((sg) => children.appendChild(makeSubgroupNode(sg)));
      }
    });
    details.appendChild(children);
    return details;
  }

  let catalog = null;
  try {
    const resp = await fetch("decea_layers.json");
    catalog = await resp.json();
  } catch (e) {
    treeEl.textContent = "Falha ao carregar o catálogo de camadas.";
    return;
  }

  catalog.groups.forEach((group) => treeEl.appendChild(makeGroupNode(group)));

  // Busca: expande e filtra grupos/itens que batem com o texto digitado.
  // Como a árvore é montada sob demanda, força a montagem completa ao buscar.
  function forceBuildAll() {
    // Cada grupo só cria seus filhos (inclusive subgrupos aninhados) quando
    // aberto pela 1ª vez, então repete até não sobrar nenhum <details> fechado.
    let closed;
    do {
      closed = treeEl.querySelectorAll("details:not([open])");
      closed.forEach((d) => {
        d.open = true;
        d.dispatchEvent(new Event("toggle"));
      });
    } while (closed.length > 0);
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLocaleLowerCase("pt-BR");
    if (!q) {
      treeEl.querySelectorAll(".layers-item, .layers-group, .layers-subgroup").forEach((el) => {
        el.classList.remove("hidden");
      });
      return;
    }

    forceBuildAll();

    treeEl.querySelectorAll(".layers-item").forEach((item) => {
      const label = item.querySelector("label").textContent.toLocaleLowerCase("pt-BR");
      item.classList.toggle("hidden", !label.includes(q));
    });

    treeEl.querySelectorAll(".layers-subgroup").forEach((sg) => {
      const hasMatch = !!sg.querySelector(".layers-item:not(.hidden)");
      sg.classList.toggle("hidden", !hasMatch);
      sg.open = hasMatch;
    });

    treeEl.querySelectorAll(":scope > .layers-group").forEach((g) => {
      const hasMatch = !!g.querySelector(".layers-item:not(.hidden)");
      g.classList.toggle("hidden", !hasMatch);
      g.open = hasMatch;
    });
  });
}

initLayersTree();

// ====== Cartas de aproximação (IAC/VAC): lista por aeródromo + calibração ======
// Não existe fonte georreferenciada pra essas cartas (são PDFs de procedimento,
// não WMS): o usuário mesmo calibra clicando em 2 pontos que reconhece na
// carta e informando a coordenada real de cada um; a partir disso calculamos
// rotação+escala e encaixamos a carta sobre o satélite via
// L.imageOverlay.rotated (plugin em vendor/).
async function loadCartas(icao) {
  if (!icao || icao === "ZZZZ") {
    cartasBox.classList.add("hidden");
    return;
  }

  cartasBox.classList.remove("hidden");
  cartasListEl.innerHTML = '<p class="empty-hint">Consultando...</p>';

  try {
    const resp = await fetch(`${API_BASE}/api/cartas?icao=${icao}`);
    const data = await resp.json();
    const lista = (resp.ok && data.cartas) || [];
    if (!lista.length) {
      cartasListEl.innerHTML =
        '<p class="empty-hint">Nenhuma carta de aproximação encontrada para este aeródromo.</p>';
      return;
    }
    cartasListEl.innerHTML = "";
    lista.forEach((carta) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "carta-chip";
      btn.textContent = `${carta.tipo} · ${carta.nome}${carta.codigo ? " " + carta.codigo : ""}`;
      btn.addEventListener("click", () => openCartaModal(icao, carta));
      cartasListEl.appendChild(btn);
    });
  } catch (e) {
    cartasListEl.innerHTML = '<p class="empty-hint">Falha de conexão com o servidor.</p>';
  }
}

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const cartaModal = document.getElementById("carta-modal");
const cartaModalTitle = document.getElementById("carta-modal-title");
const cartaModalClose = document.getElementById("carta-modal-close");
const cartaCanvas = document.getElementById("carta-canvas");
const cartaModalStatus = document.getElementById("carta-modal-status");
const cartaModalApply = document.getElementById("carta-modal-apply");
const cartaModalReset = document.getElementById("carta-modal-reset");
const cartaPointBoxEls = { 1: document.getElementById("carta-point-1"), 2: document.getElementById("carta-point-2") };
const cartaPointEls = {
  1: {
    status: document.getElementById("carta-p1-status"),
    lat: document.getElementById("carta-p1-lat"),
    lon: document.getElementById("carta-p1-lon"),
  },
  2: {
    status: document.getElementById("carta-p2-status"),
    lat: document.getElementById("carta-p2-lat"),
    lon: document.getElementById("carta-p2-lon"),
  },
};

let cartaState = null; // { icao, carta, baseCanvas, points: {1,2}, activePoint }

function armCartaPoint(n) {
  if (!cartaState) return;
  cartaState.activePoint = n;
  cartaPointBoxEls[1].classList.toggle("active", n === 1);
  cartaPointBoxEls[2].classList.toggle("active", n === 2);
}

function redrawCartaCanvas() {
  if (!cartaState || !cartaState.baseCanvas) return;
  const ctx = cartaCanvas.getContext("2d");
  ctx.drawImage(cartaState.baseCanvas, 0, 0);
  [1, 2].forEach((n) => {
    const p = cartaState.points[n];
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = n === 1 ? "#dc2626" : "#2563eb";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), p.x, p.y);
  });
}

async function renderCartaPdf(pdfBytes) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const page = await pdf.getPage(1);
  const naturalViewport = page.getViewport({ scale: 1 });
  // resolução boa o bastante pra ler detalhe sem pesar demais o canvas
  const scale = Math.min(2.5, 1600 / naturalViewport.width);
  const viewport = page.getViewport({ scale });

  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = viewport.width;
  baseCanvas.height = viewport.height;
  await page.render({ canvasContext: baseCanvas.getContext("2d"), viewport }).promise;
  return baseCanvas;
}

async function openCartaModal(icao, carta) {
  cartaModal.classList.remove("hidden");
  cartaModalTitle.textContent = `${icao} · ${carta.tipo} ${carta.nome}`;
  cartaModalStatus.textContent = "Carregando carta...";

  cartaState = { icao, carta, baseCanvas: null, points: { 1: null, 2: null }, activePoint: 1 };
  [1, 2].forEach((n) => {
    cartaPointEls[n].lat.value = "";
    cartaPointEls[n].lon.value = "";
    cartaPointEls[n].status.textContent = "Clique na carta para marcar";
  });
  armCartaPoint(1);

  try {
    const resp = await fetch(`${API_BASE}/api/carta_pdf?arquivo=${carta.arquivo}`);
    if (!resp.ok) throw new Error("download falhou");
    const bytes = await resp.arrayBuffer();
    const baseCanvas = await renderCartaPdf(bytes);

    cartaState.baseCanvas = baseCanvas;
    cartaCanvas.width = baseCanvas.width;
    cartaCanvas.height = baseCanvas.height;
    redrawCartaCanvas();
    cartaModalStatus.textContent = "Marque os 2 pontos conhecidos na carta.";
  } catch (e) {
    cartaModalStatus.textContent = "Falha ao carregar o PDF da carta. Tente novamente.";
  }
}

function closeCartaModal() {
  cartaModal.classList.add("hidden");
  cartaState = null;
}

cartaModalClose.addEventListener("click", closeCartaModal);
cartaModal.addEventListener("click", (e) => {
  if (e.target === cartaModal) closeCartaModal();
});

cartaCanvas.addEventListener("click", (ev) => {
  if (!cartaState || !cartaState.baseCanvas) return;
  const rect = cartaCanvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) * cartaCanvas.width) / rect.width;
  const y = ((ev.clientY - rect.top) * cartaCanvas.height) / rect.height;

  const n = cartaState.activePoint;
  cartaState.points[n] = { x, y };
  cartaPointEls[n].status.textContent = `Marcado em (${Math.round(x)}, ${Math.round(y)})`;
  redrawCartaCanvas();

  const outro = n === 1 ? 2 : 1;
  if (!cartaState.points[outro]) armCartaPoint(outro);
});

[1, 2].forEach((n) => {
  cartaPointBoxEls[n].addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
    armCartaPoint(n);
  });
});

document.querySelectorAll(".carta-point-quick button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const n = btn.dataset.point;
    const fonte = btn.dataset.fonte === "origem" ? currentOrigem : lastDestino;
    if (!fonte) return;
    cartaPointEls[n].lat.value = fonte.lat.toFixed(6);
    cartaPointEls[n].lon.value = fonte.lon.toFixed(6);
  });
});

cartaModalReset.addEventListener("click", () => {
  if (!cartaState) return;
  cartaState.points = { 1: null, 2: null };
  [1, 2].forEach((n) => (cartaPointEls[n].status.textContent = "Clique na carta para marcar"));
  armCartaPoint(1);
  redrawCartaCanvas();
});

// ====== Matemática da calibração: 2 pontos (pixel <-> lat/lon) definem uma
// transformação de similaridade (rotação + escala uniforme + translação),
// usando números complexos e uma aproximação planar local (equirretangular,
// válida na escala de poucos km de uma carta de aproximação). ======
const METROS_POR_GRAU_LAT = 111320;
function metrosPorGrauLon(latGraus) {
  return 111320 * Math.cos((latGraus * Math.PI) / 180);
}
function parseCoordInput(valor) {
  const n = parseFloat(String(valor).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function complexMul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function complexSub(a, b) {
  return { re: a.re - b.re, im: a.im - b.im };
}
function complexAdd(a, b) {
  return { re: a.re + b.re, im: a.im + b.im };
}
function complexDiv(a, b) {
  const denom = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / denom, im: (a.im * b.re - a.re * b.im) / denom };
}
function latLonParaMetrosLocais(lat, lon, lat0, lon0) {
  return {
    re: (lon - lon0) * metrosPorGrauLon(lat0),
    im: (lat0 - lat) * METROS_POR_GRAU_LAT, // "para o sul", cresce pra baixo como o eixo Y do canvas
  };
}
function metrosLocaisParaLatLon(x, y, lat0, lon0) {
  return { lat: lat0 - y / METROS_POR_GRAU_LAT, lon: lon0 + x / metrosPorGrauLon(lat0) };
}

function calibrarCarta(p1px, p2px, g1, g2, larguraPx, alturaPx) {
  const lat0 = (g1.lat + g2.lat) / 2;
  const lon0 = (g1.lon + g2.lon) / 2;

  const zSrc1 = { re: p1px.x, im: p1px.y };
  const zSrc2 = { re: p2px.x, im: p2px.y };
  const zDst1 = latLonParaMetrosLocais(g1.lat, g1.lon, lat0, lon0);
  const zDst2 = latLonParaMetrosLocais(g2.lat, g2.lon, lat0, lon0);

  const a = complexDiv(complexSub(zDst2, zDst1), complexSub(zSrc2, zSrc1));
  const b = complexSub(zDst1, complexMul(a, zSrc1));

  const transformar = (x, y) => {
    const z = complexAdd(complexMul(a, { re: x, im: y }), b);
    return metrosLocaisParaLatLon(z.re, z.im, lat0, lon0);
  };

  return {
    topLeft: transformar(0, 0),
    topRight: transformar(larguraPx, 0),
    bottomLeft: transformar(0, alturaPx),
  };
}

cartaModalApply.addEventListener("click", () => {
  if (!cartaState || !cartaState.baseCanvas) return;

  const p1 = cartaState.points[1];
  const p2 = cartaState.points[2];
  if (!p1 || !p2) {
    cartaModalStatus.textContent = "Marque os 2 pontos na carta antes de aplicar.";
    return;
  }

  const g1 = { lat: parseCoordInput(cartaPointEls[1].lat.value), lon: parseCoordInput(cartaPointEls[1].lon.value) };
  const g2 = { lat: parseCoordInput(cartaPointEls[2].lat.value), lon: parseCoordInput(cartaPointEls[2].lon.value) };
  if (g1.lat == null || g1.lon == null || g2.lat == null || g2.lon == null) {
    cartaModalStatus.textContent = "Informe latitude e longitude válidas dos 2 pontos.";
    return;
  }

  const distanciaPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (distanciaPx < 25) {
    cartaModalStatus.textContent = "Os 2 pontos estão perto demais na carta — escolha pontos mais afastados.";
    return;
  }
  const { distanciaKm } = calcularRumoDistancia(g1.lat, g1.lon, g2.lat, g2.lon);
  if (distanciaKm * 1000 < 30) {
    cartaModalStatus.textContent = "Os 2 pontos estão perto demais geograficamente — escolha pontos mais afastados.";
    return;
  }

  const { topLeft, topRight, bottomLeft } = calibrarCarta(
    p1, p2, g1, g2, cartaState.baseCanvas.width, cartaState.baseCanvas.height
  );

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = cartaState.baseCanvas.width;
  overlayCanvas.height = cartaState.baseCanvas.height;
  overlayCanvas.getContext("2d").drawImage(cartaState.baseCanvas, 0, 0);

  const overlay = L.imageOverlay.rotated(
    overlayCanvas,
    [topLeft.lat, topLeft.lon],
    [topRight.lat, topRight.lon],
    [bottomLeft.lat, bottomLeft.lon],
    { opacity: DEFAULT_CHART_OPACITY, attribution: "Carta calibrada manualmente" }
  );

  const key = `carta:${cartaState.icao}:${cartaState.carta.codigo || cartaState.carta.nome}`;
  const label = `${cartaState.icao} · ${cartaState.carta.tipo} ${cartaState.carta.nome}`;
  addActiveLayer(key, label, overlay);
  map.fitBounds(overlay.getBounds(), { padding: [30, 30] });

  closeCartaModal();
});
