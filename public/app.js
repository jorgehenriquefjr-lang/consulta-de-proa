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
  .layers(null, { "Espaço aéreo (OpenAIP)": openAipLayer }, { collapsed: true })
  .addTo(map);

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

// Coordenada do Campo 18 do FPL, com ou sem segundos
// (ex.: 1454S05104W ou 145430S0510422W)
const FPL_COORD_REGEX = /^(?:\d{4}[NS]\d{5}|\d{6}[NS]\d{7})[EW]$/;

async function buscarProa(raw) {
  raw = raw.trim().toUpperCase().replace(/\s+/g, "");
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

// ====== Painel de camadas DECEA (GeoAISWEB) ======
async function initLayersPanel() {
  const toggleBtn = document.getElementById("layers-toggle");
  const panel = document.getElementById("layers-panel");
  const closeBtn = document.getElementById("layers-close");
  const tabs = document.querySelectorAll(".layers-tab");
  const tabPanels = {
    camadas: document.getElementById("layers-tab-camadas"),
    selecionadas: document.getElementById("layers-tab-selecionadas"),
  };
  const searchInput = document.getElementById("layers-search");
  const treeEl = document.getElementById("layers-tree");
  const selectedList = document.getElementById("layers-selected-list");
  const selectedEmpty = document.getElementById("layers-selected-empty");

  const activeLayers = new Map(); // nome da camada -> { leaflet, label }
  const checkboxByLayer = new Map(); // nome da camada -> <input> (só existe se já renderizado)

  toggleBtn.addEventListener("click", () => panel.classList.toggle("hidden"));
  closeBtn.addEventListener("click", () => panel.classList.add("hidden"));

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      Object.entries(tabPanels).forEach(([key, el]) => {
        el.classList.toggle("hidden", key !== tab.dataset.tab);
      });
    });
  });

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

initLayersPanel();
