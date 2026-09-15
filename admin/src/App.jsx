import { useMemo, useState } from "react";
import { BarChart3, Clock, LayoutDashboard, Settings, Sparkles, Tags } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Inactivity from "./pages/Inactivity";
import Reports from "./pages/Reports";
import AiPage from "./pages/AI";
import SettingsPage from "./pages/Settings";

const views = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "reports", label: "Relatorios", icon: BarChart3 },
  { id: "inactivity", label: "Inatividade", icon: Clock },
  { id: "ai", label: "IA", icon: Sparkles },
  { id: "settings", label: "Configuracoes", icon: Settings }
];

// O painel roda localmente e, por enquanto, sem login.
export default function App() {
  const [view, setView] = useState("dashboard");

  const currentView = useMemo(() => {
    if (view === "reports") return <Reports />;
    if (view === "inactivity") return <Inactivity />;
    if (view === "ai") return <AiPage />;
    if (view === "settings") return <SettingsPage />;
    return <Dashboard />;
  }, [view]);

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
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p>Operacao de atendimento</p>
            <h1>{views.find((item) => item.id === view)?.label}</h1>
          </div>
          <span>Ambiente local</span>
        </header>
        {currentView}
      </main>
    </div>
  );
}
