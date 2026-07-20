import sqlite3
import re
from datetime import datetime
from flask import Flask, request, redirect, url_for, render_template_string, jsonify

DB_FILE = "proas.db"
app = Flask(__name__)

# ====== DADOS INICIAIS (da sua tabela) ======
SEED_DATA = {
    "SD8D": "H142","SD24": "H308","SD4S": "H346","SDHH": "H080","SD7P": "H033","SDS9": "H040","SDY2": "H217","SSH2": "H000","SDCH": "H132",
    "SJ39": "H333","SJ4Y": "H191","SJD3": "H078","SJ46": "H328","SJ8N": "H324","SJ9H": "H028","SJE8": "H346","SJF6": "H029","SJG9": "H159","SJG6": "H339",
    "SJ7": "H040","SJPG": "H153","SI9P": "H065","SJJ7": "H040","SJ6L": "H352","SJ68": "H351","SJG3": "H324","SDE1": "H003","SJ94": "H154",
    "SN2H": "H346","SN3H": "H281","SNGB": "H003","SN3Y": "H083","SN4X": "H074","SNGO": "H310","SNJU": "H351","SNUN": "H105","SN7F": "H344","SNFO": "H158",
    "SN7A": "H330","SNAB": "H022","SN7E": "H287","SN8V": "H000","SNT3": "H096","SNFB": "H009","SNF8": "H009","SN9Z": "H007",
    "SSPP": "H272","SSMN": "H149","SS4T": "H003","SDZA": "H083","SS6A": "H062","SSYT": "H150","SSBJ": "H058","SS8J": "H003","SS9B": "H003","SS8Y": "H325",
    "SS3C": "H011","SSOM": "H145","SSIX": "H217",
    "SI8C": "H078","SI2U": "H089","SI33": "H353","SI87": "H351","SIIC": "H080","SIJ6": "H354","SI6Q": "H244","SIUQ": "H360","SIYK": "H149",
    "SIGS": "H008","SIIG": "H341","SIW3": "H047","SIKV": "H105","SI68": "H310","SI2I": "H209","SI3U": "H333","SIX6": "H175","SI4U": "H118",
}

# ====== helpers ======
def normalize_loc(loc: str) -> str:
    loc = (loc or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{3,6}", loc):
        raise ValueError("IND LOC inválido. Use 3 a 6 caracteres A-Z/0-9 (ex.: SD8D, SJ39, SI4U).")
    return loc

def normalize_heading(h: str) -> str:
    h = (h or "").strip().upper().replace(" ", "")
    if not h.startswith("H"):
        raise ValueError("Proa inválida. Deve começar com 'H' (ex.: H142).")
    digits = h[1:]
    if not digits.isdigit():
        raise ValueError("Proa inválida. Após 'H' deve ter apenas números (ex.: H080).")
    value = int(digits)
    if value < 0 or value > 360:
        raise ValueError("Proa fora do intervalo (0 a 360).")
    return f"H{value:03d}"

def connect():
    con = sqlite3.connect(DB_FILE)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    with connect() as con:
        cur = con.cursor()
        cur.execute("""
        CREATE TABLE IF NOT EXISTS localities(
            loc TEXT PRIMARY KEY,
            heading TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")
        cur.execute("""
        CREATE TABLE IF NOT EXISTS history(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            loc TEXT NOT NULL,
            old_heading TEXT,
            new_heading TEXT,
            action TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )""")
        cur.execute("SELECT COUNT(*) AS c FROM localities")
        if cur.fetchone()["c"] == 0:
            now = datetime.utcnow().isoformat(timespec="seconds")
            for loc, heading in SEED_DATA.items():
                loc_n = normalize_loc(loc)
                head_n = normalize_heading(heading)
                cur.execute("INSERT INTO localities(loc, heading, updated_at) VALUES(?,?,?)", (loc_n, head_n, now))
                cur.execute("INSERT INTO history(loc, old_heading, new_heading, action, timestamp) VALUES(?,?,?,?,?)",
                            (loc_n, None, head_n, "seed", now))
        con.commit()

def upsert(loc: str, heading: str):
    loc = normalize_loc(loc)
    heading = normalize_heading(heading)
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connect() as con:
        cur = con.cursor()
        cur.execute("SELECT heading FROM localities WHERE loc=?", (loc,))
        row = cur.fetchone()
        if row:
            old = row["heading"]
            cur.execute("UPDATE localities SET heading=?, updated_at=? WHERE loc=?", (heading, now, loc))
            cur.execute("INSERT INTO history(loc, old_heading, new_heading, action, timestamp) VALUES(?,?,?,?,?)",
                        (loc, old, heading, "update", now))
            con.commit()
            return "updated", old, heading
        else:
            cur.execute("INSERT INTO localities(loc, heading, updated_at) VALUES(?,?,?)", (loc, heading, now))
            cur.execute("INSERT INTO history(loc, old_heading, new_heading, action, timestamp) VALUES(?,?,?,?,?)",
                        (loc, None, heading, "insert", now))
            con.commit()
            return "inserted", None, heading

def delete_loc(loc: str):
    loc = normalize_loc(loc)
    now = datetime.utcnow().isoformat(timespec="seconds")
    with connect() as con:
        cur = con.cursor()
        cur.execute("SELECT heading FROM localities WHERE loc=?", (loc,))
        row = cur.fetchone()
        if not row:
            return False
        old = row["heading"]
        cur.execute("DELETE FROM localities WHERE loc=?", (loc,))
        cur.execute("INSERT INTO history(loc, old_heading, new_heading, action, timestamp) VALUES(?,?,?,?,?)",
                    (loc, old, None, "delete", now))
        con.commit()
        return True

# ====== UI templates (inline) ======
BASE = """
<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Consulta de Proa</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;margin:24px;background:#0b0f14;color:#e6edf3}
    a{color:#7dd3fc;text-decoration:none}
    .card{background:#111827;border:1px solid #243244;border-radius:12px;padding:16px;margin:12px 0}
    input,button{padding:10px;border-radius:10px;border:1px solid #2b3a4d;background:#0b1220;color:#e6edf3}
    button{cursor:pointer}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #243244;padding:10px;text-align:left}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .msg{padding:10px;border-radius:10px;background:#0b1220;border:1px solid #243244;margin-top:10px}
    .danger{color:#fecaca}
  </style>
</head>
<body>
  <h2>Consulta de Proa Ideal (IND LOC → H###)</h2>
  <div class="row">
    <a href="{{ url_for('home') }}">Início</a>
    <a href="{{ url_for('history_page') }}">Histórico</a>
    <a href="{{ url_for('api_help') }}">API</a>
  </div>
  {% if msg %}<div class="msg">{{ msg }}</div>{% endif %}
  {% if err %}<div class="msg danger">⚠ {{ err }}</div>{% endif %}
  {{ body|safe }}
</body>
</html>
"""

HOME_BODY = """
<div class="card">
  <h3>Consultar</h3>
  <form method="get" action="{{ url_for('home') }}">
    <input name="q" placeholder="Digite o IND LOC (ex.: SD8D)" value="{{ q or '' }}">
    <button type="submit">Buscar</button>
  </form>
  {% if result %}
    <p><b>{{ result['loc'] }}</b> → <b>{{ result['heading'] }}</b> (atualizado em {{ result['updated_at'] }} UTC)</p>
  {% elif q %}
    <p>Não encontrado: <b>{{ q }}</b></p>
  {% endif %}
</div>

<div class="card">
  <h3>Cadastrar / Atualizar</h3>
  <form method="post" action="{{ url_for('save') }}">
    <input name="loc" placeholder="IND LOC (ex.: SD8D)" required>
    <input name="heading" placeholder="Proa (ex.: H142)" required>
    <button type="submit">Salvar</button>
  </form>
</div>

<div class="card">
  <h3>Lista</h3>
  <table>
    <thead><tr><th>IND LOC</th><th>PROA</th><th>Atualizado (UTC)</th><th>Ações</th></tr></thead>
    <tbody>
    {% for r in rows %}
      <tr>
        <td>{{ r['loc'] }}</td>
        <td><b>{{ r['heading'] }}</b></td>
        <td>{{ r['updated_at'] }}</td>
        <td>
          <a href="{{ url_for('edit_page', loc=r['loc']) }}">Editar</a> |
          <a href="{{ url_for('delete_page', loc=r['loc']) }}" onclick="return confirm('Remover {{ r['loc'] }}?')">Remover</a>
        </td>
      </tr>
    {% endfor %}
    </tbody>
  </table>
</div>
"""

EDIT_BODY = """
<div class="card">
  <h3>Editar {{ loc }}</h3>
  <p>Atual: <b>{{ current }}</b></p>
  <form method="post" action="{{ url_for('save') }}">
    <input name="loc" value="{{ loc }}" readonly>
    <input name="heading" placeholder="Nova proa (ex.: H080)" required>
    <button type="submit">Salvar</button>
  </form>
</div>
"""

HISTORY_BODY = """
<div class="card">
  <h3>Histórico</h3>
  <form method="get" action="{{ url_for('history_page') }}">
    <input name="loc" placeholder="Filtrar por IND LOC (opcional)" value="{{ loc or '' }}">
    <input name="limit" placeholder="Limite (padrão 100)" value="{{ limit }}">
    <button type="submit">Ver</button>
  </form>
</div>

<div class="card">
  <table>
    <thead><tr><th>Timestamp (UTC)</th><th>LOC</th><th>Ação</th><th>De</th><th>Para</th></tr></thead>
    <tbody>
    {% for h in rows %}
      <tr>
        <td>{{ h['timestamp'] }}</td>
        <td>{{ h['loc'] }}</td>
        <td>{{ h['action'] }}</td>
        <td>{{ h['old_heading'] }}</td>
        <td>{{ h['new_heading'] }}</td>
      </tr>
    {% endfor %}
    </tbody>
  </table>
</div>
"""

# ====== routes ======
@app.route("/", methods=["GET"])
def home():
    q = request.args.get("q", "").strip()
    msg = request.args.get("msg", "")
    err = request.args.get("err", "")

    with connect() as con:
        cur = con.cursor()
        cur.execute("SELECT loc, heading, updated_at FROM localities ORDER BY loc")
        rows = cur.fetchall()

        result = None
        if q:
            try:
                loc = normalize_loc(q)
                cur.execute("SELECT loc, heading, updated_at FROM localities WHERE loc=?", (loc,))
                r = cur.fetchone()
                if r:
                    result = r
            except ValueError as e:
                err = str(e)

    body = render_template_string(HOME_BODY, rows=rows, q=q, result=result)
    return render_template_string(BASE, body=body, msg=msg, err=err)

@app.route("/save", methods=["POST"])
def save():
    loc = request.form.get("loc", "")
    heading = request.form.get("heading", "")
    try:
        status, old, new = upsert(loc, heading)
        if status == "inserted":
            return redirect(url_for("home", msg=f"Cadastrado: {normalize_loc(loc)} → {new}"))
        return redirect(url_for("home", msg=f"Atualizado: {normalize_loc(loc)} {old} → {new}"))
    except ValueError as e:
        return redirect(url_for("home", err=str(e)))

@app.route("/edit/<loc>", methods=["GET"])
def edit_page(loc):
    try:
        loc = normalize_loc(loc)
    except ValueError as e:
        return redirect(url_for("home", err=str(e)))

    with connect() as con:
        cur = con.cursor()
        cur.execute("SELECT heading FROM localities WHERE loc=?", (loc,))
        r = cur.fetchone()
        if not r:
            return redirect(url_for("home", err=f"Não encontrado: {loc}"))

    body = render_template_string(EDIT_BODY, loc=loc, current=r["heading"])
    return render_template_string(BASE, body=body, msg="", err="")

@app.route("/delete/<loc>", methods=["GET"])
def delete_page(loc):
    try:
        ok = delete_loc(loc)
        if ok:
            return redirect(url_for("home", msg=f"Removido: {normalize_loc(loc)}"))
        return redirect(url_for("home", err="Não encontrado."))
    except ValueError as e:
        return redirect(url_for("home", err=str(e)))

@app.route("/history", methods=["GET"])
def history_page():
    loc = request.args.get("loc", "").strip()
    limit = request.args.get("limit", "").strip()
    try:
        limit_i = int(limit) if limit else 100
        if limit_i < 1 or limit_i > 5000:
            raise ValueError("Limite deve estar entre 1 e 5000.")
    except Exception:
        limit_i = 100

    with connect() as con:
        cur = con.cursor()
        if loc:
            try:
                loc_n = normalize_loc(loc)
            except ValueError as e:
                body = render_template_string(HISTORY_BODY, rows=[], loc=loc, limit=limit_i)
                return render_template_string(BASE, body=body, msg="", err=str(e))
            cur.execute("""
                SELECT loc, old_heading, new_heading, action, timestamp
                FROM history WHERE loc=?
                ORDER BY id DESC LIMIT ?
            """, (loc_n, limit_i))
        else:
            cur.execute("""
                SELECT loc, old_heading, new_heading, action, timestamp
                FROM history
                ORDER BY id DESC LIMIT ?
            """, (limit_i,))
        rows = cur.fetchall()

    body = render_template_string(HISTORY_BODY, rows=rows, loc=loc, limit=limit_i)
    return render_template_string(BASE, body=body, msg="", err="")

# ====== API simples ======
@app.route("/api", methods=["GET"])
def api_help():
    body = """
    <div class="card">
      <h3>API</h3>
      <p>Consultar: <code>/api/loc/SD8D</code></p>
      <p>Listar: <code>/api/list</code></p>
    </div>
    """
    return render_template_string(BASE, body=body, msg="", err="")

@app.route("/api/loc/<loc>", methods=["GET"])
def api_loc(loc):
    try:
        loc = normalize_loc(loc)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    with connect() as con:
        cur = con.cursor()
        cur.execute("SELECT loc, heading, updated_at FROM localities WHERE loc=?", (loc,))
        r = cur.fetchone()
        if not r:
            return jsonify({"error": "not found"}), 404
        return jsonify({"loc": r["loc"], "heading": r["heading"], "updated_at": r["updated_at"]})

@app.route("/api/list", methods=["GET"])
def api_list():
    with connect() as con:
        cur = con.cursor()
        cur.execute("SELECT loc, heading, updated_at FROM localities ORDER BY loc")
        rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows)

init_db()

if __name__ == "__main__":
    # host=0.0.0.0 => acessível pelo IP na rede (uso local)
    app.run(host="0.0.0.0", port=5000, debug=False)
