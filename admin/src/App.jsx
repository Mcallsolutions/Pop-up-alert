import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Clock, LayoutDashboard, LogOut, Settings, Sparkles, Tags } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Inactivity from "./pages/Inactivity";
import Reports from "./pages/Reports";
import AiPage from "./pages/AI";
import SettingsPage from "./pages/Settings";
import TokenGate from "./components/TokenGate";
import { api, setApiToken } from "./services/api";

const views = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "reports", label: "Relatorios", icon: BarChart3 },
  { id: "inactivity", label: "Inatividade", icon: Clock },
  // A aba IA manda o recorte inteiro para a OpenAI e o resumo fica salvo para
  // todos, entao ela e so de quem tem token de administrador.
  { id: "ai", label: "IA", icon: Sparkles, adminOnly: true },
  { id: "settings", label: "Configuracoes", icon: Settings }
];

// O painel usa o mesmo token da API: quem entra com token de atendente ve so os
// proprios tickets (mais os que estao sem atendente) em todas as telas.
export default function App() {
  const [view, setView] = useState("dashboard");
  const [identity, setIdentity] = useState(null);
  const [gateError, setGateError] = useState("");
  const [carregando, setCarregando] = useState(true);

  const identificar = useCallback(async () => {
    try {
      const me = await api.me();
      setIdentity(me);
      setGateError("");
      return me;
    } catch (error) {
      setIdentity(null);
      // 401 = falta token (ou o token nao vale mais). Qualquer outro erro e da
      // API em si e nao se resolve pedindo token de novo.
      setGateError(error.unauthorized ? "" : error.message);
      if (!error.unauthorized) {
        throw error;
      }
      return null;
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    identificar().catch(() => undefined);
  }, [identificar]);

  async function entrar(token) {
    setApiToken(token);
    const me = await identificar().catch(() => null);
    if (!me) {
      // Token recusado nao fica guardado: recarregar a pagina nao pode
      // ressuscitar um token que ja sabemos que nao vale.
      setApiToken("");
      setGateError("Token invalido ou revogado.");
    }
  }

  function sair() {
    setApiToken("");
    setIdentity(null);
    setView("dashboard");
  }

  const visiveis = useMemo(() => views.filter((item) => !item.adminOnly || identity?.isAdmin), [identity]);

  const currentView = useMemo(() => {
    if (view === "reports") return <Reports />;
    if (view === "inactivity") return <Inactivity />;
    if (view === "ai" && identity?.isAdmin) return <AiPage />;
    if (view === "settings") return <SettingsPage identity={identity} onTokenTrocado={identificar} />;
    return <Dashboard isAdmin={Boolean(identity?.isAdmin)} />;
  }, [view, identity, identificar]);

  if (carregando) {
    return <div className="token-gate" />;
  }

  if (!identity) {
    return <TokenGate error={gateError} onSubmit={entrar} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Tags aria-hidden="true" size={24} />
          <div>
            <strong>Mcall</strong>
            <span>Ticket Tag Monitor</span>
          </div>
        </div>

        <nav aria-label="Principal">
          {visiveis.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? "nav-button active" : "nav-button"}
                type="button"
                onClick={() => setView(item.id)}
              >
                <Icon aria-hidden="true" size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {identity.authRequired ? (
          <button className="nav-button" type="button" onClick={sair}>
            <LogOut aria-hidden="true" size={18} />
            Sair
          </button>
        ) : null}
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p>Operacao de atendimento</p>
            <h1>{views.find((item) => item.id === view)?.label}</h1>
          </div>
          <span>{describeIdentity(identity)}</span>
        </header>
        {currentView}
      </main>
    </div>
  );
}

function describeIdentity(identity) {
  if (!identity.authRequired) {
    return "Ambiente local - sem token";
  }

  return identity.isAdmin ? `${identity.name} - ve tudo` : `${identity.name} - ${identity.attendant}`;
}
