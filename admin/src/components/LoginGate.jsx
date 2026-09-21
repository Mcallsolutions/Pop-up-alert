import { useState } from "react";
import { LogIn, Tags } from "lucide-react";

// Tela de login do painel. Os usuarios sao criados pela linha de comando
// (`npm run admin -- criar ...`); os tokens por pessoa sao so da extensao.
export default function LoginGate({ error, onSubmit }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [enviando, setEnviando] = useState(false);

  const podeEnviar = username.trim() && password;

  async function submit(event) {
    event.preventDefault();
    if (!podeEnviar) {
      return;
    }

    setEnviando(true);
    try {
      await onSubmit(username.trim(), password);
    } finally {
      setEnviando(false);
      setPassword("");
    }
  }

  return (
    <div className="token-gate">
      <form className="token-gate-card" onSubmit={submit}>
        <div className="brand">
          <Tags aria-hidden="true" size={24} />
          <div>
            <strong>Mcall</strong>
            <span>Ticket Tag Monitor</span>
          </div>
        </div>

        <h1>Acesso ao painel</h1>
        <p>Entre com o seu usuario e senha de administrador.</p>

        {error ? <p className="notice error">{error}</p> : null}

        <label>
          Usuario
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
          />
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

        <button className="primary-button" type="submit" disabled={enviando || !podeEnviar}>
          <LogIn aria-hidden="true" size={17} />
          {enviando ? "Entrando..." : "Entrar"}
        </button>

        <small>
          Sem usuario? Quem administra o servidor cria pela linha de comando:{" "}
          <code>npm run admin -- criar --login seu.login --nome "Seu nome"</code>
        </small>
      </form>
    </div>
  );
}
