import React, { useState } from "react";
import { LogIn } from "lucide-react";
import { api } from "../../services/api";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("admin@mcall.local");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await api.login({ email, password });
      onLogin(data);
    } catch (requestError) {
      setError(requestError.message || "Nao foi possivel entrar");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={handleSubmit}>
        <div className="login-title">
          <span className="mark">M</span>
          <div>
            <p>Mcall</p>
            <h1>Ticket Tag Monitor</h1>
          </div>
        </div>

        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="username" />
        </label>

        <label>
          Senha
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </label>

        {error ? <p className="form-error">{error}</p> : null}

        <button className="primary-button" type="submit" disabled={loading}>
          <LogIn aria-hidden="true" size={18} />
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </main>
  );
}
