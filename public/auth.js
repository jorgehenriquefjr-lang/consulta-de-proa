/* =========================================================
   Login: Firebase Authentication com usuário e senha.
   O app.js só é carregado depois do login, e toda chamada ao
   backend passa a levar o token do usuário.
   ========================================================= */
(function () {
  const BACKEND = "https://consulta-proas-backend.onrender.com";
  const DOMINIO_USUARIO = "usuarios.consulta-de-proas-sbnv.firebaseapp.com";
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBNASDsIWBFmsggOIsabwP957Ik0EOcMt0",
    authDomain: "consulta-de-proas-sbnv.firebaseapp.com",
    projectId: "consulta-de-proas-sbnv",
    appId: "1:195658575436:web:576fd833bc32011ab80ee9",
  };

  const el = (id) => document.getElementById(id);
  const fetchOriginal = window.fetch.bind(window);
  firebase.initializeApp(FIREBASE_CONFIG);
  const auth = firebase.auth();
  let appCarregado = false;

  const paraEmail = (u) => {
    const v = u.trim().toLowerCase();
    return v.includes("@") ? v : `${v}@${DOMINIO_USUARIO}`;
  };
  const paraUsuario = (email) => (email || "").replace(`@${DOMINIO_USUARIO}`, "");

  function mostrarLogin(msg = "") {
    document.body.classList.add("auth-pendente", "auth-login");
    el("login-erro").textContent = msg;
    el("login-entrar").disabled = false;
    el("login-entrar").textContent = "Entrar";
    el("login-usuario").focus();
  }

  window.fetch = async function (recurso, opcoes = {}) {
    const url = typeof recurso === "string" ? recurso : recurso.url;
    if (!url.startsWith(`${BACKEND}/api/`) || !auth.currentUser) return fetchOriginal(recurso, opcoes);

    const enviar = async (forcar) => {
      const token = await auth.currentUser.getIdToken(forcar);
      const headers = new Headers(opcoes.headers || (typeof recurso === "string" ? undefined : recurso.headers));
      headers.set("Authorization", `Bearer ${token}`);
      return fetchOriginal(recurso, { ...opcoes, headers });
    };

    let resp = await enviar(false);
    if (resp.status === 401) {
      resp = await enviar(true);
      if (resp.status === 401) {
        await auth.signOut();
        location.reload();
      }
    }
    return resp;
  };

  function iniciarApp(usuario) {
    document.body.classList.remove("auth-pendente", "auth-login");
    el("auth-usuario").textContent = paraUsuario(usuario.email);
    if (appCarregado) return;
    appCarregado = true;
    const s = document.createElement("script");
    s.src = "app.js";
    document.body.appendChild(s);
  }

  el("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    el("login-erro").textContent = "";
    el("login-entrar").disabled = true;
    el("login-entrar").textContent = "Entrando…";
    try {
      const cred = await auth.signInWithEmailAndPassword(paraEmail(el("login-usuario").value), el("login-senha").value);
      const token = await cred.user.getIdTokenResult();
      if (token.claims.aprovado !== true) {
        await auth.signOut();
        mostrarLogin("Este usuário não tem acesso autorizado.");
      }
      el("login-senha").value = "";
    } catch (e) {
      const rede = e && e.code === "auth/network-request-failed";
      const limite = e && e.code === "auth/too-many-requests";
      mostrarLogin(rede ? "Sem conexão. Tente novamente." : limite ? "Muitas tentativas. Aguarde alguns minutos." : "Usuário ou senha incorretos.");
    }
  });

  el("auth-sair").addEventListener("click", async () => {
    await auth.signOut();
    location.reload();
  });

  auth.onAuthStateChanged(async (usuario) => {
    if (!usuario) return mostrarLogin();
    try {
      const token = await usuario.getIdTokenResult();
      if (token.claims.aprovado === true) return iniciarApp(usuario);
      await auth.signOut();
      mostrarLogin("Este usuário não tem acesso autorizado.");
    } catch {
      mostrarLogin("Não foi possível validar a sessão. Entre novamente.");
    }
  });
})();
