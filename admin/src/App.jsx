import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Clock, Headset, LayoutDashboard, LogOut, Moon, Settings, Sparkles, Sun, Tags } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Inactivity from "./pages/Inactivity";
import Reports from "./pages/Reports";
import AiPage from "./pages/AI";
import AttendancePage from "./pages/Attendance";
import SettingsPage from "./pages/Settings";
import LoginGate from "./components/LoginGate";
import { SESSION_EXPIRED_EVENT, api } from "./services/api";
import { clearPageCache } from "./services/page-cache";
import { getEffectiveTheme, saveTheme } from "./services/theme";

const views = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "reports", label: "Relatorios", icon: BarChart3 },
  { id: "inactivity", label: "Inatividade", icon: Clock },
  { id: "ai", label: "IA", icon: Sparkles },
  { id: "attendance", label: "Atendimento IA", icon: Headset },
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
  const [theme, setTheme] = useState(getEffectiveTheme);

  function alternarTema() {
    const proximo = theme === "dark" ? "light" : "dark";
    saveTheme(proximo);
    setTheme(proximo);
  }

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
      clearPageCache();
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
    // Os numeros guardados sao da sessao que saiu.
    clearPageCache();
    setUser(null);
    setGateError("");
    setView("dashboard");
  }

  const currentView = useMemo(() => {
    if (view === "reports") return <Reports />;
    if (view === "inactivity") return <Inactivity />;
    if (view === "ai") return <AiPage />;
    if (view === "attendance") return <AttendancePage />;
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
                aria-current={view === item.id ? "page" : undefined}
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
          <div className="topbar-actions">
            <button
              className="icon-button"
              type="button"
              onClick={alternarTema}
              aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
              title={theme === "dark" ? "Tema claro" : "Tema escuro"}
            >
              {theme === "dark" ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
            </button>
            <div className="user-chip">
              <span className="avatar" aria-hidden="true">
                {initials(user.name || user.username)}
              </span>
              <div>
                <strong>{user.name}</strong>
                <small>{user.username}</small>
              </div>
            </div>
          </div>
        </header>
        {currentView}
      </main>
    </div>
  );
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}
