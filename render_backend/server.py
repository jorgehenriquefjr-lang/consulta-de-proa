import json
import math
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import firebase_admin
import requests
from dotenv import load_dotenv
from firebase_admin import credentials, firestore
from flask import Flask, jsonify, request
from flask_cors import CORS

# Em produção (Render) as variáveis vêm do painel; localmente, do .env ao lado
# deste arquivo (nunca commitado — está no .gitignore).
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

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

# ====== API oficial do AISWEB (DECEA) ======
# Muito mais rápida e confiável que o scraping de HTML: usada como primeira
# tentativa em fetch_aerodromo/fetch_metar_taf, com o scraping como reserva
# para quando a chave não estiver configurada ou a API falhar/ficar fora do ar.
# Configure AISWEB_API_KEY/AISWEB_API_PASS como variáveis de ambiente (nunca
# commitar esses valores no código, já que o repositório é público).
AISWEB_API_BASE = "https://aisweb.decea.mil.br/api/"
AISWEB_API_KEY = os.environ.get("AISWEB_API_KEY", "")
AISWEB_API_PASS = os.environ.get("AISWEB_API_PASS", "")
AISWEB_API_TIMEOUT_S = 6

# ====== Origem padrão: SBNV (Goiânia/GO) — pode ser trocada por parâmetro ======
ORIGEM = {
    "icao": "SBNV",
    "name": "AERÓDROMO NACIONAL DE AVIAÇÃO",
    "city": "GOIÂNIA",
    "state": "GO",
    "lat": -16.625556,
    "lon": -49.349444,
}

DECLINACAO_FALLBACK = -21.6  # aproximada em SBNV (WMM 2025), usada só se a NOAA falhar

# ====== API-REDEMET (avisos): SIGMET, GAMET, aviso de aeródromo e radar ======
REDEMET_API_KEY = os.environ.get("REDEMET_API_KEY", "")
REDEMET_BASE_URL = "https://api-redemet.decea.mil.br"

# Estações de radar meteorológico da REDEMET (raio de 400km cada). "ga" (Gama/DF)
# é a mais próxima da região de SBNV/Goiânia, por isso é o padrão do endpoint.
RADAR_STATIONS = {
    "al": "Almenara/MG", "be": "Belém/PA", "bv": "Boa Vista/RR", "cn": "Canguçu/RS",
    "cz": "Cruzeiro do Sul/AC", "ga": "Gama/DF", "jr": "Jaraguari/MS", "mq": "Macapá/AP",
    "mo": "Maceió/AL", "mn": "Manaus/AM", "mi": "Morro da Igreja/SC", "nt": "Natal/RN",
    "pl": "Petrolina/PE", "pc": "Pico do Couto/RJ", "pv": "Porto Velho/RO", "sv": "Salvador/BA",
    "sn": "Santarém/PA", "st": "Santa Teresa/MG", "sg": "Santiago/RS", "sf": "São Francisco/MG",
    "ua": "São Gabriel da Cachoeira/AM", "sl": "São Luís/MA", "sr": "São Roque/SP",
    "tt": "Tabatinga/AM", "tf": "Tefé/AM", "tm": "Três Marias/MG",
}
RADAR_TIPOS = {"maxcappi", "10km", "07km", "05km", "03km"}

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

# METAR e TAF vêm prontos (texto puro, direto da REDEMET) na própria página do
# AISWEB. SPECI não tem seção própria: quando o mais recente é um SPECI em vez
# de METAR de rotina, a mensagem já vem com "SPECI ..." no lugar de "METAR ...".
METAR_HTML_RE = re.compile(r'heading-primary">METAR</h5>\s*<p>([^<]*)</p>', re.IGNORECASE)
TAF_HTML_RE = re.compile(r'heading-primary">TAF</h5>\s*<p>([^<]*)</p>', re.IGNORECASE)

EARTH_RADIUS_NM = 3440.065

# ====== Cache em memória: evita repetir consultas lentas ao AISWEB/NOAA ======
_cache_lock = threading.Lock()
_aerodromo_cache = {}  # icao -> (expira_em, dado)
_declinacao_cache = {}  # (lat_arredondado, lon_arredondado) -> (expira_em, valor)
_metar_taf_cache = {}  # icao -> (expira_em, dado)
_avisos_cache = {}  # (icao, pais) -> (expira_em, dado)
AERODROMO_CACHE_TTL = 24 * 3600
DECLINACAO_CACHE_TTL = 7 * 24 * 3600
DECLINACAO_FALLBACK_TTL = 300  # tenta a NOAA de novo em breve se ela estava fora do ar
METAR_TAF_CACHE_TTL = 10 * 60  # METAR/TAF mudam com frequência; cache curto só evita rajada de cliques
AVISOS_CACHE_TTL = 10 * 60  # SIGMET/GAMET/aviso de aeródromo mudam com frequência
_radar_cache = {}  # (area, tipo) -> (expira_em, dado)
RADAR_CACHE_TTL = 10 * 60  # imagens de radar são geradas a cada ~10min
_tsc_cache = {}  # "tsc" -> (expira_em, dado)
TSC_CACHE_TTL = 10 * 60  # células de tempo severo convectivo mudam com frequência
_status_aerodromos_cache = {}  # pais -> (expira_em, dado)
STATUS_AERODROMOS_CACHE_TTL = 10 * 60  # acompanha a frequência de atualização do METAR

# Cores de categoria de voo retornadas por /aerodromos/status (VFR/marginal/IFR).
STATUS_COR_HEX = {
    "g": "#22c55e",
    "gw": "#22c55e",
    "y": "#eab308",
    "r": "#ef4444",
    "cinza": "#9ca3af",
}


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


def _fetch_aerodromo_aisweb_api(icao: str):
    """Consulta area=rotaer da API oficial do AISWEB. Retorna None se a chave
    não estiver configurada, o aeródromo não existir ou a resposta vier
    incompleta (o chamador cai de volta pro scraping de HTML nesses casos)."""
    if not (AISWEB_API_KEY and AISWEB_API_PASS):
        return None

    resp = requests.get(
        AISWEB_API_BASE,
        params={
            "apiKey": AISWEB_API_KEY,
            "apiPass": AISWEB_API_PASS,
            "area": "rotaer",
            "icaoCode": icao,
        },
        timeout=AISWEB_API_TIMEOUT_S,
    )
    resp.raise_for_status()
    root = ET.fromstring(resp.content)

    if root.find("error") is not None:
        return None

    name_el, city_el, uf_el = root.find("name"), root.find("city"), root.find("uf")
    lat_el, lng_el = root.find("lat"), root.find("lng")
    if name_el is None or lat_el is None or lng_el is None:
        return None
    if not (name_el.text and lat_el.text and lng_el.text):
        return None

    return {
        "icao": icao,
        "name": name_el.text.strip(),
        "city": city_el.text.strip() if city_el is not None and city_el.text else "",
        "state": uf_el.text.strip() if uf_el is not None and uf_el.text else "",
        "lat": float(lat_el.text),
        "lon": float(lng_el.text),
        "fonte": "aisweb_api",
    }


def _fetch_metar_taf_api(icao: str):
    """Consulta area=met da API oficial do AISWEB. Retorna None se a chave não
    estiver configurada, para o chamador cair de volta pro scraping de HTML."""
    if not (AISWEB_API_KEY and AISWEB_API_PASS):
        return None

    resp = requests.get(
        AISWEB_API_BASE,
        params={
            "apiKey": AISWEB_API_KEY,
            "apiPass": AISWEB_API_PASS,
            "area": "met",
            "icaoCode": icao,
        },
        timeout=AISWEB_API_TIMEOUT_S,
    )
    resp.raise_for_status()
    root = ET.fromstring(resp.content)

    met_el = root.find("met")
    if met_el is None:
        return None

    metar_el, taf_el = met_el.find("metar"), met_el.find("taf")
    return {
        "metar": metar_el.text.strip() if metar_el is not None and metar_el.text else None,
        "taf": taf_el.text.strip() if taf_el is not None and taf_el.text else None,
    }


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
    # API oficial primeiro (mais rápida e sem precisar parsear HTML); scraping
    # da página como reserva se a chave não estiver configurada ou a API
    # falhar. Fica em cache por 24h depois da 1ª consulta bem-sucedida.
    now = time.time()
    with _cache_lock:
        cached = _aerodromo_cache.get(icao)
        if cached and cached[0] > now:
            return cached[1]

    try:
        aerodromo = _fetch_aerodromo_aisweb_api(icao)
    except (requests.RequestException, ET.ParseError, ValueError):
        aerodromo = None

    if aerodromo is None:
        try:
            aerodromo = _fetch_aerodromo_aisweb(icao)
        except requests.RequestException:
            aerodromo = None

    # Só recorre à base local do ROTAER se tudo acima falhar, demorar demais
    # ou não conhecer o indicativo (ex.: durante um cold start do Render).
    if aerodromo is None:
        backup = ROTAER_BACKUP.get(icao)
        if backup:
            aerodromo = {**backup, "icao": icao, "fonte": "rotaer_backup"}

    if aerodromo is not None:
        with _cache_lock:
            _aerodromo_cache[icao] = (now + AERODROMO_CACHE_TTL, aerodromo)
    return aerodromo


def fetch_metar_taf(icao: str):
    now = time.time()
    with _cache_lock:
        cached = _metar_taf_cache.get(icao)
        if cached and cached[0] > now:
            return cached[1]

    try:
        resultado = _fetch_metar_taf_api(icao)
    except (requests.RequestException, ET.ParseError):
        resultado = None

    if resultado is None:
        url = f"https://aisweb.decea.mil.br/?i=aerodromos&codigo={icao}"
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        resp.raise_for_status()
        html = resp.text

        metar_m = METAR_HTML_RE.search(html)
        taf_m = TAF_HTML_RE.search(html)
        resultado = {
            "metar": metar_m.group(1).strip() or None if metar_m else None,
            "taf": taf_m.group(1).strip() or None if taf_m else None,
        }

    with _cache_lock:
        _metar_taf_cache[icao] = (now + METAR_TAF_CACHE_TTL, resultado)
    return resultado


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


def _redemet_get(path: str, params: dict):
    if not REDEMET_API_KEY:
        raise RuntimeError("REDEMET_API_KEY não configurada no servidor.")
    query = {"api_key": REDEMET_API_KEY, **params}
    resp = requests.get(f"{REDEMET_BASE_URL}{path}", params=query, timeout=10)
    resp.raise_for_status()
    # A REDEMET não declara charset no Content-Type; sem isso o requests
    # arrisca adivinhar Latin-1 e corromper acentos (ex.: "Não" -> "N�o").
    resp.encoding = "utf-8"
    payload = resp.json()
    if not payload.get("status"):
        raise ValueError(str(payload.get("message") or "Falha na API da REDEMET."))
    return payload.get("data") or {}


def _mensagens_ativas(mensagens: list) -> list:
    """Filtra mensagens (SIGMET/GAMET/aviso de aeródromo) cuja validade cobre o instante atual."""
    agora = datetime.now(timezone.utc)
    ativas = []
    for m in mensagens:
        try:
            inicio = datetime.strptime(m["validade_inicial"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            fim = datetime.strptime(m["validade_final"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError, TypeError):
            continue
        if inicio <= agora <= fim:
            ativas.append(m)
    return ativas


def fetch_avisos(icao: str, pais: str = "Brasil"):
    """Busca, na REDEMET, SIGMET/GAMET vigentes do país e aviso de aeródromo vigente do ICAO."""
    cache_key = (icao, pais)
    now = time.time()
    with _cache_lock:
        cached = _avisos_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

    aviso_aerodromo = _mensagens_ativas(_redemet_get(f"/mensagens/aviso/{icao}", {}).get("data", []))
    sigmet = _mensagens_ativas(_redemet_get("/mensagens/sigmet", {"pais": pais}).get("data", []))
    airmet = _mensagens_ativas(_redemet_get("/mensagens/airmet", {"pais": pais}).get("data", []))
    gamet = _mensagens_ativas(_redemet_get("/mensagens/gamet", {"pais": pais}).get("data", []))

    resultado = {"aviso_aerodromo": aviso_aerodromo, "sigmet": sigmet, "airmet": airmet, "gamet": gamet}
    with _cache_lock:
        _avisos_cache[cache_key] = (now + AVISOS_CACHE_TTL, resultado)
    return resultado


def fetch_radar(area: str = "ga", tipo: str = "maxcappi"):
    """Busca, na REDEMET, a imagem de radar meteorológico mais recente de uma estação."""
    cache_key = (area, tipo)
    now = time.time()
    with _cache_lock:
        cached = _radar_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

    dados = _redemet_get(f"/produtos/radar/{tipo}", {"area": area})
    estacoes = dados.get("radar") or []
    # A API retorna uma lista aninhada (lista de listas); achata antes de procurar a estação.
    lista = [item for grupo in estacoes for item in (grupo if isinstance(grupo, list) else [grupo])]
    estacao = next((e for e in lista if e.get("localidade") == area), lista[0] if lista else None)
    estacao = estacao or {}

    def _float(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    resultado = {
        "area": area,
        "nome": RADAR_STATIONS.get(area, area),
        "tipo": tipo,
        "path": estacao.get("path"),
        "data": estacao.get("data"),
        "raio": estacao.get("raio"),
        "lat_min": _float(estacao.get("lat_min")),
        "lat_max": _float(estacao.get("lat_max")),
        "lon_min": _float(estacao.get("lon_min")),
        "lon_max": _float(estacao.get("lon_max")),
    }
    with _cache_lock:
        _radar_cache[cache_key] = (now + RADAR_CACHE_TTL, resultado)
    return resultado


def fetch_tsc():
    """Busca, na REDEMET, as células de tempo severo convectivo (STSC) detectadas no Brasil."""
    now = time.time()
    with _cache_lock:
        cached = _tsc_cache.get("tsc")
        if cached and cached[0] > now:
            return cached[1]

    dados = _redemet_get("/produtos/stsc", {})
    grupos = dados.get("stsc") or []
    pontos = [
        {"lat": float(p["la"]), "lon": float(p["lo"])}
        for grupo in grupos
        for p in grupo
        if "la" in p and "lo" in p
    ]

    resultado = {
        "pontos": pontos,
        "atualizado_em": (dados.get("info") or {}).get("ultima_ocorrencia"),
    }
    with _cache_lock:
        _tsc_cache["tsc"] = (now + TSC_CACHE_TTL, resultado)
    return resultado


def fetch_status_aerodromos(pais: str = "BRASIL"):
    """Busca, na REDEMET, o status por categoria de voo dos aeródromos com METAR disponível."""
    now = time.time()
    with _cache_lock:
        cached = _status_aerodromos_cache.get(pais)
        if cached and cached[0] > now:
            return cached[1]

    linhas = _redemet_get("/aerodromos/status", {"pais": pais})
    pontos = []
    for linha in linhas or []:
        if len(linha) < 5:
            continue
        icao, nome, lat, lon, cor = linha[0], linha[1], linha[2], linha[3], linha[4]
        if cor == "cinza":
            continue  # sem METAR disponível para esta localidade
        try:
            lat_f, lon_f = float(lat), float(lon)
        except (TypeError, ValueError):
            continue
        pontos.append({
            "icao": icao,
            "nome": nome,
            "lat": lat_f,
            "lon": lon_f,
            "cor": STATUS_COR_HEX.get(cor, "#9ca3af"),
            "info": linha[5] if len(linha) > 5 else None,
        })

    resultado = {"pontos": pontos}
    with _cache_lock:
        _status_aerodromos_cache[pais] = (now + STATUS_AERODROMOS_CACHE_TTL, resultado)
    return resultado


@app.route("/")
def health():
    return jsonify({"status": "ok", "service": "consulta-de-proas-backend"})


def resolve_ponto(icao_raw: str, coord_raw: str = ""):
    """Resolve um ponto (origem ou destino) a partir de um IND LOC ou, para
    ZZZZ, de uma coordenada do Campo 18 do FPL. Retorna (ponto, erro, status);
    ponto é None quando erro não é None."""
    icao_raw = (icao_raw or "").strip().upper()
    coord_raw = (coord_raw or "").strip().upper().replace(" ", "")

    # Se vier só a coordenada no campo do indicativo (sem ZZZZ), trata como Campo 18 também
    if is_fpl_coord(icao_raw.replace(" ", "")):
        icao_raw, coord_raw = "ZZZZ", icao_raw.replace(" ", "")

    if icao_raw == "ZZZZ":
        parsed = parse_fpl_coord(coord_raw)
        if not parsed:
            return None, (
                "Coordenada inválida para ZZZZ. Use o formato do Campo 18 do FPL, "
                "com ou sem segundos (ex.: 1454S05104W ou 145430S0510422W)."
            ), 400
        lat, lon = parsed
        known = KNOWN_POINTS.get(coord_raw)
        ponto = {
            "icao": "ZZZZ",
            "name": known["name"] if known else "Localidade sem indicador (coordenadas do Campo 18)",
            "city": known["city"] if known else "",
            "state": known["state"] if known else "",
            "lat": lat,
            "lon": lon,
        }
        return ponto, None, None

    if not ICAO_RE.match(icao_raw):
        return None, "IND LOC inválido. Use de 3 a 6 letras/números (ex.: SBGR, SDL7) ou ZZZZ com coordenada.", 400

    try:
        ponto = fetch_aerodromo(icao_raw)
    except requests.RequestException:
        return None, "Falha ao consultar o AISWEB. Tente novamente.", 502

    if not ponto:
        return None, f"Aeródromo {icao_raw} não encontrado no AISWEB nem no backup local.", 404

    return ponto, None, None


@app.route("/api/buscar_proa")
def buscar_proa():
    icao = request.args.get("icao") or ""
    coord = request.args.get("coord") or ""

    destino, erro, status = resolve_ponto(icao, coord)
    if erro:
        return jsonify({"error": erro}), status

    # Origem: por padrão SBNV, mas o usuário pode consultar a partir de
    # qualquer aeródromo/coordenada (opção "fixar origem" no frontend).
    origem_icao_param = request.args.get("origem_icao") or ""
    if origem_icao_param.strip():
        origem, erro_origem, status_origem = resolve_ponto(origem_icao_param, request.args.get("origem_coord") or "")
        if erro_origem:
            return jsonify({"error": f"Origem: {erro_origem}"}), status_origem
    else:
        origem = ORIGEM

    distancia_nm, proa_verdadeira = great_circle(
        origem["lat"], origem["lon"], destino["lat"], destino["lon"]
    )
    declinacao = magnetic_declination(destino["lat"], destino["lon"])
    proa_magnetica = (proa_verdadeira - declinacao) % 360

    resultado = {
        "origem": origem,
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


@app.route("/api/metar_taf")
def metar_taf():
    icao = (request.args.get("icao") or "").strip().upper()
    if not ICAO_RE.match(icao):
        return jsonify({"error": "IND LOC inválido. Use de 3 a 6 letras/números (ex.: SBGR)."}), 400

    try:
        dados = fetch_metar_taf(icao)
    except requests.RequestException:
        return jsonify({"error": "Falha ao consultar o AISWEB. Tente novamente."}), 502

    return jsonify({"icao": icao, "metar": dados["metar"], "taf": dados["taf"]})


@app.route("/api/avisos")
def avisos():
    icao = (request.args.get("icao") or "").strip().upper()
    pais = (request.args.get("pais") or "Brasil").strip()
    if not ICAO_RE.match(icao):
        return jsonify({"error": "IND LOC inválido. Use de 3 a 6 letras/números (ex.: SBGR)."}), 400

    try:
        resultado = fetch_avisos(icao, pais)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except (requests.RequestException, ValueError) as e:
        return jsonify({"error": f"Falha ao consultar a REDEMET: {e}"}), 502

    return jsonify({"icao": icao, "pais": pais, **resultado})


@app.route("/api/radar")
def radar():
    area = (request.args.get("area") or "ga").strip().lower()
    tipo = (request.args.get("tipo") or "maxcappi").strip().lower()
    if area not in RADAR_STATIONS:
        return jsonify({"error": f"Estação de radar inválida. Opções: {', '.join(sorted(RADAR_STATIONS))}."}), 400
    if tipo not in RADAR_TIPOS:
        return jsonify({"error": f"Tipo de radar inválido. Opções: {', '.join(sorted(RADAR_TIPOS))}."}), 400

    try:
        resultado = fetch_radar(area, tipo)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except (requests.RequestException, ValueError) as e:
        return jsonify({"error": f"Falha ao consultar a REDEMET: {e}"}), 502

    return jsonify(resultado)


@app.route("/api/tsc")
def tsc():
    try:
        resultado = fetch_tsc()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except (requests.RequestException, ValueError) as e:
        return jsonify({"error": f"Falha ao consultar a REDEMET: {e}"}), 502

    return jsonify(resultado)


@app.route("/api/status_aerodromos")
def status_aerodromos():
    pais = (request.args.get("pais") or "BRASIL").strip()
    try:
        resultado = fetch_status_aerodromos(pais)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except (requests.RequestException, ValueError) as e:
        return jsonify({"error": f"Falha ao consultar a REDEMET: {e}"}), 502

    return jsonify(resultado)


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


# ====== Keep-alive: evita o cold start do plano gratuito do Render ======
# O Render "dorme" o serviço após ~15 min sem requisições HTTP. Como um
# agendamento externo (ex.: GitHub Actions) não é confiável o suficiente,
# o próprio processo se autopinga periodicamente pela URL pública (só conta
# como "acordado" se a requisição realmente sair e voltar pelo Render, por
# isso não adianta chamar a view Flask direto em memória). Só roda quando
# RENDER_EXTERNAL_URL existir (ou seja, em produção no Render), nunca local.
SELF_PING_INTERVAL_S = 10 * 60


def _self_ping_loop(url: str):
    while True:
        time.sleep(SELF_PING_INTERVAL_S)
        try:
            requests.get(url, timeout=15)
        except requests.RequestException:
            pass


_external_url = os.environ.get("RENDER_EXTERNAL_URL")
if _external_url:
    threading.Thread(target=_self_ping_loop, args=(_external_url,), daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False, threaded=True)
