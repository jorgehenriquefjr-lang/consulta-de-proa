import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone

import firebase_admin
import requests
from firebase_admin import credentials, firestore
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ====== Firebase Admin (Firestore) ======
# O histórico no Firestore é opcional: se não houver credencial configurada
# (ex.: rodando local sem chave), o app funciona normalmente sem histórico.
db = None
try:
    cred_json = os.environ.get("FIREBASE_CREDENTIALS_JSON")
    if cred_json:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(cred_json)))
    else:
        # Uso local: defina GOOGLE_APPLICATION_CREDENTIALS apontando pro seu
        # arquivo de chave de conta de serviço (nunca commitar esse arquivo).
        firebase_admin.initialize_app()
    db = firestore.client()
except Exception:
    db = None

# ====== Ponto de origem fixo: SBNV (Goiânia/GO) ======
ORIGEM = {
    "icao": "SBNV",
    "name": "AERÓDROMO NACIONAL DE AVIAÇÃO",
    "city": "GOIÂNIA",
    "state": "GO",
    "lat": -16.625556,
    "lon": -49.349444,
}

DECLINACAO_FALLBACK = -21.6  # aproximada em SBNV (WMM 2025), usada só se a NOAA falhar

# Backup local com todos os aeródromos do ROTAER/AISWEB, usado só quando a
# consulta ao AISWEB falha ou está indisponível. Gerado a partir do PDF do
# ROTAER completo; pode ter nomes com acentuação perdida (limitação da fonte
# do PDF de origem), mas o indicativo e as coordenadas são confiáveis.
def _load_rotaer_backup():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rotaer_data.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


ROTAER_BACKUP = _load_rotaer_backup()

# Pontos de referência VFR salvos (coordenada do Campo 18 -> nome amigável),
# para exibir o nome certo em vez do genérico "Localidade sem indicador".
KNOWN_POINTS = {
    "164527S0492608W": {"name": "ABADIA DE GOIÁS", "city": "ABADIA DE GOIÁS", "state": "GO"},
    "164110S0491818W": {"name": "HIPÓDROMO", "city": "GOIÂNIA", "state": "GO"},
    "163800S0492800W": {"name": "PORTÃO TRINDADE", "city": "TRINDADE", "state": "GO"},
}

ICAO_RE = re.compile(r"^[A-Z0-9]{3,6}$")
COORD_RE = re.compile(
    r"(\d{2})\s?(\d{2})\s?(\d{2}(?:\.\d+)?)([NS])\s*/\s*(\d{3})\s?(\d{2})\s?(\d{2}(?:\.\d+)?)([EW])"
)
# Coordenada do Campo 18 do FPL, sem segundos, ex.: "1454S05104W"
FPL_COORD_RE = re.compile(r"^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$")
# Mesma coordenada, com segundos, ex.: "164527S0492608W"
FPL_COORD_SEC_RE = re.compile(r"^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])$")

# ====== Campo 15 do FPL (rota): fixos nomeados, DCT, velocidade/nível ======
FIXES_WFS_URL = "https://geoaisweb.decea.gov.br/geoserver/ICA/wfs"
FIX_IDENT_RE = re.compile(r"^[A-Z]{2,5}$")
ROUTE_SKIP_TOKENS = {"DCT", "IFR", "VFR"}
STAY_RE = re.compile(r"^STAY\d{1,2}$")
SPEED_LEVEL_RE = re.compile(r"^[KN]\d{4}[FSMA]\d{3,4}$")

NAME_RE = re.compile(r'title="Nome do Aeródromo">([^<]+)</span>')
CITY_RE = re.compile(r'title="cidade">([^<]+)</span>')
STATE_RE = re.compile(r'title="Estado">([^<]+)</span>')

EARTH_RADIUS_NM = 3440.065

# ====== Cache em memória: evita repetir consultas lentas ao AISWEB/NOAA ======
_cache_lock = threading.Lock()
_aerodromo_cache = {}  # icao -> (expira_em, dado)
_declinacao_cache = {}  # (lat_arredondado, lon_arredondado) -> (expira_em, valor)
AERODROMO_CACHE_TTL = 24 * 3600
DECLINACAO_CACHE_TTL = 7 * 24 * 3600
DECLINACAO_FALLBACK_TTL = 300  # tenta a NOAA de novo em breve se ela estava fora do ar


def dms_to_dd(deg: str, minutes: str, seconds: str, hemisphere: str) -> float:
    dd = int(deg) + int(minutes) / 60 + float(seconds) / 3600
    if hemisphere in ("S", "W"):
        dd = -dd
    return dd


def is_fpl_coord(token: str) -> bool:
    return bool(FPL_COORD_SEC_RE.match(token) or FPL_COORD_RE.match(token))


def parse_fpl_coord(coord: str):
    m = FPL_COORD_SEC_RE.match(coord)
    if m:
        lat_deg, lat_min, lat_sec, lat_h, lon_deg, lon_min, lon_sec, lon_h = m.groups()
        lat = int(lat_deg) + int(lat_min) / 60 + int(lat_sec) / 3600
        if lat_h == "S":
            lat = -lat
        lon = int(lon_deg) + int(lon_min) / 60 + int(lon_sec) / 3600
        if lon_h == "W":
            lon = -lon
        return lat, lon

    m = FPL_COORD_RE.match(coord)
    if not m:
        return None
    lat_deg, lat_min, lat_h, lon_deg, lon_min, lon_h = m.groups()
    lat = int(lat_deg) + int(lat_min) / 60
    if lat_h == "S":
        lat = -lat
    lon = int(lon_deg) + int(lon_min) / 60
    if lon_h == "W":
        lon = -lon
    return lat, lon


def _fetch_aerodromo_aisweb(icao: str):
    url = f"https://aisweb.decea.mil.br/?i=aerodromos&codigo={icao}"
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
    resp.raise_for_status()
    html = resp.text

    name_m = NAME_RE.search(html)
    coord_m = COORD_RE.search(html)
    if not (name_m and coord_m):
        return None

    city_m = CITY_RE.search(html)
    state_m = STATE_RE.search(html)

    lat = dms_to_dd(*coord_m.group(1, 2, 3), coord_m.group(4))
    lon = dms_to_dd(*coord_m.group(5, 6, 7), coord_m.group(8))

    return {
        "icao": icao,
        "name": name_m.group(1).strip(),
        "city": city_m.group(1).strip() if city_m else "",
        "state": state_m.group(1).strip() if state_m else "",
        "lat": lat,
        "lon": lon,
        "fonte": "aisweb",
    }


def fetch_aerodromo(icao: str):
    # Base local primeiro: responde na hora, sem depender de rede nem do
    # AISWEB estar no ar — cobre os 5946 aeródromos do ROTAER completo.
    backup = ROTAER_BACKUP.get(icao)
    if backup:
        return {**backup, "icao": icao, "fonte": "rotaer_backup"}

    # Indicativo fora da base local (ex.: aeródromo novo, cadastrado depois
    # do PDF do ROTAER): tenta o AISWEB como último recurso.
    now = time.time()
    with _cache_lock:
        cached = _aerodromo_cache.get(icao)
        if cached and cached[0] > now:
            return cached[1]

    try:
        aerodromo = _fetch_aerodromo_aisweb(icao)
    except requests.RequestException:
        aerodromo = None

    if aerodromo is not None:
        with _cache_lock:
            _aerodromo_cache[icao] = (now + AERODROMO_CACHE_TTL, aerodromo)
    return aerodromo


def lookup_fixes(idents: list[str]) -> dict:
    """Busca coordenadas de fixos (waypoints) pelo identificador via WFS do DECEA."""
    if not idents:
        return {}

    cql_list = ",".join(f"'{i}'" for i in idents)
    params = {
        "service": "WFS",
        "version": "1.1.0",
        "request": "GetFeature",
        "typeName": "ICA:waypoint_aisweb",
        "outputFormat": "application/json",
        "CQL_FILTER": f"ident IN ({cql_list})",
    }
    resp = requests.get(FIXES_WFS_URL, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    result = {}
    for feat in data.get("features", []):
        props = feat.get("properties", {})
        ident = props.get("ident")
        lat = props.get("latitude")
        lon = props.get("longitude")
        if ident and lat is not None and lon is not None:
            result[ident] = (lat, lon)
    return result


def parse_route(rota: str):
    """
    Interpreta o Campo 15 (rota) de um FPL: coordenadas do Campo 18 e fixos
    nomeados (via base de waypoints do DECEA). Tokens de regra de voo (DCT,
    IFR, VFR), velocidade/nível (ex.: N0230F270) e STAY são ignorados; demais
    tokens não reconhecidos (aerovias, SIDs/STARs) entram em não_resolvidos.
    Retorna (pontos, nao_resolvidos).
    """
    tokens = rota.strip().upper().split()

    parsed_tokens = []  # (ident, "coord" | "fix")
    unknown_tokens = []
    for tok in tokens:
        ident = tok.split("/", 1)[0]
        if not ident or ident in ROUTE_SKIP_TOKENS or STAY_RE.match(ident) or SPEED_LEVEL_RE.match(ident):
            continue
        if is_fpl_coord(ident):
            parsed_tokens.append((ident, "coord"))
        elif FIX_IDENT_RE.match(ident):
            parsed_tokens.append((ident, "fix"))
        else:
            unknown_tokens.append(ident)

    fix_idents = sorted({ident for ident, kind in parsed_tokens if kind == "fix"})
    fix_coords = lookup_fixes(fix_idents)

    pontos = []
    nao_resolvidos = list(unknown_tokens)
    for ident, kind in parsed_tokens:
        if kind == "coord":
            lat, lon = parse_fpl_coord(ident)
            pontos.append({"ident": ident, "tipo": "coordenada", "lat": lat, "lon": lon})
        else:
            coords = fix_coords.get(ident)
            if coords:
                pontos.append({"ident": ident, "tipo": "fixo", "lat": coords[0], "lon": coords[1]})
            else:
                nao_resolvidos.append(ident)

    return pontos, nao_resolvidos


def great_circle(lat1: float, lon1: float, lat2: float, lon2: float):
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    distance_nm = EARTH_RADIUS_NM * c

    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    true_bearing = (math.degrees(math.atan2(y, x)) + 360) % 360

    return distance_nm, true_bearing


def magnetic_declination(lat: float, lon: float) -> float:
    key = (round(lat, 1), round(lon, 1))
    now = time.time()
    with _cache_lock:
        cached = _declinacao_cache.get(key)
        if cached and cached[0] > now:
            return cached[1]

    try:
        today = datetime.now(timezone.utc)
        url = (
            "https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination"
            f"?lat1={lat}&lon1={lon}&resultFormat=json"
            f"&startYear={today.year}&startMonth={today.month}&startDay={today.day}"
            "&key=zNEw7"
        )
        r = requests.get(url, timeout=6)
        r.raise_for_status()
        value = float(r.json()["result"][0]["declination"])
        ttl = DECLINACAO_CACHE_TTL
    except Exception:
        value = DECLINACAO_FALLBACK
        ttl = DECLINACAO_FALLBACK_TTL

    with _cache_lock:
        _declinacao_cache[key] = (now + ttl, value)
    return value


@app.route("/")
def health():
    return jsonify({"status": "ok", "service": "consulta-de-proas-backend"})


@app.route("/api/buscar_proa")
def buscar_proa():
    icao = (request.args.get("icao") or "").strip().upper()

    # Se vier só a coordenada no campo icao (sem ZZZZ), trata como Campo 18 também
    if is_fpl_coord(icao.replace(" ", "")):
        icao, coord_override = "ZZZZ", icao.replace(" ", "")
    else:
        coord_override = None

    if icao == "ZZZZ":
        coord_raw = coord_override or (request.args.get("coord") or "").strip().upper().replace(" ", "")
        parsed = parse_fpl_coord(coord_raw)
        if not parsed:
            return jsonify({
                "error": "Coordenada inválida para ZZZZ. Use o formato do Campo 18 do FPL, "
                         "com ou sem segundos (ex.: 1454S05104W ou 145430S0510422W)."
            }), 400
        lat, lon = parsed
        known = KNOWN_POINTS.get(coord_raw)
        destino = {
            "icao": "ZZZZ",
            "name": known["name"] if known else "Localidade sem indicador (coordenadas do Campo 18)",
            "city": known["city"] if known else "",
            "state": known["state"] if known else "",
            "lat": lat,
            "lon": lon,
        }
    else:
        if not ICAO_RE.match(icao):
            return jsonify({"error": "IND LOC inválido. Use de 3 a 6 letras/números (ex.: SBGR, SDL7) ou ZZZZ com coordenada."}), 400

        try:
            destino = fetch_aerodromo(icao)
        except requests.RequestException:
            return jsonify({"error": "Falha ao consultar o AISWEB. Tente novamente."}), 502

        if not destino:
            return jsonify({"error": f"Aeródromo {icao} não encontrado no AISWEB nem no backup local."}), 404

    distancia_nm, proa_verdadeira = great_circle(
        ORIGEM["lat"], ORIGEM["lon"], destino["lat"], destino["lon"]
    )
    declinacao = magnetic_declination(destino["lat"], destino["lon"])
    proa_magnetica = (proa_verdadeira - declinacao) % 360

    resultado = {
        "origem": ORIGEM,
        "destino": destino,
        "distancia_nm": round(distancia_nm, 1),
        "proa_verdadeira": round(proa_verdadeira, 1),
        "declinacao_magnetica": round(declinacao, 2),
        "proa_magnetica": round(proa_magnetica, 1),
        "consultado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    if db is not None:
        # Grava em segundo plano: histórico é best-effort e não pode
        # atrasar a resposta da busca (escritas no Firestore podem demorar).
        def _save():
            try:
                db.collection("consultas").add(resultado)
            except Exception:
                pass

        threading.Thread(target=_save, daemon=True).start()

    return jsonify(resultado)


@app.route("/api/rota_fpl")
def rota_fpl():
    rota = (request.args.get("rota") or "").strip()
    if not rota:
        return jsonify({"error": "Informe a rota (Campo 15 do FPL)."}), 400

    try:
        pontos, nao_resolvidos = parse_route(rota)
    except requests.RequestException:
        return jsonify({"error": "Falha ao consultar a base de fixos (DECEA). Tente novamente."}), 502

    if not pontos:
        return jsonify({
            "error": "Nenhum ponto reconhecido na rota informada.",
            "nao_resolvidos": nao_resolvidos,
        }), 400

    return jsonify({"pontos": pontos, "nao_resolvidos": nao_resolvidos})


@app.route("/api/historico")
def historico():
    if db is None:
        return jsonify({"resultados": []})

    try:
        limit = min(max(int(request.args.get("limit", 50)), 1), 200)
    except ValueError:
        limit = 50

    docs = (
        db.collection("consultas")
        .order_by("consultado_em", direction=firestore.Query.DESCENDING)
        .limit(limit)
        .stream()
    )
    return jsonify({"resultados": [d.to_dict() for d in docs]})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False, threaded=True)
