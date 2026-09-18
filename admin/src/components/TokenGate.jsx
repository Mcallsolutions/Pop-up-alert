import { useState } from "react";
import { KeyRound, Tags } from "lucide-react";

// Tela de acesso: aparece quando a API exige token e o navegador ainda nao tem
// um valido. O token e emitido por `npm run token -- criar ...` ou, por quem ja
// e ADMIN, em Configuracoes.
export default function TokenGate({ error, onSubmit }) {
  const [token, setToken] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!token.trim()) {
      return;
    }

    setEnviando(true);
    try {
      await onSubmit(token);
    } finally {
      setEnviando(false);
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
        <p>
          Cole o seu token. Ele define o que voce ve: token de atendente mostra os proprios tickets e todos os que
          estao sem atendente.
        </p>

        {error ? <p className="notice error">{error}</p> : null}

        <label>
          Token de acesso
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            type="password"
            placeholder="mca_..."
            autoComplete="off"
            autoFocus
          />
        </label>

        <button className="primary-button" type="submit" disabled={enviando || !token.trim()}>
          <KeyRound aria-hidden="true" size={17} />
          {enviando ? "Verificando..." : "Entrar"}
        </button>

        <small>
          Nao tem um token? Peca a quem administra o monitor, ou gere pela linha de comando:{" "}
          <code>npm run token -- criar --nome "Seu nome" --atendente "Seu nome"</code>
        </small>
      </form>
    </div>
  );
}
