import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Clock, LayoutDashboard, LogOut, Settings, Sparkles, Tags } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Inactivity from "./pages/Inactivity";
import Reports from "./pages/Reports";
import AiPage from "./pages/AI";
import SettingsPage from "./pages/Settings";
import LoginGate from "./components/LoginGate";
import { SESSION_EXPIRED_EVENT, api } from "./services/api";

const views = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "reports", label: "Relatorios", icon: BarChart3 },
  { id: "inactivity", label: "Inatividade", icon: Clock },
  { id: "ai", label: "IA", icon: Sparkles },
  { id: "settings", label: "Configuracoes", icon: Settings }
];

// O painel e so de administracao: entra com usuario e senha e ve a operacao
// inteira. Os tokens por pessoa ficam para a extensao (pop-up) e sao emitidos
// em Configuracoes.
export default function App() {
  const [view, setView] = useState("dashboard");
  const [user, setUser] = useState(null);
  const [gateError, setGateError] = useState("");
  const [carregando, setCarregando] = useState(true);

  const carregarSessao = useCallback(async () => {
    try {
      setUser(await api.session());
      setGateError("");
    } catch (error) {
      setUser(null);
      // 401 = sem sessao ou sessao vencida: so mostra o login. Qualquer outro
      // erro e da API em si.
      setGateError(error.unauthorized ? "" : error.message);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregarSessao();
  }, [carregarSessao]);

  // Qualquer chamada que receba 401 no meio do uso derruba para o login.
  useEffect(() => {
    function aoExpirar() {
      setUser(null);
      setGateError("Sua sessao expirou. Entre novamente.");
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, aoExpirar);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, aoExpirar);
  }, []);

  async function entrar(username, password) {
    try {
      setUser(await api.login(username, password));
      setGateError("");
      setView("dashboard");
    } catch (error) {
      setGateError(error.message);
    }
  }

  async function sair() {
    await api.logout().catch(() => undefined);
    setUser(null);
    setGateError("");
    setView("dashboard");
  }

  const currentView = useMemo(() => {
    if (view === "reports") return <Reports />;
    if (view === "inactivity") return <Inactivity />;
    if (view === "ai") return <AiPage />;
    if (view === "settings") return <SettingsPage />;
    return <Dashboard />;
  }, [view]);

  if (carregando) {
    return <div className="token-gate" />;
  }

  if (!user) {
    return <LoginGate error={gateError} onSubmit={entrar} />;
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
          {views.map((item) => {
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

        <button className="nav-button" type="button" onClick={sair}>
          <LogOut aria-hidden="true" size={18} />
          Sair
        </button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p>Operacao de atendimento</p>
            <h1>{views.find((item) => item.id === view)?.label}</h1>
          </div>
          <span>
            {user.name} ({user.username})
          </span>
        </header>
        {currentView}
      </main>
    </div>
  );
}
