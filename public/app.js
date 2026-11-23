/* =========================================================
   Consulta de Proa — frontend
   Backend: Flask no Render (render_backend/server.py)
   ========================================================= */
const API_BASE = "https://consulta-proas-backend.onrender.com";

// Gere sua chave grátis em openaip.net (conta > API keys) e cole aqui.
const OPENAIP_API_KEY = "c78fad77a276a17e092101fc1c2753b4";

const GEOAISWEB_WMS = "https://geoaisweb.decea.gov.br/geoserver/ICA/wms";
const DECLINACAO_FALLBACK = -21.6; // SBNV aprox. (WMM), só se o backend falhar
const EARTH_RADIUS_NM = 3440.065;
const NM_PARA_KM = 1.852;

// Origem padrão (SBNV). "currentOrigem" é atualizada com o que o backend resolve.
const ORIGEM = {
  icao: "SBNV",
  name: "AERÓDROMO NACIONAL DE AVIAÇÃO",
  city: "GOIÂNIA",
  state: "GO",
  lat: -16.625556,
  lon: -49.349444,
};
let currentOrigem = { ...ORIGEM };

/* ---------------------------------------------------------
   Utilidades gerais
   --------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* modo privado / cota cheia: segue sem persistir */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    toast("Copiado para a área de transferência");
  } catch {
    // Fallback para navegadores sem permissão de clipboard
    const ta = document.createElement("textarea");
    ta.value = texto;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("Copiado");
    } catch {
      toast("Não foi possível copiar");
    }
    ta.remove();
  }
}

async function apiGet(path, params = {}, { timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const qs = new URLSearchParams(params).toString();
    const resp = await fetch(`${API_BASE}${path}${qs ? "?" + qs : ""}`, { signal: ctrl.signal });
    let data = {};
    try {
      data = await resp.json();
    } catch {}
    if (!resp.ok) {
      const err = new Error(data.error || `Erro ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------------------------------------------------
   Geodésia
   --------------------------------------------------------- */
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;

function gc(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distNm = EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { brg: norm360(toDeg(Math.atan2(y, x))), distNm };
}

function destPoint(lat, lon, brgTrue, distNm) {
  const d = distNm / EARTH_RADIUS_NM;
  const th = toRad(brgTrue);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

// Pontos intermediários do círculo máximo (pra checar espaço aéreo cruzado)
function amostrarRota(lat1, lon1, lat2, lon2, passoNm = 0.5) {
  const { brg, distNm } = gc(lat1, lon1, lat2, lon2);
  const n = Math.min(600, Math.max(2, Math.ceil(distNm / passoNm)));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(destPoint(lat1, lon1, brg, (distNm * i) / n));
  return pts;
}

const formatHeading = (deg) => `H${String(Math.round(norm360(deg)) % 360 || 360).padStart(3, "0")}`;
const formatDeg = (deg) => `${String(Math.round(norm360(deg)) % 360 || 360).padStart(3, "0")}°`;

function formatEte(horas) {
  if (!isFinite(horas) || horas <= 0) return "—";
  const totalMin = Math.round(horas * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}

function dmsParts(value, isLat) {
  const hemi = isLat ? (value < 0 ? "S" : "N") : value < 0 ? "W" : "E";
  let abs = Math.abs(value);
  let d = Math.floor(abs);
  let mFloat = (abs - d) * 60;
  let m = Math.floor(mFloat);
  let s = Math.round((mFloat - m) * 60);
  if (s === 60) { s = 0; m += 1; }
  if (m === 60) { m = 0; d += 1; }
  return { d, m, s, hemi };
}

// Coordenada no formato do Campo 18 com segundos: 164527S0492608W
function toCampo18(lat, lon) {
  const a = dmsParts(lat, true);
  const o = dmsParts(lon, false);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(a.d, 2)}${p(a.m, 2)}${p(a.s, 2)}${a.hemi}${p(o.d, 3)}${p(o.m, 2)}${p(o.s, 2)}${o.hemi}`;
}

function toDmsLabel(lat, lon) {
  const a = dmsParts(lat, true);
  const o = dmsParts(lon, false);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(a.d)}°${p(a.m)}'${p(a.s)}"${a.hemi} ${String(o.d).padStart(3, "0")}°${p(o.m)}'${p(o.s)}"${o.hemi}`;
}

function parseCampo18(c) {
  let m = /^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])$/.exec(c);
  if (m) {
    const lat = (+m[1] + +m[2] / 60 + +m[3] / 3600) * (m[4] === "S" ? -1 : 1);
    const lon = (+m[5] + +m[6] / 60 + +m[7] / 3600) * (m[8] === "W" ? -1 : 1);
    return { lat, lon };
  }
  m = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/.exec(c);
  if (m) {
    const lat = (+m[1] + +m[2] / 60) * (m[3] === "S" ? -1 : 1);
    const lon = (+m[4] + +m[5] / 60) * (m[6] === "W" ? -1 : 1);
    return { lat, lon };
  }
  return null;
}

function pontoNoPoligono(lon, lat, anel) {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i];
    const [xj, yj] = anel[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function pontoNaGeometria(lon, lat, geom) {
  if (!geom) return false;
  const poligonos = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return poligonos.some((rings) => {
    if (!rings.length || !pontoNoPoligono(lon, lat, rings[0])) return false;
    return !rings.slice(1).some((hole) => pontoNoPoligono(lon, lat, hole));
  });
}

/* ---------------------------------------------------------
   Declinação magnética (cache local + backend NOAA/WMM)
   --------------------------------------------------------- */
const declCache = new Map();
async function getDeclinacao(lat, lon) {
  const key = `${(Math.round(lat * 2) / 2).toFixed(1)},${(Math.round(lon * 2) / 2).toFixed(1)}`;
  if (declCache.has(key)) return declCache.get(key);
  const p = apiGet("/api/declinacao", { lat: lat.toFixed(3), lon: lon.toFixed(3) }, { timeoutMs: 15000 })
    .then((d) => d.declinacao)
    .catch(() => {
      declCache.delete(key);
      return DECLINACAO_FALLBACK;
    });
  declCache.set(key, p);
  return p;
}

/* ---------------------------------------------------------
   Nascer/pôr do sol (algoritmo do Almanac for Computers / NOAA)
   Retorna horário UTC em horas decimais, ou null (sol não cruza o zênite).
   --------------------------------------------------------- */
function horaSolUTC(date, lat, lon, nascer, zenite) {
  const N = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
  const lngHour = lon / 15;
  const t = N + ((nascer ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = norm360(M + 1.916 * Math.sin(toRad(M)) + 0.02 * Math.sin(toRad(2 * M)) + 282.634);
  let RA = norm360(toDeg(Math.atan(0.91764 * Math.tan(toRad(L)))));
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(toRad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(toRad(zenite)) - sinDec * Math.sin(toRad(lat))) / (cosDec * Math.cos(toRad(lat)));
  if (cosH > 1 || cosH < -1) return null;
  const H = (nascer ? 360 - toDeg(Math.acos(cosH)) : toDeg(Math.acos(cosH))) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  return (((T - lngHour) % 24) + 24) % 24;
}

const fmtHoraUTC = (h) => {
  if (h == null) return "—";
  let min = Math.round(h * 60) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}Z`;
};

/* ---------------------------------------------------------
   METAR: vento e condição (VMC/IMC)
   --------------------------------------------------------- */
function ventoDoMetar(metar) {
  if (!metar) return null;
  const m = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/.exec(metar);
  if (!m) return null;
  let spd = +m[2];
  let gust = m[3] ? +m[3] : null;
  if (m[4] === "MPS") {
    spd = Math.round(spd * 1.944);
    gust = gust ? Math.round(gust * 1.944) : null;
  }
  return { dir: m[1] === "VRB" ? null : +m[1], spd, gust };
}

function condicaoMetar(metar) {
  if (!metar) return null;
  if (/\bCAVOK\b/.test(metar)) return "VMC";
  const corpo = metar.split(/\b(?:TEMPO|BECMG|RMK)\b/)[0];
  const vis = /\s(\d{4})(?:NDV)?\s/.exec(corpo);
  const visM = vis ? +vis[1] : 9999;
  let teto = Infinity;
  for (const c of corpo.matchAll(/\b(BKN|OVC|VV)(\d{3})\b/g)) teto = Math.min(teto, +c[2] * 100);
  return visM >= 5000 && teto >= 1500 ? "VMC" : "IMC";
}

/* ---------------------------------------------------------
   Mapa e camadas base
   --------------------------------------------------------- */
const map = L.map("map", { zoomControl: false, worldCopyJump: true }).setView([ORIGEM.lat, ORIGEM.lon], 9);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.control.scale({ position: "bottomright", metric: true, imperial: false, maxWidth: 120 }).addTo(map);

const baseLayers = {
  topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    subdomains: "abc",
    attribution: "&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)",
  }),
  claro: L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }),
  escuro: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }),
  satelite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 22,
    maxNativeZoom: 19,
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
  }),
};
const baseNomes = { topo: "Topográfico", claro: "Claro", escuro: "Escuro", satelite: "Satélite" };

let baseAtual = store.get("cfg_base", "topo");
if (!baseLayers[baseAtual]) baseAtual = "topo";
baseLayers[baseAtual].addTo(map);

// Fallback automático: o OpenTopoMap limita acessos e deixa "buracos" cinza.
// Se muitos tiles falharem em pouco tempo, troca para o mapa Claro (CARTO).
(function fallbackTopo() {
  let erros = [];
  baseLayers.topo.on("tileerror", () => {
    const agora = Date.now();
    erros = erros.filter((t) => agora - t < 15000);
    erros.push(agora);
    if (erros.length >= 6 && map.hasLayer(baseLayers.topo)) {
      map.removeLayer(baseLayers.topo);
      baseLayers.claro.addTo(map);
      toast("Mapa topográfico instável — trocado para o mapa Claro");
      erros = [];
    }
  });
})();

const openAipLayer = L.tileLayer(`https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=${OPENAIP_API_KEY}`, {
  subdomains: "abc",
  minZoom: 7,
  maxZoom: 18,
  attribution: "Airspace &copy; OpenAIP",
});

const isCompactLayout = window.matchMedia("(max-width: 640px)").matches;
const layersControl = L.control
  .layers(
    Object.fromEntries(Object.entries(baseLayers).map(([k, l]) => [baseNomes[k], l])),
    { "Espaço aéreo (OpenAIP)": openAipLayer },
    { collapsed: true, position: "topright" }
  )
  .addTo(map);

map.on("baselayerchange", (e) => {
  const k = Object.keys(baseLayers).find((key) => baseLayers[key] === e.layer);
  if (k) baseAtual = k;
});

// Radar (RainViewer): mosaico global gratuito
fetch("https://api.rainviewer.com/public/weather-maps.json")
  .then((r) => r.json())
  .then((data) => {
    const frames = data?.radar?.past;
    if (!frames?.length) return;
    const ultimo = frames[frames.length - 1];
    const layer = L.tileLayer(`${data.host}${ultimo.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0.6,
      attribution: "Radar &copy; RainViewer",
    });
    layersControl.addOverlay(layer, "Radar (RainViewer)");
  })
  .catch(() => {});

// Radar REDEMET (Gama/DF)
apiGet("/api/radar")
  .then((data) => {
    if (!data.path || data.lat_min == null) return;
    const layer = L.imageOverlay(data.path, [[data.lat_min, data.lon_min], [data.lat_max, data.lon_max]], {
      opacity: 0.6,
      attribution: `Radar &copy; REDEMET (${data.nome})`,
    });
    layersControl.addOverlay(layer, `Radar REDEMET (${data.nome})`);
  })
  .catch(() => {});

// Tempo Severo Convectivo (REDEMET)
apiGet("/api/tsc")
  .then((data) => {
    const pontos = data.pontos || [];
    if (!pontos.length) return;
    const layer = L.layerGroup(
      pontos.map((p) => L.circleMarker([p.lat, p.lon], { radius: 3, color: "#dc2626", weight: 0, fillOpacity: 0.7 }))
    );
    layersControl.addOverlay(layer, "Tempo Severo Convectivo (REDEMET)");
  })
  .catch(() => {});

// Tabuleiro METAR (REDEMET): ativo por padrão
apiGet("/api/status_aerodromos")
  .then((data) => {
    const pontos = data.pontos || [];
    if (!pontos.length) return;
    const layer = L.layerGroup(
      pontos.map((p) =>
        L.circleMarker([p.lat, p.lon], { radius: 6, color: "#fff", weight: 1, fillColor: p.cor, fillOpacity: 0.9 }).bindPopup(
          `<div class="popup-title">${escapeHtml(p.icao)} — ${escapeHtml(p.nome)}</div>
           <pre style="white-space:pre-wrap;margin:4px 0 0;font-size:11px">${escapeHtml(p.info || "")}</pre>
           <div class="popup-actions"><button class="btn-ghost" data-buscar="${escapeHtml(p.icao)}">Consultar proa</button></div>`
        )
      )
    ).addTo(map);
    layersControl.addOverlay(layer, "Tabuleiro METAR (REDEMET)");
  })
  .catch(() => {});

// Botões "Consultar proa" dentro de popups
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-buscar]");
  if (b) {
    $("icao-input").value = b.dataset.buscar;
    openTab("buscar");
    executarBusca(b.dataset.buscar);
  }
});

/* ---------------------------------------------------------
   Marcadores e camadas de trabalho
   --------------------------------------------------------- */
const icone = (cor) =>
  L.divIcon({
    className: "",
    html: `<svg width="26" height="36" viewBox="0 0 26 36"><path d="M13 0C5.8 0 0 5.8 0 13c0 9.7 13 23 13 23s13-13.3 13-23C26 5.8 20.2 0 13 0z" fill="${cor}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13" r="5" fill="#fff"/></svg>`,
    iconSize: [26, 36],
    iconAnchor: [13, 36],
    popupAnchor: [0, -32],
  });

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
  document.getElementById("layers-active-count").textContent = activeLayers.size || "";
  // Cartas IAC/VAC calibradas à mão não são restauráveis; só as WMS são lembradas.
  store.set(
    "cartas_ativas",
    [...activeLayers.entries()]
      .filter(([name]) => !name.startsWith("carta:"))
      .map(([name, e]) => ({ name, label: e.label }))
  );
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

function origemPopupText(o) {
  const local = [o.city, o.state].filter(Boolean).join("/");
  return `${o.icao} — ${o.name}${local ? ` (${local})` : ""}`;
}

const originMarker = L.marker([currentOrigem.lat, currentOrigem.lon], { icon: icone("#2563eb"), zIndexOffset: 500 })
  .addTo(map)
  .bindPopup(escapeHtml(origemPopupText(currentOrigem)));

const routeLayer = L.layerGroup().addTo(map); // busca direta
const fplLayer = L.layerGroup().addTo(map); // rota FPL
const medirLayer = L.layerGroup().addTo(map); // medição
const destaqueLayer = L.layerGroup().addTo(map); // espaços cruzados destacados
const notamLayer = L.layerGroup().addTo(map); // NOTAM plotados

function updateOrigemUI(o) {
  currentOrigem = o;
  originMarker.setLatLng([o.lat, o.lon]).setPopupContent(escapeHtml(origemPopupText(o)));
  const local = [o.city, o.state].filter(Boolean).join("/");
  $("origem-brand").textContent = `Origem: ${o.icao}${local ? ` — ${local}` : ""}`;
  document.querySelectorAll(".origem-ind").forEach((el) => (el.textContent = o.icao));
}

/* ---------------------------------------------------------
   Painel / abas
   --------------------------------------------------------- */
const TAB_TITULOS = {
  buscar: "Buscar",
  rota: "Rota do FPL",
  medir: "Medir distância e proa",
  camadas: "Camadas",
  historico: "Histórico de consultas",
  ajustes: "Ajustes",
};
const TABS = Object.keys(TAB_TITULOS);
let abaAtual = "buscar";

function setPanelCollapsed(collapsed) {
  $("tool-panel").classList.toggle("collapsed", collapsed);
  $("panel-open").classList.toggle("hidden", !collapsed);
  document.body.classList.toggle("panel-collapsed", collapsed);
  setTimeout(() => map.invalidateSize(), 220);
}

function openTab(name) {
  abaAtual = name;
  setPanelCollapsed(false);
  TABS.forEach((k) => $(`tab-${k}`).classList.toggle("hidden", k !== name));
  document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $("panel-title").textContent = TAB_TITULOS[name];
  if (name === "historico") loadHistory();
  map.getContainer().style.cursor = name === "medir" ? "crosshair" : "";
  $("tool-panel").classList.toggle("short", isCompactLayout && name === "medir");
}

document.querySelectorAll(".tool-btn").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
$("tool-panel-close").addEventListener("click", () => setPanelCollapsed(true));
$("panel-open").addEventListener("click", () => setPanelCollapsed(false));

/* ---------------------------------------------------------
   Tema, relógio UTC, ajustes
   --------------------------------------------------------- */
function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
  store.set("cfg_tema", tema);
  const sel = document.getElementById("cfg-tema");
  if (sel) sel.value = tema;
}
aplicarTema(store.get("cfg_tema", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("theme-toggle").addEventListener("click", () =>
  aplicarTema(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
);

function tickUTC() {
  const d = new Date();
  $("utc-time").textContent = d.toISOString().slice(11, 19);
}
tickUTC();
setInterval(tickUTC, 1000);

const cfg = {
  get operador() {
    return store.get("cfg_operador", "");
  },
  get tas() {
    return +store.get("cfg_tas", 100) || 100;
  },
};

$("cfg-operador").value = cfg.operador;
$("cfg-operador").addEventListener("change", (e) => store.set("cfg_operador", e.target.value.trim()));
$("cfg-tas").value = cfg.tas;
$("tas-input").value = cfg.tas;
$("cfg-tas").addEventListener("change", (e) => {
  store.set("cfg_tas", +e.target.value || 100);
  $("tas-input").value = cfg.tas;
  atualizarVento();
});
$("cfg-base").value = baseAtual;
$("cfg-base").addEventListener("change", (e) => {
  store.set("cfg_base", e.target.value);
  Object.values(baseLayers).forEach((l) => map.removeLayer(l));
  baseLayers[e.target.value].addTo(map);
  baseAtual = e.target.value;
});
$("cfg-tema").value = document.documentElement.dataset.theme;
$("cfg-tema").addEventListener("change", (e) => aplicarTema(e.target.value));
$("cfg-large").checked = store.get("cfg_large", false);
document.documentElement.classList.toggle("large-numbers", $("cfg-large").checked);
$("cfg-large").addEventListener("change", (e) => {
  store.set("cfg_large", e.target.checked);
  document.documentElement.classList.toggle("large-numbers", e.target.checked);
});

/* ---------------------------------------------------------
   Coordenada do cursor + clique direito (consulta rápida)
   --------------------------------------------------------- */
map.on("mousemove", (e) => {
  $("cursor-coord").textContent = toDmsLabel(e.latlng.lat, e.latlng.lng);
});
map.on("mouseout", () => ($("cursor-coord").textContent = ""));

map.on("contextmenu", async (e) => {
  const { lat, lng } = e.latlng;
  const c18 = toCampo18(lat, lng);
  const { brg, distNm } = gc(currentOrigem.lat, currentOrigem.lon, lat, lng);
  const popup = L.popup()
    .setLatLng(e.latlng)
    .setContent(`<div class="popup-title">Ponto no mapa</div><div class="mono">${toDmsLabel(lat, lng)}</div><p class="hint">Calculando…</p>`)
    .openOn(map);
  const decl = await getDeclinacao(lat, lng);
  const pm = norm360(brg - decl);
  const { brg: volta } = gc(lat, lng, currentOrigem.lat, currentOrigem.lon);
  const declO = await getDeclinacao(currentOrigem.lat, currentOrigem.lon);
  popup.setContent(`
    <div class="popup-title">${escapeHtml(currentOrigem.icao)} → ponto</div>
    <div class="popup-grid">
      <b>Proa mag.</b><span class="mono">${formatHeading(pm)}</span>
      <b>Distância</b><span class="mono">${distNm.toFixed(1)} NM</span>
      <b>Volta</b><span class="mono">${formatHeading(norm360(volta - declO))}</span>
      <b>Campo 18</b><span class="mono">${c18}</span>
      <b>Coord.</b><span class="mono">${toDmsLabel(lat, lng)}</span>
    </div>
    <div class="popup-actions">
      <button class="btn-ghost" data-buscar="${c18}">Consulta completa</button>
      <button class="btn-ghost" data-copiar="${c18}">Copiar coord.</button>
    </div>`);
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copiar]");
  if (b) copiar(b.dataset.copiar);
});

/* ---------------------------------------------------------
   BUSCA: interpretação da entrada
   --------------------------------------------------------- */
const FPL_COORD_REGEX = /^(?:\d{4}[NS]\d{5}|\d{6}[NS]\d{7})[EW]$/;

function interpretarEntrada(raw) {
  const s = raw.trim();
  const up = s.toUpperCase();
  const compact = up.replace(/\s+/g, "");

  // Radial/DME: 270/15, R270/15, 270/15NM, 270 15NM
  let m = /^R?(\d{1,3})\s*[/\s]\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:NM|MN)?$/.exec(up);
  if (m && +m[1] <= 360) return { tipo: "radial", radial: +m[1] % 360, dist: +m[2].replace(",", ".") };

  // Campo 18
  if (FPL_COORD_REGEX.test(compact)) return { tipo: "coord", coord: compact };
  if (compact.startsWith("ZZZZ") && FPL_COORD_REGEX.test(compact.slice(4))) return { tipo: "coord", coord: compact.slice(4) };

  // Decimal com ponto: -16.63, -49.35 | -16.63 -49.35
  m = /^(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$/.exec(s);
  if (!m) m = /^(-?\d{1,2},\d+)\s*[;\s]\s*(-?\d{1,3},\d+)$/.exec(s); // decimal com vírgula: -16,63 -49,35
  if (m) {
    const lat = +m[1].replace(",", ".");
    const lon = +m[2].replace(",", ".");
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { tipo: "coord", coord: toCampo18(lat, lon) };
  }

  // Indicativo
  if (/^[A-Z0-9]{3,6}$/.test(compact) && /[A-Z]/.test(compact) && !/\s/.test(s) && s.length <= 6) return { tipo: "icao", icao: compact };

  return { tipo: "nome", q: s };
}

/* ---------------------------------------------------------
   Autocomplete por nome/cidade/indicativo
   --------------------------------------------------------- */
const suggestEl = $("suggest-list");
let sugestoes = [];
let sugestaoAtiva = -1;
let textoSubmetido = null; // evita a lista reabrir com a resposta atrasada da busca

function fecharSugestoes() {
  suggestEl.classList.add("hidden");
  sugestoes = [];
  sugestaoAtiva = -1;
}

function renderSugestoes(lista) {
  sugestoes = lista;
  sugestaoAtiva = -1;
  suggestEl.innerHTML = "";
  if (!lista.length) return fecharSugestoes();
  lista.forEach((r, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const { brg, distNm } = gc(currentOrigem.lat, currentOrigem.lon, r.lat, r.lon);
    li.innerHTML = `<b>${escapeHtml(r.icao)}</b><span>${escapeHtml(r.name)}<br><small style="margin:0">${escapeHtml(
      [r.city, r.state].filter(Boolean).join("/")
    )}</small></span><small>${Math.round(distNm)} NM · ${formatDeg(brg)}V</small>`;
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      escolherSugestao(i);
    });
    suggestEl.appendChild(li);
  });
  suggestEl.classList.remove("hidden");
}

function escolherSugestao(i) {
  const r = sugestoes[i];
  if (!r) return;
  $("icao-input").value = r.icao;
  fecharSugestoes();
  executarBusca(r.icao);
}

const buscarSugestoes = debounce(async (texto) => {
  const it = interpretarEntrada(texto);
  if (texto.trim().length < 2 || it.tipo === "radial" || it.tipo === "coord") return fecharSugestoes();
  try {
    const data = await apiGet("/api/buscar_nome", { q: texto.trim() }, { timeoutMs: 15000 });
    const atual = $("icao-input").value.trim();
    if (atual === texto.trim() && atual !== textoSubmetido && document.activeElement === $("icao-input")) renderSugestoes(data.resultados || []);
  } catch {
    fecharSugestoes();
  }
}, 220);

$("icao-input").addEventListener("input", (e) => {
  textoSubmetido = null;
  buscarSugestoes(e.target.value);
});
$("icao-input").addEventListener("blur", () => setTimeout(fecharSugestoes, 120));
$("icao-input").addEventListener("keydown", (e) => {
  if (suggestEl.classList.contains("hidden")) return;
  const itens = suggestEl.querySelectorAll("li");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sugestaoAtiva = (sugestaoAtiva + (e.key === "ArrowDown" ? 1 : -1) + itens.length) % itens.length;
    itens.forEach((li, i) => li.classList.toggle("active", i === sugestaoAtiva));
    itens[sugestaoAtiva]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && sugestaoAtiva >= 0) {
    e.preventDefault();
    escolherSugestao(sugestaoAtiva);
  } else if (e.key === "Escape") {
    fecharSugestoes();
  }
});

/* ---------------------------------------------------------
   BUSCA: execução
   --------------------------------------------------------- */
function setStatus(text, kind) {
  $("status").textContent = text || "";
  $("status").className = "status" + (kind ? " " + kind : "");
}

let ultimo = null; // último resultado completo
let buscaSeq = 0;

async function executarBusca(raw) {
  const entrada = interpretarEntrada(raw || "");
  textoSubmetido = (raw || "").trim();
  fecharSugestoes();

  if (entrada.tipo === "nome") {
    setStatus("Procurando pelo nome…", "loading");
    try {
      const data = await apiGet("/api/buscar_nome", { q: entrada.q });
      const lista = data.resultados || [];
      if (!lista.length) return setStatus(`Nada encontrado para “${entrada.q}”.`, "error");
      if (lista.length === 1) return executarBusca(lista[0].icao);
      setStatus(`${lista.length} resultados — escolha um:`);
      $("icao-input").focus();
      setTimeout(() => renderSugestoes(lista), 0);
    } catch (e) {
      setStatus(e.message || "Falha na busca por nome.", "error");
    }
    return;
  }

  let rotulo = null;
  let params;
  if (entrada.tipo === "radial") {
    setStatus("Calculando radial/distância…", "loading");
    const decl = await getDeclinacao(currentOrigem.lat, currentOrigem.lon);
    const p = destPoint(currentOrigem.lat, currentOrigem.lon, entrada.radial + decl, entrada.dist);
    params = { icao: "ZZZZ", coord: toCampo18(p.lat, p.lon) };
    rotulo = `Radial ${formatDeg(entrada.radial)} / ${entrada.dist} NM de ${currentOrigem.icao}`;
  } else if (entrada.tipo === "coord") {
    params = { icao: "ZZZZ", coord: entrada.coord };
  } else {
    params = { icao: entrada.icao };
  }

  // Origem customizada (caixa desativada por padrão)
  const origemRaw = $("origem-input").value.trim().toUpperCase().replace(/\s+/g, "");
  if (origemRaw && origemRaw !== "SBNV") {
    const o = interpretarEntrada(origemRaw);
    if (o.tipo === "coord") {
      params.origem_icao = "ZZZZ";
      params.origem_coord = o.coord;
    } else {
      params.origem_icao = origemRaw;
    }
  }

  const matricula = $("matricula-input").value.trim();
  const obs = $("obs-input").value.trim();
  if (matricula) params.matricula = matricula;
  if (obs) params.obs = obs;
  if (cfg.operador) params.operador = cfg.operador;

  const seq = ++buscaSeq;
  setStatus(params.icao === "ZZZZ" ? "Calculando a partir da coordenada…" : "Consultando AISWEB…", "loading");
  const slowHint = setTimeout(() => {
    if (seq === buscaSeq) setStatus("Ainda consultando… o servidor pode estar acordando (até ~1 min).", "loading");
  }, 4000);

  try {
    const data = await apiGet("/api/buscar_proa", params);
    if (seq !== buscaSeq) return; // uma busca mais nova já foi disparada
    if (rotulo) data.destino.name = rotulo;
    else if (data.destino.icao === "ZZZZ" && /^Localidade sem indicador/i.test(data.destino.name || ""))
      data.destino.name = `Coordenada ${toDmsLabel(data.destino.lat, data.destino.lon)}`;
    setStatus("");
    mostrarResultado(data);
    salvarHistoricoLocal(data);
    $("obs-input").value = "";
  } catch (e) {
    if (seq === buscaSeq) setStatus(e.name === "AbortError" ? "Tempo esgotado. Tente de novo." : e.message || "Falha de conexão com o servidor.", "error");
  } finally {
    clearTimeout(slowHint);
  }
}

$("search-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (sugestaoAtiva >= 0) return escolherSugestao(sugestaoAtiva);
  executarBusca($("icao-input").value);
});

/* ---------------------------------------------------------
   Resultado
   --------------------------------------------------------- */
function desenharRotaDireta(origem, destino, pm, distNm) {
  routeLayer.clearLayers();
  fplLayer.clearLayers();
  destaqueLayer.clearLayers();
  notamLayer.clearLayers();

  const pontos = amostrarRota(origem.lat, origem.lon, destino.lat, destino.lon, Math.max(1, distNm / 100)).map((p) => [p.lat, p.lon]);
  const linha = L.polyline(pontos, { color: "#1d4ed8", weight: 3.5 }).addTo(routeLayer);
  linha.bindTooltip(`${formatHeading(pm)} · ${distNm.toFixed(1)} NM`, { permanent: true, direction: "center", className: "route-label" }).openTooltip();

  L.marker([destino.lat, destino.lon], { icon: icone("#f59e0b") })
    .bindPopup(`<div class="popup-title">${escapeHtml(destino.icao)} — ${escapeHtml(destino.name)}</div><div class="mono">${toDmsLabel(destino.lat, destino.lon)}</div>`)
    .addTo(routeLayer);

  // Anéis de distância a cada 10 NM no destino ajudam a referenciar a posição
  enquadrar(linha.getBounds());
}

function enquadrar(bounds) {
  const panelW = $("tool-panel").classList.contains("collapsed") || isCompactLayout ? 0 : $("tool-panel").offsetWidth;
  map.fitBounds(bounds, {
    paddingTopLeft: [panelW + 40, 70],
    paddingBottomRight: [40, isCompactLayout ? window.innerHeight * 0.62 : 60],
    maxZoom: 12,
  });
}

function mostrarResultado(data) {
  ultimo = data;
  const d = data.destino;
  updateOrigemUI(data.origem);

  $("result-card").classList.remove("hidden");
  $("result-name").textContent = d.icao === "ZZZZ" ? d.name : `${d.icao} — ${d.name}`;
  $("result-sub").textContent = [d.city, d.state].filter(Boolean).join("/") || `De ${data.origem.icao}`;
  $("result-proa").textContent = formatHeading(data.proa_magnetica);
  $("result-true").textContent = `Verdadeira ${formatDeg(data.proa_verdadeira)}`;
  $("result-milhas").textContent = `${data.distancia_nm.toFixed(1)} NM`;
  $("result-km").textContent = `${(data.distancia_nm * NM_PARA_KM).toFixed(1)} km`;
  const volta = data.proa_retorno_magnetica ?? norm360(data.proa_magnetica + 180);
  $("result-volta").textContent = formatHeading(volta);
  $("result-decl").textContent = `${Math.abs(data.declinacao_magnetica).toFixed(1)}° ${data.declinacao_magnetica < 0 ? "W" : "E"}`;
  $("result-coord").textContent = toDmsLabel(d.lat, d.lon);

  const temIcao = d.icao && d.icao !== "ZZZZ";
  $("btn-aisweb").classList.toggle("hidden", !temIcao);
  if (temIcao) $("btn-aisweb").href = `https://aisweb.decea.gov.br/?i=aerodromos&codigo=${encodeURIComponent(d.icao)}`;

  // vento começa zerado a cada nova consulta; METAR preenche se houver
  $("wind-dir-input").value = "";
  $("wind-spd-input").value = "";
  $("wind-src").textContent = "";
  $("result-cat").classList.add("hidden");
  atualizarVento();

  desenharRotaDireta(data.origem, d, data.proa_magnetica, data.distancia_nm);
  renderSol(d);
  verificarEspacoAereo(data.origem, d);
  loadMetarTaf(d.icao);
  loadAvisos(d.icao);
  loadNotam(d.icao);
  loadCartas(d);

  if (isCompactLayout) $("result-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ----- vento / proa corrigida ----- */
function calcularVento(cursoV, tas, ventoDe, ventoVel) {
  if (!tas) return null;
  if (ventoDe == null || !ventoVel) return { wca: 0, proaV: cursoV, gs: tas };
  const ang = toRad(ventoDe - cursoV);
  const s = (ventoVel * Math.sin(ang)) / tas;
  if (Math.abs(s) > 1) return { impossivel: true };
  const wca = toDeg(Math.asin(s));
  const gs = tas * Math.cos(toRad(wca)) - ventoVel * Math.cos(ang);
  return { wca, proaV: norm360(cursoV + wca), gs };
}

function atualizarVento() {
  const box = $("wind-result");
  if (!ultimo) {
    box.innerHTML = "";
    return;
  }
  const tas = +$("tas-input").value;
  const dirRaw = $("wind-dir-input").value;
  const dir = dirRaw === "" ? null : +dirRaw;
  const vel = +$("wind-spd-input").value || 0;
  const r = calcularVento(ultimo.proa_verdadeira, tas, dir, vel);
  if (!r) {
    box.innerHTML = "";
    $("result-ete").textContent = "—";
    return;
  }
  if (r.impossivel) {
    box.innerHTML = `<div class="wind-warn">Vento mais forte que a TAS nessa direção — não há proa que mantenha o rumo.</div>`;
    $("result-ete").textContent = "—";
    return;
  }
  const proaM = norm360(r.proaV - ultimo.declinacao_magnetica);
  ultimo._proaCorrigida = dir != null && vel ? proaM : null;
  ultimo._gs = r.gs;
  const ete = ultimo.distancia_nm / r.gs;
  $("result-ete").textContent = formatEte(ete);
  $("result-ete-sub").textContent = `GS ${Math.round(r.gs)} kt · TAS ${tas}`;
  box.innerHTML = `
    <div class="wind-cell main"><span>Proa corrigida</span><b>${formatHeading(proaM)}</b></div>
    <div class="wind-cell"><span>Correção</span><b>${r.wca >= 0 ? "+" : ""}${r.wca.toFixed(0)}°</b></div>
    <div class="wind-cell"><span>GS</span><b>${Math.round(r.gs)} kt</b></div>
    <div class="wind-cell"><span>ETE</span><b>${formatEte(ete)}</b></div>`;
}

["tas-input", "wind-dir-input", "wind-spd-input"].forEach((id) => $(id).addEventListener("input", atualizarVento));

let ultimoMetar = null;
$("btn-vento-metar").addEventListener("click", () => {
  const v = ventoDoMetar(ultimoMetar?.metar);
  if (!v) return toast("Sem vento no METAR do destino");
  if (v.dir == null) {
    toast("Vento variável (VRB) — informe a direção manualmente");
    $("wind-spd-input").value = v.spd;
  } else {
    $("wind-dir-input").value = v.dir;
    $("wind-spd-input").value = v.spd;
  }
  $("wind-src").textContent = `METAR ${ultimoMetar.icao}${v.gust ? ` (rajada ${v.gust} kt)` : ""}`;
  atualizarVento();
});

/* ----- sol ----- */
function renderSol(d) {
  const hoje = new Date();
  const cel = (rot, val) => `<div class="wind-cell"><span>${rot}</span><b>${val}</b></div>`;
  $("sun-box").innerHTML =
    cel("Início crepúsc. civil", fmtHoraUTC(horaSolUTC(hoje, d.lat, d.lon, true, 96))) +
    cel("Nascer do sol", fmtHoraUTC(horaSolUTC(hoje, d.lat, d.lon, true, 90.833))) +
    cel("Pôr do sol", fmtHoraUTC(horaSolUTC(hoje, d.lat, d.lon, false, 90.833))) +
    cel("Fim crepúsc. civil", fmtHoraUTC(horaSolUTC(hoje, d.lat, d.lon, false, 96)));
}

/* ----- METAR/TAF ----- */
async function loadMetarTaf(icao) {
  ultimoMetar = null;
  if (!icao || icao === "ZZZZ") return $("metar-taf-box").classList.add("hidden");
  $("metar-taf-box").classList.remove("hidden");
  $("metar-text").textContent = "Consultando…";
  $("taf-text").textContent = "Consultando…";
  try {
    const data = await apiGet("/api/metar_taf", { icao });
    if (ultimo?.destino.icao !== icao) return;
    ultimoMetar = data;
    $("metar-text").textContent = data.metar || "Não disponível para este aeródromo.";
    $("taf-text").textContent = data.taf || "Não disponível para este aeródromo.";
    const cond = condicaoMetar(data.metar);
    if (cond) {
      $("result-cat").textContent = cond;
      $("result-cat").className = `badge ${cond.toLowerCase()}`;
    }
    // Preenche o vento automaticamente se o operador ainda não digitou
    const v = ventoDoMetar(data.metar);
    if (v && v.dir != null && $("wind-dir-input").value === "") {
      $("wind-dir-input").value = v.dir;
      $("wind-spd-input").value = v.spd;
      $("wind-src").textContent = `Preenchido pelo METAR ${icao}${v.gust ? ` (rajada ${v.gust} kt)` : ""}`;
      atualizarVento();
    }
  } catch {
    $("metar-text").textContent = "Falha ao consultar.";
    $("taf-text").textContent = "Falha ao consultar.";
  }
}

/* ----- Avisos ----- */
function setAvisoText(el, mensagens, vazio) {
  const tem = mensagens && mensagens.length > 0;
  el.textContent = tem ? mensagens.map((m) => m.mens).join("\n\n") : vazio;
  el.classList.toggle("warn", tem);
  return tem ? mensagens.length : 0;
}

async function loadAvisos(icao) {
  if (!icao || icao === "ZZZZ") return $("avisos-box").classList.add("hidden");
  $("avisos-box").classList.remove("hidden");
  ["aviso-aerodromo-text", "sigmet-text", "airmet-text", "gamet-text"].forEach((id) => ($(id).textContent = "Consultando…"));
  $("avisos-count").textContent = "";
  try {
    const data = await apiGet("/api/avisos", { icao });
    if (ultimo?.destino.icao !== icao) return;
    const n =
      setAvisoText($("aviso-aerodromo-text"), data.aviso_aerodromo, "Nenhum aviso de aeródromo vigente.") +
      setAvisoText($("sigmet-text"), data.sigmet, "Nenhum SIGMET vigente.") +
      setAvisoText($("airmet-text"), data.airmet, "Nenhum AIRMET vigente.") +
      setAvisoText($("gamet-text"), data.gamet, "Nenhum GAMET vigente.");
    $("avisos-count").textContent = n ? n : "";
    $("avisos-count").classList.toggle("alert", (data.aviso_aerodromo || []).length > 0);
    if ((data.aviso_aerodromo || []).length) $("avisos-box").open = true;
  } catch (e) {
    ["aviso-aerodromo-text", "sigmet-text", "airmet-text", "gamet-text"].forEach((id) => ($(id).textContent = e.message || "Falha ao consultar."));
  }
}

/* ----- NOTAM (lista + plotagem no mapa com texto ao passar o mouse) ----- */
const notamMarkers = new Map(); // índice do NOTAM -> camadas no mapa

function notamHtml(n) {
  return `<div class="notam-tip"><header><b>${escapeHtml(n.numero || "NOTAM")}</b><span>${escapeHtml(n.inicio)} → ${escapeHtml(n.fim)}</span></header>
    ${n.periodo ? `<small>${escapeHtml(n.periodo)}</small>` : ""}
    <p>${escapeHtml(n.texto)}</p>
    ${n.limite_inf || n.limite_sup ? `<small>Limites: ${escapeHtml(n.limite_inf || "—")} / ${escapeHtml(n.limite_sup || "—")}</small>` : ""}</div>`;
}

const iconeNotam = (qtd, aoLado) =>
  L.divIcon({
    className: "",
    html: `<div class="notam-pin"><span>N</span>${qtd > 1 ? `<i>${qtd}</i>` : ""}</div>`,
    iconSize: [26, 26],
    // NOTAM "do aeródromo" fica ao lado do marcador de destino, sem cobri-lo
    iconAnchor: aoLado ? [-10, 8] : [13, 13],
  });

// Vermelho: restrita/proibida · laranja: perigosa · âmbar: demais
function corNotam(texto) {
  const t = (texto || "").toUpperCase();
  if (/RESTRITA|PROIBIDA/.test(t)) return "#dc2626";
  if (/PERIGOSA/.test(t)) return "#ea580c";
  return "#d97706";
}

function descreverLocalNotam(geo) {
  const g = geo || {};
  if (g.circulos?.length) {
    return g.circulos
      .map((c) => `círculo · raio ${c.raio_nm < 1 ? `${Math.round(c.raio_nm * 1852)} m` : `${c.raio_nm.toFixed(1)} NM (${(c.raio_nm * NM_PARA_KM).toFixed(1)} km)`}`)
      .join(" + ");
  }
  if (g.poligonos?.length) return g.poligonos.map((p) => `área de ${p.length} vértices`).join(" + ");
  if (g.pontos?.length) return "coord. no texto";
  if (g.centro) return `linha Q${g.raio_nm ? ` · raio ${g.raio_nm} NM` : ""}`;
  return "sem coordenada — no aeródromo";
}

function plotarNotams(itens, aerodromo) {
  notamLayer.clearLayers();
  notamMarkers.clear();
  const formas = [];
  const adicionarForma = (camada, idx, area) => {
    camada
      .bindTooltip(notamHtml(itens[idx]), { sticky: true, className: "notam-tooltip", direction: "auto" })
      .addTo(notamLayer);
    camada._estiloNotam = { weight: camada.options.weight, fillOpacity: camada.options.fillOpacity };
    notamMarkers.set(idx, [...(notamMarkers.get(idx) || []), camada]);
    formas.push({ camada, area });
  };
  // Agrupa NOTAM no mesmo ponto: um pino só, tooltip com todos os textos
  const grupos = new Map();
  const adicionar = (lat, lon, idx, origemGeo) => {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (!grupos.has(key)) grupos.set(key, { lat, lon, idxs: new Set(), origemGeo });
    grupos.get(key).idxs.add(idx);
  };

  itens.forEach((n, i) => {
    const g = n.geo || {};
    let plotado = false;
    const cor = corNotam(n.texto);
    (g.circulos || []).forEach((c) => {
      adicionarForma(
        L.circle([c.lat, c.lon], { radius: c.raio_nm * 1852, color: cor, weight: 2, fillColor: cor, fillOpacity: 0.16 }),
        i,
        c.raio_nm * c.raio_nm * Math.PI
      );
      adicionar(c.lat, c.lon, i, "círculo");
      plotado = true;
    });
    (g.poligonos || []).forEach((vertices) => {
      const poligono = L.polygon(vertices.map((v) => [v.lat, v.lon]), { color: cor, weight: 2, fillColor: cor, fillOpacity: 0.16 });
      const b = poligono.getBounds();
      adicionarForma(poligono, i, (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest()) * 3600);
      const lat = vertices.reduce((t, v) => t + v.lat, 0) / vertices.length;
      const lon = vertices.reduce((t, v) => t + v.lon, 0) / vertices.length;
      adicionar(lat, lon, i, "polígono");
      plotado = true;
    });
    const temForma = plotado;
    (g.pontos || []).forEach((p) => {
      adicionar(p.lat, p.lon, i, "texto");
      plotado = true;
    });
    if (g.centro && !temForma) {
      // Raio da linha Q: só desenha quando é local (≤ 50 NM); 999 = FIR inteira
      if (g.raio_nm && g.raio_nm <= 50) {
        const c = L.circle([g.centro.lat, g.centro.lon], {
          radius: g.raio_nm * 1852,
          color: "#d97706",
          weight: 1.5,
          dashArray: "4 6",
          fillOpacity: 0.05,
        })
          .bindTooltip(notamHtml(n), { sticky: true, className: "notam-tooltip", direction: "auto" })
          .addTo(notamLayer);
        notamMarkers.set(i, [...(notamMarkers.get(i) || []), c]);
      }
      if (!plotado) adicionar(g.centro.lat, g.centro.lon, i, "linha Q");
      plotado = true;
    }
    if (!plotado && aerodromo) adicionar(aerodromo.lat, aerodromo.lon, i, "aeródromo");
  });

  grupos.forEach((gr) => {
    const idxs = [...gr.idxs];
    const html = idxs.map((i) => notamHtml(itens[i])).join("");
    const noAerodromo = aerodromo && Math.abs(gr.lat - aerodromo.lat) < 1e-4 && Math.abs(gr.lon - aerodromo.lon) < 1e-4;
    const m = L.marker([gr.lat, gr.lon], { icon: iconeNotam(idxs.length, noAerodromo), zIndexOffset: 800 })
      .bindTooltip(`<div class="notam-tip-wrap">${html}</div>`, { className: "notam-tooltip", direction: "auto", offset: noAerodromo ? [26, -4] : [10, 0] })
      .bindPopup(`<div class="notam-tip-wrap">${html}</div>`, { maxWidth: 380 })
      .addTo(notamLayer);
    idxs.forEach((i) => notamMarkers.set(i, [...(notamMarkers.get(i) || []), m]));
  });

  // Áreas maiores ficam atrás, para as menores continuarem acessíveis ao mouse
  formas.sort((x, y) => x.area - y.area).forEach((f) => f.camada.bringToBack());
}

function destacarNotam(camadas, ativo) {
  (camadas || []).forEach((l) => {
    if (l.setStyle && l._estiloNotam) {
      l.setStyle(ativo ? { weight: 4, fillOpacity: 0.34 } : l._estiloNotam);
    } else if (ativo) {
      l.openTooltip?.();
    } else {
      l.closeTooltip?.();
    }
  });
}

async function loadNotam(icao) {
  const box = $("notam-box");
  const lista = $("notam-list");
  notamLayer.clearLayers();
  if (!icao || icao === "ZZZZ") return box.classList.add("hidden");
  box.classList.remove("hidden");
  $("notam-count").textContent = "";
  lista.innerHTML = `<p class="hint">Consultando…</p>`;
  try {
    const data = await apiGet("/api/notam", { icao });
    if (ultimo?.destino.icao !== icao) return;
    const itens = data.notams || [];
    $("notam-count").textContent = itens.length || "";
    $("notam-count").classList.toggle("alert", itens.length > 0);
    if (!itens.length) {
      lista.innerHTML = `<p class="hint">Nenhum NOTAM vigente.</p>`;
      return;
    }
    box.open = true;
    plotarNotams(itens, ultimo.destino);
    lista.innerHTML = `<p class="hint">Plotados no mapa com a área de cada NOTAM — passe o mouse para ler o texto.</p>`;
    itens.forEach((n, i) => {
      const div = document.createElement("div");
      div.className = "notam-item";
      const onde = descreverLocalNotam(n.geo);
      div.innerHTML = `<header><b>${escapeHtml(n.numero)}</b><span>${escapeHtml(n.inicio)} → ${escapeHtml(n.fim)}</span></header>
        ${n.periodo ? `<small class="hint">${escapeHtml(n.periodo)}</small>` : ""}
        <p>${escapeHtml(n.texto)}</p><small class="hint">📍 ${escapeHtml(onde)}</small>`;
      // Passar o mouse na lista destaca no mapa; clicar centraliza e abre
      div.addEventListener("mouseenter", () => destacarNotam(notamMarkers.get(i), true));
      div.addEventListener("mouseleave", () => destacarNotam(notamMarkers.get(i), false));
      div.addEventListener("click", () => {
        const camadas = notamMarkers.get(i) || [];
        const forma = camadas.find((x) => x.getBounds);
        const pino = camadas.find((x) => x instanceof L.Marker);
        if (forma) enquadrar(forma.getBounds());
        else if (pino) map.setView(pino.getLatLng(), Math.max(map.getZoom(), 11));
        pino?.openPopup();
      });
      lista.appendChild(div);
    });
  } catch (e) {
    // 503 = chave do AISWEB ainda não configurada: mostra o link oficial
    lista.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>
      <a class="btn-ghost small" target="_blank" rel="noopener" href="https://aisweb.decea.gov.br/?i=notam&codigo=${encodeURIComponent(icao)}">Abrir NOTAM no AISWEB ↗</a>`;
  }
}

/* ----- Espaço aéreo cruzado (GeoAISWEB WFS) ----- */
const ESPACOS_ROTA = [
  { layer: "ICA:CTR", tipo: "CTR", cls: "ctr" },
  { layer: "ICA:ATZ", tipo: "ATZ", cls: "atz" },
  { layer: "ICA:TMA", tipo: "TMA", cls: "tma" },
  { layer: "ICA:CTA", tipo: "CTA", cls: "cta" },
];

function nomeFeicao(props, fallback) {
  const chaves = ["nome", "name", "txtname", "nam", "designator", "ident", "codeid", "NOME", "NAME", "IDENT"];
  for (const k of chaves) if (props?.[k]) return String(props[k]);
  return fallback;
}

function limitesFeicao(props) {
  if (!props) return "";
  const achar = (re) => {
    const k = Object.keys(props).find((key) => re.test(key) && props[key] != null && props[key] !== "");
    return k ? String(props[k]) : null;
  };
  const inf = achar(/(inf|lower|lim_?i|base|valdist.*lower)/i);
  const sup = achar(/(sup|upper|lim_?s|teto|valdist.*upper)/i);
  const cls = achar(/^(class|classe|tipo_?class)/i);
  return [cls && `Classe ${cls}`, inf && `Inf ${inf}`, sup && `Sup ${sup}`].filter(Boolean).join(" · ");
}

function tabelaProps(props) {
  return `<table class="props-table">${Object.entries(props || {})
    .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
    .slice(0, 18)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("")}</table>`;
}

async function verificarEspacoAereo(origem, destino) {
  const listaEl = $("airspace-list");
  listaEl.innerHTML = `<p class="hint">Verificando CTR/ATZ/TMA/CTA no GeoAISWEB…</p>`;
  $("airspace-count").textContent = "";
  const pts = amostrarRota(origem.lat, origem.lon, destino.lat, destino.lon, 0.5);
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const bbox = [Math.min(...lons) - 0.1, Math.min(...lats) - 0.1, Math.max(...lons) + 0.1, Math.max(...lats) + 0.1].map((v) => v.toFixed(3)).join(",");
  const alvo = ultimo;

  const resultados = await Promise.allSettled(ESPACOS_ROTA.map((e) => apiGet("/api/wfs", { layer: e.layer, bbox }, { timeoutMs: 30000 })));
  if (ultimo !== alvo) return;

  const cruzados = [];
  let falhas = 0;
  resultados.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      falhas++;
      return;
    }
    (r.value.features || []).forEach((f, j) => {
      const idx = pts.findIndex((p) => pontoNaGeometria(p.lon, p.lat, f.geometry));
      if (idx < 0) return;
      const entradaNm = gc(origem.lat, origem.lon, pts[idx].lat, pts[idx].lon).distNm;
      const destinoDentro = pontoNaGeometria(destino.lon, destino.lat, f.geometry);
      cruzados.push({ esp: ESPACOS_ROTA[i], f, entradaNm, destinoDentro, nome: nomeFeicao(f.properties, `${ESPACOS_ROTA[i].tipo} ${j + 1}`) });
    });
  });

  cruzados.sort((a, b) => a.entradaNm - b.entradaNm);
  $("airspace-count").textContent = cruzados.length || "";
  $("airspace-count").classList.toggle("alert", cruzados.some((c) => c.esp.tipo === "CTR" || c.esp.tipo === "ATZ"));

  if (!cruzados.length) {
    listaEl.innerHTML = falhas === ESPACOS_ROTA.length
      ? `<p class="hint">Não foi possível consultar o GeoAISWEB agora.</p>`
      : `<p class="hint">Nenhuma CTR, ATZ, TMA ou CTA cruzada pela linha direta.${falhas ? " (consulta parcial)" : ""}</p>`;
    return;
  }

  listaEl.innerHTML = "";
  cruzados.forEach((c) => {
    const div = document.createElement("div");
    div.className = `airspace-item ${c.esp.cls}`;
    const lim = limitesFeicao(c.f.properties);
    div.innerHTML = `<strong>${escapeHtml(c.esp.tipo)} · ${escapeHtml(c.nome)}</strong>
      <small>${c.entradaNm < 0.6 ? "Origem dentro" : `Entra a ${c.entradaNm.toFixed(1)} NM`}${c.destinoDentro ? " · destino dentro" : ""}${lim ? " · " + escapeHtml(lim) : ""}</small>`;
    div.addEventListener("click", () => {
      destaqueLayer.clearLayers();
      const g = L.geoJSON(c.f, { style: { color: "#dc2626", weight: 2, fillOpacity: 0.12 } })
        .bindPopup(`<div class="popup-title">${escapeHtml(c.esp.tipo)} · ${escapeHtml(c.nome)}</div>${tabelaProps(c.f.properties)}`)
        .addTo(destaqueLayer);
      enquadrar(g.getBounds());
      g.openPopup();
    });
    listaEl.appendChild(div);
  });
}

/* ----- ações do resultado ----- */
function fraseologia() {
  if (!ultimo) return "";
  const d = ultimo.destino;
  const nome = d.icao === "ZZZZ" ? d.name : `${d.icao} (${d.name})`;
  let t = `${nome}: proa magnética ${formatDeg(ultimo.proa_magnetica).replace("°", "")}, ${Math.round(ultimo.distancia_nm)} milhas.`;
  if (ultimo._proaCorrigida != null) t += ` Corrigida para o vento: ${formatDeg(ultimo._proaCorrigida).replace("°", "")}.`;
  if (ultimo.proa_retorno_magnetica != null) t += ` Retorno a ${ultimo.origem.icao}: proa ${formatDeg(ultimo.proa_retorno_magnetica).replace("°", "")}.`;
  return t;
}

$("btn-copiar").addEventListener("click", () => ultimo && copiar(fraseologia()));
$("btn-centralizar").addEventListener("click", () => {
  const layers = routeLayer.getLayers().filter((l) => l.getBounds);
  if (layers.length) enquadrar(layers[0].getBounds());
});

/* ---------------------------------------------------------
   Pontos salvos (fixos + personalizados do operador)
   --------------------------------------------------------- */
function pontosCustom() {
  return store.get("pontos_custom", []);
}

function renderPontosCustom() {
  document.querySelectorAll("#saved-points .chip.custom").forEach((c) => c.remove());
  const lista = pontosCustom();
  lista.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip custom";
    b.textContent = p.nome;
    b.title = p.coord;
    b.addEventListener("click", () => {
      $("icao-input").value = p.coord;
      executarBusca(p.coord);
    });
    $("saved-points").appendChild(b);
  });

  const ul = $("custom-points-list");
  ul.innerHTML = "";
  $("custom-points-empty").classList.toggle("hidden", lista.length > 0);
  lista.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.nome)} <small class="mono">${escapeHtml(p.coord)}</small></span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remover";
    btn.addEventListener("click", () => {
      const l = pontosCustom();
      l.splice(i, 1);
      store.set("pontos_custom", l);
      renderPontosCustom();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

$("btn-salvar-ponto").addEventListener("click", () => {
  if (!ultimo) return;
  const d = ultimo.destino;
  const coord = d.icao === "ZZZZ" ? toCampo18(d.lat, d.lon) : d.icao;
  // Nome do chip: indicativo, ou o nome/observação digitada, ou a coordenada
  const obs = $("obs-input").value.trim();
  const rotulo = (d.icao !== "ZZZZ" ? d.icao : obs || d.name).slice(0, 28);
  const lista = pontosCustom();
  if (lista.some((p) => p.coord === coord)) return toast("Esse ponto já está salvo");
  lista.push({ nome: rotulo, coord });
  store.set("pontos_custom", lista.slice(-20));
  renderPontosCustom();
  toast(`“${rotulo}” salvo nos pontos (remova em Ajustes)`);
});

document.querySelectorAll("#saved-points .chip:not(.custom)").forEach((btn) =>
  btn.addEventListener("click", () => {
    $("icao-input").value = btn.dataset.coord;
    executarBusca(btn.dataset.coord);
  })
);
renderPontosCustom();

/* ---------------------------------------------------------
   Origem customizável (caixa escondida por padrão)
   --------------------------------------------------------- */
(function initOrigem() {
  const salva = store.get("proa_origem_fixa");
  if (salva) {
    $("origem-input").value = salva;
    $("origem-fixar").checked = true;
  }
  const salvar = () => {
    const v = $("origem-input").value.trim().toUpperCase();
    if ($("origem-fixar").checked && v) store.set("proa_origem_fixa", v);
    else store.remove("proa_origem_fixa");
  };
  $("origem-fixar").addEventListener("change", salvar);
  $("origem-input").addEventListener("change", salvar);
})();

/* ---------------------------------------------------------
   ROTA FPL (Campo 15) com tabela de navegação
   --------------------------------------------------------- */
function setRotaStatus(text, kind) {
  $("rota-status").textContent = text || "";
  $("rota-status").className = "status" + (kind ? " " + kind : "");
}

let rotaTexto = "";

$("rota-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const rota = $("rota-input").value.trim();
  if (!rota) return;
  setRotaStatus("Interpretando rota…", "loading");
  $("rota-result").classList.add("hidden");

  try {
    const data = await apiGet("/api/rota_fpl", { rota });
    const pontos = [
      ...($("rota-incluir-origem").checked ? [{ ident: currentOrigem.icao, tipo: "origem", lat: currentOrigem.lat, lon: currentOrigem.lon }] : []),
      ...data.pontos,
      ...($("rota-incluir-destino").checked && ultimo ? [{ ident: ultimo.destino.icao, tipo: "destino", lat: ultimo.destino.lat, lon: ultimo.destino.lon }] : []),
    ];
    if (pontos.length < 2) return setRotaStatus("A rota precisa de pelo menos dois pontos.", "error");

    // Velocidade do próprio Campo 15 (N0110 = 110 kt; K0200 = km/h), senão TAS padrão
    const vel = /\b([NK])(\d{4})[AFSM]\d{3,4}\b/.exec(rota.toUpperCase());
    const tas = vel ? (vel[1] === "N" ? +vel[2] : Math.round(+vel[2] / NM_PARA_KM)) : cfg.tas;

    await desenharRotaFpl(pontos, tas);

    const nr = data.nao_resolvidos || [];
    setRotaStatus(nr.length ? `Não reconhecidos (aerovias/SID/STAR ou fixo inexistente): ${nr.join(", ")}` : "", nr.length ? "error" : "");
  } catch (e) {
    setRotaStatus(e.message || "Falha de conexão com o servidor.", "error");
  }
});

async function desenharRotaFpl(pontos, tas) {
  fplLayer.clearLayers();
  routeLayer.clearLayers();
  destaqueLayer.clearLayers();

  const declinacoes = await Promise.all(pontos.slice(0, -1).map((p) => getDeclinacao(p.lat, p.lon)));
  const tbody = $("rota-body");
  tbody.innerHTML = "";
  let acum = 0;
  const linhasTexto = [];

  pontos.forEach((p, i) => {
    const ponta = i === 0 || i === pontos.length - 1;
    L.circleMarker([p.lat, p.lon], {
      radius: ponta ? 7 : 5,
      color: ponta ? "#f59e0b" : "#16a34a",
      weight: 2,
      fillColor: ponta ? "#f59e0b" : "#16a34a",
      fillOpacity: 0.9,
    })
      .bindTooltip(p.ident, { permanent: true, direction: "right", className: "fix-label", offset: [6, 0] })
      .bindPopup(`<div class="popup-title">${escapeHtml(p.ident)}</div>${escapeHtml(p.tipo)}<br><span class="mono">${toDmsLabel(p.lat, p.lon)}</span>`)
      .addTo(fplLayer);

    if (i === 0) return;
    const a = pontos[i - 1];
    const { brg, distNm } = gc(a.lat, a.lon, p.lat, p.lon);
    const pm = norm360(brg - declinacoes[i - 1]);
    acum += distNm;
    const ete = distNm / tas;

    L.polyline(amostrarRota(a.lat, a.lon, p.lat, p.lon, Math.max(1, distNm / 50)).map((q) => [q.lat, q.lon]), { color: "#1d4ed8", weight: 3 })
      .bindTooltip(`${formatHeading(pm)} · ${distNm.toFixed(1)} NM`, { permanent: true, direction: "center", className: "route-label" })
      .addTo(fplLayer);

    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(a.ident)} → ${escapeHtml(p.ident)}</td><td>${formatHeading(pm)}</td><td>${distNm.toFixed(1)}</td><td>${acum.toFixed(1)}</td><td>${formatEte(ete)}</td>`;
    tbody.appendChild(tr);
    linhasTexto.push(`${a.ident} → ${p.ident}  ${formatHeading(pm)}  ${distNm.toFixed(1)} NM  (acum ${acum.toFixed(1)})  ${formatEte(ete)}`);
  });

  $("rota-totais").innerHTML = `<span>Pontos <b>${pontos.length}</b></span><span>Total <b>${acum.toFixed(1)} NM</b></span><span>${(acum * NM_PARA_KM).toFixed(0)} km</span><span>ETE <b>${formatEte(acum / tas)}</b> a ${tas} kt</span>`;
  $("rota-result").classList.remove("hidden");
  rotaTexto = linhasTexto.join("\n") + `\nTOTAL ${acum.toFixed(1)} NM · ETE ${formatEte(acum / tas)} @ ${tas} kt`;

  enquadrar(L.latLngBounds(pontos.map((p) => [p.lat, p.lon])));
}

$("btn-rota-copiar").addEventListener("click", () => rotaTexto && copiar(rotaTexto));

/* ---------------------------------------------------------
   MEDIR (proa magnética e verdadeira por trecho)
   --------------------------------------------------------- */
let medirPontos = [];

async function renderMedicao() {
  medirLayer.clearLayers();
  const tbody = $("medir-body");
  tbody.innerHTML = "";
  let total = 0;
  for (let i = 0; i < medirPontos.length; i++) {
    const p = medirPontos[i];
    L.circleMarker(p, { radius: 5, color: "#7c3aed", weight: 2, fillColor: "#7c3aed", fillOpacity: 0.9 }).addTo(medirLayer);
    if (i === 0) continue;
    const a = medirPontos[i - 1];
    const { brg, distNm } = gc(a.lat, a.lng, p.lat, p.lng);
    const decl = await getDeclinacao(a.lat, a.lng);
    const pm = norm360(brg - decl);
    total += distNm;
    L.polyline([a, p], { color: "#7c3aed", weight: 3, dashArray: "5 7" })
      .bindTooltip(`${formatHeading(pm)} · ${distNm.toFixed(1)} NM`, { permanent: true, direction: "center", className: "route-label measure-label" })
      .addTo(medirLayer);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i}</td><td>${formatHeading(pm)}</td><td>${formatDeg(brg)}</td><td>${distNm.toFixed(1)}</td><td>${(distNm * NM_PARA_KM).toFixed(1)}</td>`;
    tbody.appendChild(tr);
  }
  $("medir-total").innerHTML =
    medirPontos.length > 1 ? `<span>Total <b>${total.toFixed(1)} NM</b></span><span><b>${(total * NM_PARA_KM).toFixed(1)} km</b></span><span>ETE <b>${formatEte(total / cfg.tas)}</b> a ${cfg.tas} kt</span>` : "";
}

map.on("click", (e) => {
  if (abaAtual === "medir" && !$("tool-panel").classList.contains("collapsed")) {
    medirPontos.push(e.latlng);
    renderMedicao();
  }
});
$("medir-desfazer").addEventListener("click", () => {
  medirPontos.pop();
  renderMedicao();
});
$("medir-limpar").addEventListener("click", () => {
  medirPontos = [];
  renderMedicao();
});

/* ---------------------------------------------------------
   HISTÓRICO (Firestore via backend + cópia local)
   --------------------------------------------------------- */
let historico = [];

function salvarHistoricoLocal(data) {
  const lista = store.get("historico_local", []);
  lista.unshift({
    consultado_em: data.consultado_em,
    destino: data.destino,
    proa_magnetica: data.proa_magnetica,
    distancia_nm: data.distancia_nm,
    matricula: data.matricula || "",
    observacao: data.observacao || "",
    operador: data.operador || "",
  });
  store.set("historico_local", lista.slice(0, 200));
}

async function loadHistory() {
  try {
    const data = await apiGet("/api/historico", { limit: 200 }, { timeoutMs: 30000 });
    historico = data.resultados?.length ? data.resultados : store.get("historico_local", []);
  } catch {
    historico = store.get("historico_local", []);
  }
  renderHistory();
}

function renderHistory() {
  const q = $("hist-filter").value.trim().toUpperCase();
  const rows = historico.filter((r) =>
    !q ||
    [r.destino?.icao, r.destino?.name, r.destino?.city, r.matricula, r.observacao, r.operador].filter(Boolean).join(" ").toUpperCase().includes(q)
  );
  const tbody = $("history-body");
  tbody.innerHTML = "";
  $("history-empty").classList.toggle("hidden", rows.length > 0);
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const quando = (r.consultado_em || "").replace("T", " ").slice(5, 16);
    const td = (txt, sub) => {
      const c = document.createElement("td");
      c.textContent = txt;
      if (sub) {
        const s = document.createElement("small");
        s.textContent = sub;
        c.appendChild(s);
      }
      return c;
    };
    tr.append(
      td(quando),
      td(r.destino?.icao === "ZZZZ" ? "Coord." : r.destino?.icao ?? "", r.destino?.name),
      td(typeof r.proa_magnetica === "number" ? formatHeading(r.proa_magnetica) : r.proa_magnetica ?? ""),
      td(typeof r.distancia_nm === "number" ? r.distancia_nm.toFixed(1) : r.distancia_nm ?? ""),
      td(r.matricula || "", r.observacao || "")
    );
    tr.addEventListener("click", () => {
      const d = r.destino || {};
      const alvo = d.icao && d.icao !== "ZZZZ" ? d.icao : d.lat != null ? toCampo18(d.lat, d.lon) : null;
      if (!alvo) return;
      $("icao-input").value = alvo;
      openTab("buscar");
      executarBusca(alvo);
    });
    tbody.appendChild(tr);
  });
}

$("hist-filter").addEventListener("input", renderHistory);
$("hist-refresh").addEventListener("click", loadHistory);
$("hist-csv").addEventListener("click", () => {
  if (!historico.length) return toast("Histórico vazio");
  const cab = ["consultado_em_utc", "origem", "destino_icao", "destino_nome", "lat", "lon", "proa_magnetica", "proa_retorno", "distancia_nm", "matricula", "observacao", "operador"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const linhas = historico.map((r) =>
    [r.consultado_em, r.origem?.icao || "SBNV", r.destino?.icao, r.destino?.name, r.destino?.lat, r.destino?.lon, r.proa_magnetica, r.proa_retorno_magnetica, r.distancia_nm, r.matricula, r.observacao, r.operador]
      .map(esc)
      .join(";")
  );
  const blob = new Blob(["﻿" + [cab.join(";"), ...linhas].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `consultas-proa-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* ---------------------------------------------------------
   CAMADAS VETORIAIS (GeoAISWEB WFS) — desenhadas na área visível
   --------------------------------------------------------- */
const VETORES = [
  { key: "CTR", layer: "ICA:CTR", label: "CTR — Zona de Controle", cor: "#dc2626", minZoom: 6 },
  { key: "ATZ", layer: "ICA:ATZ", label: "ATZ — Zona de Tráfego", cor: "#ea580c", minZoom: 7 },
  { key: "TMA", layer: "ICA:TMA", label: "TMA — Área de Controle Terminal", cor: "#2563eb", minZoom: 5 },
  { key: "CTA", layer: "ICA:CTA", label: "CTA — Área de Controle", cor: "#7c3aed", minZoom: 5 },
  { key: "FIX", layer: "ICA:waypoint_aisweb", label: "Fixos / waypoints", cor: "#16a34a", minZoom: 8, pontos: true },
];
const vetorAtivo = new Map(); // key -> { group, statusEl }

function initVetores() {
  const box = $("vector-layers");
  const salvos = store.get("vetores_ativos", []);
  VETORES.forEach((v) => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox"> <span class="swatch" style="border-color:${v.cor};background:${v.cor}22"></span> ${escapeHtml(v.label)} <span class="vl-status"></span>`;
    const cb = label.querySelector("input");
    const statusEl = label.querySelector(".vl-status");
    cb.checked = salvos.includes(v.key);
    cb.addEventListener("change", () => {
      toggleVetor(v, cb.checked, statusEl);
      store.set("vetores_ativos", VETORES.filter((x) => vetorAtivo.has(x.key)).map((x) => x.key));
    });
    box.appendChild(label);
    if (cb.checked) toggleVetor(v, true, statusEl);
  });
  map.on("moveend", debounce(() => vetorAtivo.forEach((st, key) => carregarVetor(VETORES.find((v) => v.key === key), st)), 400));
}

function toggleVetor(v, on, statusEl) {
  if (on) {
    const st = { group: L.layerGroup().addTo(map), statusEl, ids: new Set() };
    vetorAtivo.set(v.key, st);
    carregarVetor(v, st);
  } else {
    const st = vetorAtivo.get(v.key);
    if (st) map.removeLayer(st.group);
    vetorAtivo.delete(v.key);
    statusEl.textContent = "";
  }
}

async function carregarVetor(v, st) {
  if (!v || !st) return;
  if (map.getZoom() < v.minZoom) {
    st.statusEl.textContent = `zoom ≥ ${v.minZoom}`;
    return;
  }
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(3)).join(",");
  st.statusEl.textContent = "…";
  try {
    const data = await apiGet("/api/wfs", { layer: v.layer, bbox }, { timeoutMs: 30000 });
    if (!vetorAtivo.has(v.key)) return;
    let novos = 0;
    (data.features || []).forEach((f, i) => {
      const id = f.id || `${v.key}-${JSON.stringify(f.geometry?.coordinates?.[0]?.[0] ?? f.geometry?.coordinates)}-${i}`;
      if (st.ids.has(id)) return;
      st.ids.add(id);
      novos++;
      const nome = nomeFeicao(f.properties, v.key);
      if (v.pontos) {
        const p = f.properties || {};
        const lat = p.latitude ?? f.geometry?.coordinates?.[1];
        const lon = p.longitude ?? f.geometry?.coordinates?.[0];
        if (lat == null || lon == null) return;
        const m = L.circleMarker([lat, lon], { radius: 3.5, color: v.cor, weight: 1.5, fillColor: "#fff", fillOpacity: 1 })
          .bindPopup(`<div class="popup-title">${escapeHtml(nome)}</div><span class="mono">${toDmsLabel(lat, lon)}</span>
            <div class="popup-actions"><button class="btn-ghost" data-buscar="${toCampo18(lat, lon)}">Proa até aqui</button></div>`);
        if (map.getZoom() >= 10) m.bindTooltip(nome, { permanent: true, direction: "right", className: "fix-label", offset: [4, 0] });
        m.addTo(st.group);
      } else {
        L.geoJSON(f, { style: { color: v.cor, weight: 1.6, fillOpacity: 0.06, dashArray: v.key === "TMA" || v.key === "CTA" ? "6 4" : null } })
          .bindPopup(`<div class="popup-title">${escapeHtml(v.key)} · ${escapeHtml(nome)}</div>${tabelaProps(f.properties)}`)
          .addTo(st.group);
      }
    });
    st.statusEl.textContent = `${st.ids.size}`;
    if (!novos && !st.ids.size) st.statusEl.textContent = "0";
  } catch (e) {
    st.statusEl.textContent = "erro";
    st.statusEl.title = e.message;
  }
}

/* ---------------------------------------------------------
   Catálogo de cartas DECEA (GeoAISWEB WMS)
   --------------------------------------------------------- */
function deceaChartLayer(layerName) {
  return L.tileLayer.wms(GEOAISWEB_WMS, {
    layers: layerName,
    format: "image/png",
    transparent: true,
    version: "1.1.0",
    opacity: +$("chart-opacity").value,
    attribution: "Cartas aeronáuticas &copy; DECEA",
  });
}

async function initLayersTree() {
  const treeEl = $("layers-tree");
  const checkboxByLayer = new Map();

  function setLayerActive(name, label, active) {
    const cb = checkboxByLayer.get(name);
    if (cb) cb.checked = active;
    if (active) {
      if (!activeLayers.has(name)) {
        addActiveLayer(name, label, deceaChartLayer(name), +$("chart-opacity").value, () =>
          setLayerActive(name, label, false)
        );
      }
    } else {
      removeActiveLayer(name);
    }
  }

  $("chart-opacity").addEventListener("input", (e) => {
    activeLayers.forEach((en) => {
      en.opacity = +e.target.value;
      en.leaflet.setOpacity(en.opacity);
    });
    updateSelectedList();
  });

  function makeLayerItem(layer) {
    const div = document.createElement("div");
    div.className = "layers-item";
    const id = `layer-${layer.name}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = activeLayers.has(layer.name);
    cb.addEventListener("change", () => setLayerActive(layer.name, layer.label, cb.checked));
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = layer.label;
    div.append(cb, label);
    checkboxByLayer.set(layer.name, cb);
    return div;
  }

  function makeNode(group, sub = false) {
    const details = document.createElement("details");
    details.className = sub ? "layers-group layers-subgroup" : "layers-group";
    const summary = document.createElement("summary");
    summary.className = sub ? "layers-subgroup-header" : "layers-group-header";
    summary.textContent = group.label;
    details.appendChild(summary);
    const children = document.createElement("div");
    children.className = "layers-group-children";
    let built = false;
    details.addEventListener("toggle", () => {
      if (details.open && !built) {
        built = true;
        (group.layers || []).forEach((l) => children.appendChild(makeLayerItem(l)));
        (group.subgroups || []).forEach((sg) => children.appendChild(makeNode(sg, true)));
      }
    });
    details.appendChild(children);
    return details;
  }

  let catalog;
  try {
    catalog = await (await fetch("decea_layers.json")).json();
  } catch {
    treeEl.textContent = "Falha ao carregar o catálogo de camadas.";
    return;
  }
  catalog.groups.forEach((g) => treeEl.appendChild(makeNode(g)));

  // Restaura cartas que estavam ativas
  store.get("cartas_ativas", []).forEach((c) => setLayerActive(c.name, c.label, true));
  updateSelectedList();

  function forceBuildAll() {
    let closed;
    do {
      closed = treeEl.querySelectorAll("details:not([open])");
      closed.forEach((d) => {
        d.open = true;
        d.dispatchEvent(new Event("toggle"));
      });
    } while (closed.length > 0);
  }

  const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  $("layers-search").addEventListener(
    "input",
    debounce(() => {
      const q = semAcento($("layers-search").value.trim());
      if (!q) {
        treeEl.querySelectorAll(".layers-item, .layers-group").forEach((el) => el.classList.remove("hidden"));
        treeEl.querySelectorAll("details").forEach((d) => (d.open = false));
        return;
      }
      forceBuildAll();
      treeEl.querySelectorAll(".layers-item").forEach((it) => it.classList.toggle("hidden", !semAcento(it.textContent).includes(q)));
      [...treeEl.querySelectorAll(".layers-subgroup"), ...treeEl.querySelectorAll(":scope > .layers-group")].forEach((g) => {
        const has = !!g.querySelector(".layers-item:not(.hidden)");
        g.classList.toggle("hidden", !has);
        g.open = has;
      });
    }, 150)
  );
}

/* ---------------------------------------------------------
   Atalhos de teclado
   --------------------------------------------------------- */
document.addEventListener("keydown", (e) => {
  const digitando = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.altKey && /^[1-6]$/.test(e.key)) {
    e.preventDefault();
    openTab(TABS[+e.key - 1]);
    return;
  }
  if (e.key === "Escape") {
    if (!suggestEl.classList.contains("hidden")) return fecharSugestoes();
    if (digitando) return document.activeElement.blur();
    map.closePopup();
    return setPanelCollapsed(!$("tool-panel").classList.contains("collapsed"));
  }
  if (digitando || e.ctrlKey || e.metaKey) return;
  if (e.key === "/") {
    e.preventDefault();
    openTab("buscar");
    $("icao-input").focus();
    $("icao-input").select();
  } else if (e.key.toLowerCase() === "c" && ultimo) {
    copiar(fraseologia());
  } else if (e.key.toLowerCase() === "t") {
    $("theme-toggle").click();
  }
});

/* ---------------------------------------------------------
   Inicialização
   --------------------------------------------------------- */
updateOrigemUI(currentOrigem);
openTab("buscar");
initVetores();
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
const cartasBox = document.getElementById("cartas-box");
const cartasListEl = document.getElementById("cartas-list");

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

// Se o CDN do pdf.js falhar, só as cartas ficam indisponíveis; o resto segue.
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

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

if (isCompactLayout) setPanelCollapsed(false);

// Acorda o backend (plano gratuito do Render) assim que a página abre
fetch(`${API_BASE}/`).catch(() => {});

// Permite abrir já com uma consulta: ?q=SBGR
const qInicial = new URLSearchParams(location.search).get("q");
if (qInicial) {
  $("icao-input").value = qInicial;
  executarBusca(qInicial);
}
