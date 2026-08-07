function renderApiInterface() {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mcall Ticket Tag API</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, Arial, sans-serif;
        background: #eef3f7;
        color: #172033;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
      }
      header {
        background: #172033;
        color: #fff;
        padding: 26px 32px;
      }
      header p,
      header h1 {
        margin: 0;
      }
      header p {
        color: #c6d2df;
        margin-top: 6px;
      }
      main {
        width: min(1180px, calc(100% - 32px));
        margin: 22px auto 44px;
        display: grid;
        gap: 18px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }
      section,
      .output {
        background: #fff;
        border: 1px solid #d9e2ec;
        border-radius: 8px;
      }
      section {
        padding: 18px;
      }
      h2,
      h3 {
        margin: 0 0 12px;
      }
      h2 {
        font-size: 18px;
      }
      h3 {
        font-size: 15px;
      }
      p {
        color: #526579;
        line-height: 1.45;
      }
      label {
        display: grid;
        gap: 6px;
        margin-bottom: 10px;
        color: #405267;
        font-size: 13px;
        font-weight: 700;
      }
      input {
        min-height: 40px;
        border: 1px solid #cbd7e3;
        border-radius: 7px;
        padding: 9px 11px;
        font: inherit;
      }
      button,
      a.button {
        min-height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 0;
        border-radius: 7px;
        background: #155eef;
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 800;
        padding: 0 14px;
        text-decoration: none;
      }
      button.secondary,
      a.button.secondary {
        background: #e4ebf2;
        color: #172033;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 9px;
      }
      .status {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 5px 10px;
        background: #e4ebf2;
        color: #172033;
        font-size: 12px;
        font-weight: 800;
      }
      .status.ok {
        background: #ddf7e6;
        color: #08683d;
      }
      .status.error {
        background: #ffe4e2;
        color: #b42318;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 12px 10px;
        border-bottom: 1px solid #edf2f6;
        text-align: left;
        font-size: 13px;
        vertical-align: top;
      }
      th {
        color: #526579;
        font-size: 12px;
        text-transform: uppercase;
      }
      code {
        background: #edf2f6;
        border-radius: 5px;
        padding: 2px 5px;
      }
      .output {
        overflow: hidden;
      }
      .output-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 18px;
        border-bottom: 1px solid #edf2f6;
      }
      pre {
        min-height: 190px;
        max-height: 420px;
        margin: 0;
        overflow: auto;
        padding: 18px;
        background: #0f172a;
        color: #dbeafe;
        font-size: 13px;
        line-height: 1.55;
      }
      @media (max-width: 860px) {
        .grid {
          grid-template-columns: 1fr;
        }
        header {
          padding: 22px 18px;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Mcall Ticket Tag API</h1>
      <p>Interface local para testar endpoints, login, snapshots e relatorios.</p>
    </header>

    <main>
      <section>
        <h2>Status da API <span id="healthBadge" class="status">Aguardando</span></h2>
        <p>Use esta tela para verificar se a API esta ativa e se os endpoints estao respondendo.</p>
        <div class="actions">
          <button type="button" data-action="health">Testar /health</button>
          <a class="button secondary" href="/health" target="_blank" rel="noreferrer">Abrir JSON de saude</a>
          <a class="button secondary" href="http://localhost:5173" target="_blank" rel="noreferrer">Abrir painel admin</a>
        </div>
      </section>

      <div class="grid">
        <section>
          <h2>Login administrativo</h2>
          <label>
            Email
            <input id="email" autocomplete="off" />
          </label>
          <label>
            Senha
            <input id="password" type="password" autocomplete="new-password" />
          </label>
          <div class="actions">
            <button type="button" data-action="login">Entrar nesta sessao</button>
            <button type="button" class="secondary" data-action="me">Testar /api/auth/me</button>
          </div>
        </section>

        <section>
          <h2>Snapshot da extensao</h2>
          <p>Envia um snapshot de exemplo com um ticket sem TAG e um ticket com TAG.</p>
          <div class="actions">
            <button type="button" data-action="snapshot">Enviar snapshot teste</button>
          </div>
        </section>
      </div>

      <section>
        <h2>Relatorios</h2>
        <p>Estes endpoints exigem token JWT. Faca login antes de consultar.</p>
        <div class="actions">
          <button type="button" data-action="summary">Resumo geral</button>
          <button type="button" data-action="missing">Tickets sem TAG</button>
          <button type="button" data-action="attendant">Por atendente</button>
          <button type="button" data-action="queue">Por fila</button>
        </div>
      </section>

      <section>
        <h2>Mapa de endpoints</h2>
        <table>
          <thead>
            <tr>
              <th>Metodo</th>
              <th>Rota</th>
              <th>Uso</th>
              <th>Auth</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>GET</td><td><code>/health</code></td><td>Status da API</td><td>Nao</td></tr>
            <tr><td>POST</td><td><code>/api/auth/login</code></td><td>Autentica administrador</td><td>Nao</td></tr>
            <tr><td>GET</td><td><code>/api/auth/me</code></td><td>Dados do usuario logado</td><td>JWT</td></tr>
            <tr><td>POST</td><td><code>/api/tickets/snapshot</code></td><td>Recebe leitura enviada pela extensao</td><td>Token opcional da extensao</td></tr>
            <tr><td>GET</td><td><code>/api/reports/summary</code></td><td>Resumo geral dos snapshots</td><td>JWT</td></tr>
            <tr><td>GET</td><td><code>/api/reports/missing-tags</code></td><td>Lista tickets sem TAG</td><td>JWT</td></tr>
            <tr><td>GET</td><td><code>/api/reports/by-attendant</code></td><td>Relatorio por atendente</td><td>JWT</td></tr>
            <tr><td>GET</td><td><code>/api/reports/by-queue</code></td><td>Relatorio por fila</td><td>JWT</td></tr>
          </tbody>
        </table>
      </section>

      <div class="output">
        <div class="output-header">
          <h3>Resposta</h3>
          <button type="button" class="secondary" data-action="clear">Limpar</button>
        </div>
        <pre id="output">Clique em um botao para testar a API.</pre>
      </div>
    </main>

    <script>
      const output = document.getElementById("output");
      const healthBadge = document.getElementById("healthBadge");
      const tokenKey = "mcall_api_interface_token";

      document.addEventListener("click", async (event) => {
        const action = event.target?.dataset?.action;
        if (!action) return;

        try {
          if (action === "health") return show(await request("/health", { auth: false }), "GET /health");
          if (action === "login") return login();
          if (action === "me") return show(await request("/api/auth/me"), "GET /api/auth/me");
          if (action === "snapshot") return show(await request("/api/tickets/snapshot", { method: "POST", auth: false, body: sampleSnapshot() }), "POST /api/tickets/snapshot");
          if (action === "summary") return show(await request("/api/reports/summary"), "GET /api/reports/summary");
          if (action === "missing") return show(await request("/api/reports/missing-tags"), "GET /api/reports/missing-tags");
          if (action === "attendant") return show(await request("/api/reports/by-attendant"), "GET /api/reports/by-attendant");
          if (action === "queue") return show(await request("/api/reports/by-queue"), "GET /api/reports/by-queue");
          if (action === "clear") output.textContent = "Clique em um botao para testar a API.";
        } catch (error) {
          show({ error: error.message }, "Erro");
        }
      });

      async function login() {
        const email = document.getElementById("email").value;
        const password = document.getElementById("password").value;
        const data = await request("/api/auth/login", {
          method: "POST",
          auth: false,
          body: { email, password }
        });
        localStorage.removeItem(tokenKey);
        sessionStorage.setItem(tokenKey, data.token);
        show(data, "POST /api/auth/login");
      }

      async function request(path, options = {}) {
        const headers = { "content-type": "application/json" };
        if (options.auth !== false) {
          localStorage.removeItem(tokenKey);
          const token = sessionStorage.getItem(tokenKey);
          if (token) headers.authorization = "Bearer " + token;
        }

        const response = await fetch(path, {
          method: options.method || "GET",
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;

        if (path === "/health") {
          healthBadge.textContent = response.ok ? "Online" : "Erro";
          healthBadge.className = response.ok ? "status ok" : "status error";
        }

        if (!response.ok) {
          throw new Error(data?.error || "Erro " + response.status);
        }

        return data;
      }

      function sampleSnapshot() {
        return {
          source: "mtalk",
          url: "https://s11.mtalk.com.br/tickets/interface-local",
          collectedAt: new Date().toISOString(),
          tickets: [
            {
              clientName: "CLIENTE SEM TAG",
              queue: "Suporte-AIA",
              attendant: "Luis",
              company: "NETFIBRA-AIA",
              displayTime: "20:55",
              tag: null,
              tagStatus: "SEM_TAG"
            },
            {
              clientName: "CLIENTE COM TAG",
              queue: "Suporte-BDG",
              attendant: "Gabriel Oliveira",
              company: "NETFIBRA BDG",
              displayTime: "17:19",
              tag: "BDG - CIDADE VELHA",
              tagStatus: "COM_TAG"
            }
          ]
        };
      }

      function show(data, title) {
        output.textContent = title + "\\n\\n" + JSON.stringify(data, null, 2);
      }

      request("/health", { auth: false }).then((data) => show(data, "GET /health")).catch((error) => show({ error: error.message }, "Erro"));
    </script>
  </body>
</html>`;
}

function getApiCatalog() {
  return {
    service: "mcall-ticket-tag-api",
    interface: "/api/console",
    endpoints: [
      { method: "GET", path: "/health", auth: false, description: "Status da API" },
      { method: "POST", path: "/api/auth/login", auth: false, description: "Autentica administrador" },
      { method: "GET", path: "/api/auth/me", auth: "JWT", description: "Dados do usuario logado" },
      { method: "POST", path: "/api/tickets/snapshot", auth: "EXTENSION_TOKEN opcional", description: "Recebe leitura da extensao" },
      { method: "GET", path: "/api/reports/summary", auth: "JWT", description: "Resumo geral" },
      { method: "GET", path: "/api/reports/missing-tags", auth: "JWT", description: "Tickets sem TAG" },
      { method: "GET", path: "/api/reports/by-attendant", auth: "JWT", description: "Relatorio por atendente" },
      { method: "GET", path: "/api/reports/by-queue", auth: "JWT", description: "Relatorio por fila" }
    ]
  };
}

module.exports = {
  renderApiInterface,
  getApiCatalog
};
