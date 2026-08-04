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
  loadCartas(data.destino);
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

// ====== Cartas de aproximação (IAC/VAC): lista por aeródromo + posicionamento ======
// Não existe fonte georreferenciada pra essas cartas (são PDFs de procedimento,
// não WMS). Em vez de pedir 2 pontos com coordenadas digitadas à mão (dá
// margem a erro grosseiro: usar dois aeródromos distantes como referência já
// fez a carta virar do tamanho do Atlântico), o usuário marca só 1 clique —
// o símbolo do aeródromo na carta — que é ancorado automaticamente nas
// coordenadas reais do aeródromo pesquisado (sempre corretas, sem digitação).
// Rotação e tamanho ficam num painel com sliders e preview ao vivo sobre o
// mapa, pra alinhar visualmente com a pista real no satélite.
async function loadCartas(destino) {
  const icao = destino && destino.icao;
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
      btn.addEventListener("click", () => openCartaModal(destino, carta));
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

const cartaAjustePanel = document.getElementById("carta-ajuste-panel");
const cartaAjusteTitle = document.getElementById("carta-ajuste-title");
const cartaAjusteRemover = document.getElementById("carta-ajuste-remover");
const cartaRotSlider = document.getElementById("carta-rot-slider");
const cartaRotValor = document.getElementById("carta-rot-valor");
const cartaEscalaSlider = document.getElementById("carta-escala-slider");
const cartaEscalaValor = document.getElementById("carta-escala-valor");
const cartaAjusteConcluir = document.getElementById("carta-ajuste-concluir");

const DEFAULT_CARTA_LARGURA_NM = 30;
const METROS_POR_NM = 1852;

let cartaState = null; // { destino, carta, baseCanvas }
let cartaAjusteState = null; // { overlay, key, anchorPx, anchorLatLon, canvasW, canvasH }

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

async function openCartaModal(destino, carta) {
  cartaModal.classList.remove("hidden");
  cartaModalTitle.textContent = `${destino.icao} · ${carta.tipo} ${carta.nome}`;
  cartaModalStatus.textContent = "Carregando carta...";

  cartaState = { destino, carta, baseCanvas: null };

  try {
    const resp = await fetch(`${API_BASE}/api/carta_pdf?arquivo=${carta.arquivo}`);
    if (!resp.ok) throw new Error("download falhou");
    const bytes = await resp.arrayBuffer();
    const baseCanvas = await renderCartaPdf(bytes);

    cartaState.baseCanvas = baseCanvas;
    cartaCanvas.width = baseCanvas.width;
    cartaCanvas.height = baseCanvas.height;
    cartaCanvas.getContext("2d").drawImage(baseCanvas, 0, 0);
    cartaModalStatus.textContent = "Clique no símbolo do aeródromo (ARP) na carta.";
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
  posicionarCartaInicial({ x, y });
});

// ====== Matemática do posicionamento: 1 ponto ancorado (pixel <-> lat/lon
// real do aeródromo) + rotação/escala escolhidas pelo usuário definem uma
// transformação de similaridade, usando números complexos e uma aproximação
// planar local (equirretangular, válida na escala de poucos km de uma carta
// de aproximação). Como a escala e a rotação vêm de sliders com limites
// sãos (5-100 NM, 0-359°), nunca dá pra sair do controle como o método
// antigo de 2 pontos digitados. ======
const METROS_POR_GRAU_LAT = 111320;
function metrosPorGrauLon(latGraus) {
  return 111320 * Math.cos((latGraus * Math.PI) / 180);
}
function complexMul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function complexAdd(a, b) {
  return { re: a.re + b.re, im: a.im + b.im };
}
function metrosLocaisParaLatLon(x, y, lat0, lon0) {
  return { lat: lat0 - y / METROS_POR_GRAU_LAT, lon: lon0 + x / metrosPorGrauLon(lat0) };
}

function calcularCantosPosicionados(anchorPx, anchorLatLon, rotationDeg, metrosPorPixel, larguraPx, alturaPx) {
  const rad = (rotationDeg * Math.PI) / 180;
  // "a" é o número complexo de rotação+escala; multiplicar um vetor pixel por
  // ele gira (sentido horário na tela) e escala pra metros de uma vez só.
  const a = { re: metrosPorPixel * Math.cos(rad), im: metrosPorPixel * Math.sin(rad) };
  const zAncoraPx = { re: anchorPx.x, im: anchorPx.y };
  // b é o deslocamento (em metros, a partir do ponto ancorado) do canto (0,0)
  // da imagem: -a*zAncoraPx, já que o próprio ponto ancorado fica em (0,0) metros.
  const aVezesAncora = complexMul(a, zAncoraPx);
  const b = { re: -aVezesAncora.re, im: -aVezesAncora.im };

  const transformar = (x, y) => {
    const z = complexAdd(complexMul(a, { re: x, im: y }), b);
    return metrosLocaisParaLatLon(z.re, z.im, anchorLatLon.lat, anchorLatLon.lon);
  };

  return {
    topLeft: transformar(0, 0),
    topRight: transformar(larguraPx, 0),
    bottomLeft: transformar(0, alturaPx),
  };
}

function recalcularCartaOverlay() {
  if (!cartaAjusteState) return;
  const rotationDeg = Number(cartaRotSlider.value);
  const larguraNM = Number(cartaEscalaSlider.value);
  const metrosPorPixel = (larguraNM * METROS_POR_NM) / cartaAjusteState.canvasW;

  const { topLeft, topRight, bottomLeft } = calcularCantosPosicionados(
    cartaAjusteState.anchorPx,
    cartaAjusteState.anchorLatLon,
    rotationDeg,
    metrosPorPixel,
    cartaAjusteState.canvasW,
    cartaAjusteState.canvasH
  );
  cartaAjusteState.overlay.reposition(
    [topLeft.lat, topLeft.lon],
    [topRight.lat, topRight.lon],
    [bottomLeft.lat, bottomLeft.lon]
  );

  cartaRotValor.textContent = `${rotationDeg}°`;
  cartaEscalaValor.textContent = `${larguraNM} NM`;
}

cartaRotSlider.addEventListener("input", recalcularCartaOverlay);
cartaEscalaSlider.addEventListener("input", recalcularCartaOverlay);

cartaAjusteConcluir.addEventListener("click", () => {
  cartaAjustePanel.classList.add("hidden");
  cartaAjusteState = null;
});

cartaAjusteRemover.addEventListener("click", () => {
  if (cartaAjusteState) removeActiveLayer(cartaAjusteState.key);
  cartaAjustePanel.classList.add("hidden");
  cartaAjusteState = null;
});

function posicionarCartaInicial(anchorPx) {
  const { destino, carta, baseCanvas } = cartaState;

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = baseCanvas.width;
  overlayCanvas.height = baseCanvas.height;
  overlayCanvas.getContext("2d").drawImage(baseCanvas, 0, 0);

  const anchorLatLon = { lat: destino.lat, lon: destino.lon };
  const metrosPorPixel = (DEFAULT_CARTA_LARGURA_NM * METROS_POR_NM) / baseCanvas.width;
  const { topLeft, topRight, bottomLeft } = calcularCantosPosicionados(
    anchorPx, anchorLatLon, 0, metrosPorPixel, baseCanvas.width, baseCanvas.height
  );

  const overlay = L.imageOverlay.rotated(
    overlayCanvas,
    [topLeft.lat, topLeft.lon],
    [topRight.lat, topRight.lon],
    [bottomLeft.lat, bottomLeft.lon],
    { opacity: DEFAULT_CHART_OPACITY, attribution: "Carta posicionada manualmente" }
  );

  const key = `carta:${destino.icao}:${carta.codigo || carta.nome}`;
  const label = `${destino.icao} · ${carta.tipo} ${carta.nome}`;
  addActiveLayer(key, label, overlay);
  map.fitBounds(overlay.getBounds(), { padding: [40, 40] });

  cartaAjusteState = {
    overlay,
    key,
    anchorPx,
    anchorLatLon,
    canvasW: baseCanvas.width,
    canvasH: baseCanvas.height,
  };
  cartaAjusteTitle.textContent = label;
  cartaRotSlider.value = "0";
  cartaEscalaSlider.value = String(DEFAULT_CARTA_LARGURA_NM);
  cartaRotValor.textContent = "0°";
  cartaEscalaValor.textContent = `${DEFAULT_CARTA_LARGURA_NM} NM`;
  cartaAjustePanel.classList.remove("hidden");

  closeCartaModal();
}
