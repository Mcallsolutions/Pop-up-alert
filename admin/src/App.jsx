import React, { useEffect, useMemo, useState } from "react";
import { BarChart3, Clock, LayoutDashboard, LogOut, Settings, Sparkles, Tags } from "lucide-react";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Inactivity from "./pages/Inactivity";
import Reports from "./pages/Reports";
import AiPage from "./pages/AI";
import SettingsPage from "./pages/Settings";
import { api, getStoredToken, removeStoredToken, setStoredToken } from "./services/api";

const views = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "reports", label: "Relatorios", icon: BarChart3 },
  { id: "inactivity", label: "Inatividade", icon: Clock },
  { id: "ai", label: "IA", icon: Sparkles },
  { id: "settings", label: "Configuracoes", icon: Settings }
];

export default function App() {
  const [token, setToken] = useState(getStoredToken());
  const [user, setUser] = useState(null);
  const [view, setView] = useState("dashboard");

  useEffect(() => {
    if (!token) return;
    api
      .me()
      .then((data) => setUser(data.user))
      .catch(() => {
        removeStoredToken();
        setToken("");
      });
  }, [token]);

  const currentView = useMemo(() => {
    if (view === "reports") return <Reports />;
    if (view === "inactivity") return <Inactivity />;
    if (view === "ai") return <AiPage />;
    if (view === "settings") return <SettingsPage />;
    return <Dashboard />;
  }, [view]);

  function handleLogin({ token: nextToken, user: nextUser }) {
    setStoredToken(nextToken);
    setToken(nextToken);
    setUser(nextUser);
  }

  function logout() {
    removeStoredToken();
    setToken("");
    setUser(null);
  }

  if (!token) {
    return <Login onLogin={handleLogin} />;
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

        <button className="nav-button logout" type="button" onClick={logout}>
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
          <span>{user?.name || user?.email || "Administrador"}</span>
        </header>
        {currentView}
      </main>
    </div>
  );
}
