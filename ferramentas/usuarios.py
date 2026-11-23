"""Cria um usuário do Consulta de Proa ou troca a senha dele.

Uso: python ferramentas/usuarios.py NOME [--conta EMAIL_DO_FIREBASE_CLI]
A senha é digitada sem aparecer na tela e nunca é gravada em texto puro.
"""
import argparse
import base64
import getpass
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

PROJETO = "consulta-de-proas-sbnv"
DOMINIO = "usuarios.consulta-de-proas-sbnv.firebaseapp.com"
ROUNDS = 120000


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("usuario")
    parser.add_argument("--conta", help="conta do Firebase CLI com acesso ao projeto")
    args = parser.parse_args()

    usuario = args.usuario.strip().lower()
    if not re.fullmatch(r"[a-z0-9._-]{3,30}", usuario):
        raise SystemExit("Usuário inválido: use de 3 a 30 letras, números, ponto, hífen ou sublinhado.")

    senha = os.environ.get("PROA_NOVA_SENHA") or getpass.getpass("Nova senha: ")
    if "PROA_NOVA_SENHA" not in os.environ and senha != getpass.getpass("Repita a senha: "):
        raise SystemExit("As senhas não conferem.")
    if len(senha) < 10:
        raise SystemExit("A senha precisa ter pelo menos 10 caracteres.")

    email = f"{usuario}@{DOMINIO}"
    sal = os.urandom(16)
    hash_senha = hashlib.pbkdf2_hmac("sha256", senha.encode(), sal, ROUNDS, dklen=32)
    registro = {
        "users": [{
            "localId": "proa-" + hashlib.sha256(email.encode()).hexdigest()[:24],
            "email": email,
            "emailVerified": True,
            "passwordHash": base64.b64encode(hash_senha).decode(),
            "salt": base64.b64encode(sal).decode(),
            "customAttributes": json.dumps({"aprovado": True}),
        }]
    }

    fd, caminho = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(registro, f)
        cmd = [shutil.which("firebase") or shutil.which("firebase.cmd"), "auth:import", caminho,
               "--hash-algo=PBKDF2_SHA256", f"--rounds={ROUNDS}", "--project", PROJETO]
        if args.conta:
            cmd += ["--account", args.conta]
        subprocess.run(cmd, check=True)
    finally:
        os.remove(caminho)
    print(f"Usuário '{usuario}' pronto.")


if __name__ == "__main__":
    main()
