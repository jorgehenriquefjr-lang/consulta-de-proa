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
  .layers(null, { "Espaço aéreo (OpenAIP)": openAipLayer }, {
    collapsed: true,
    position: isCompactLayout ? "bottomleft" : "topright",
  })
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

// Cartas oficiais do DECEA (GeoAISWEB): catálogo completo no painel de camadas
const GEOAISWEB_WMS = "https://geoaisweb.decea.gov.br/geoserver/ICA/wms";
function decealChartLayer(layerName) {
  return L.tileLayer.wms(GEOAISWEB_WMS, {
    layers: layerName,
    format: "image/png",
    transparent: true,
    version: "1.1.0",
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
  });

  const latlngs = pontos.map((p) => [p.lat, p.lon]);
  const line = L.polyline(latlngs, { color: "#16a34a", weight: 3, dashArray: "6 6" });
  fplLayer.addLayer(line);

  map.fitBounds(line.getBounds(), { padding: [30, 30] });
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
  const selectedList = document.getElementById("layers-selected-list");
  const selectedEmpty = document.getElementById("layers-selected-empty");

  const activeLayers = new Map(); // nome da camada -> { leaflet, label }
  const checkboxByLayer = new Map(); // nome da camada -> <input> (só existe se já renderizado)

  function updateSelectedList() {
    selectedList.innerHTML = "";
    selectedEmpty.classList.toggle("hidden", activeLayers.size > 0);
    activeLayers.forEach((entry, name) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = entry.label;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Remover";
      btn.addEventListener("click", () => setLayerActive(name, entry.label, false));
      li.appendChild(span);
      li.appendChild(btn);
      selectedList.appendChild(li);
    });
  }

  function setLayerActive(name, label, active) {
    const checkbox = checkboxByLayer.get(name);
    if (checkbox) checkbox.checked = active;

    if (active) {
      if (!activeLayers.has(name)) {
        const leaflet = decealChartLayer(name).addTo(map);
        activeLayers.set(name, { leaflet, label });
      }
    } else {
      const entry = activeLayers.get(name);
      if (entry) {
        map.removeLayer(entry.leaflet);
        activeLayers.delete(name);
      }
    }
    updateSelectedList();
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
