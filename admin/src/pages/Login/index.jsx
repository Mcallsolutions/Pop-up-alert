import React, { useState } from "react";
import { LogIn } from "lucide-react";
import { api, getApiBaseUrl } from "../../services/api";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [target, setTarget] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setTarget("");
    setLoading(true);
    try {
      const data = await api.login({ email, password });
      onLogin(data);
    } catch (requestError) {
      setError(requestError.message || "Nao foi possivel entrar");
      // Mostrar o endereco chamado facilita diagnosticar erro de CORS:
      // se nao for o mesmo dominio da pagina, a API esta configurada errada.
      setTarget(`${getApiBaseUrl() || window.location.origin}/api/auth/login`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={handleSubmit} autoComplete="off">
        <div className="login-title">
          <span className="mark">M</span>
          <div>
            <p>Mcall</p>
            <h1>Ticket Tag Monitor</h1>
          </div>
        </div>

        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="off" required />
        </label>

        <label>
          Senha
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="new-password"
            required
          />
        </label>

        {error ? (
          <p className="form-error">
            {error}
            {target ? (
              <>
                <br />
                <small>API chamada: {target}</small>
              </>
            ) : null}
          </p>
        ) : null}

        <button className="primary-button" type="submit" disabled={loading}>
          <LogIn aria-hidden="true" size={18} />
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </main>
  );
}
