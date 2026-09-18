import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { api, setApiToken } from "../services/api";
import { formatDateTime } from "../services/datetime";

const NOVO_VAZIO = { name: "", attendant: "", role: "ATENDENTE" };

// Emissao e revogacao dos tokens de acesso a esta API. So ADMIN chega aqui.
export default function TokenManager({ authRequired, onTokenTrocado }) {
  const [items, setItems] = useState([]);
  const [novo, setNovo] = useState(NOVO_VAZIO);
  const [criado, setCriado] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    try {
      const { items: lista } = await api.tokens();
      setItems(lista);
      setErro("");
    } catch (error) {
      setErro(error.message);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  async function criar(event) {
    event.preventDefault();
    setSalvando(true);
    try {
      const resultado = await api.createToken(novo);
      setCriado(resultado);
      setNovo(NOVO_VAZIO);
      setErro("");
      await carregar();
    } catch (error) {
      setErro(error.message);
    } finally {
      setSalvando(false);
    }
  }

  async function revogar(item) {
    setErro("");
    try {
      await api.revokeToken(item.id);
      await carregar();
    } catch (error) {
      setErro(error.message);
    }
  }

  // Usar o token recem-criado neste navegador. E o caminho normal para o
  // primeiro token: sem ele, criar o primeiro deslogaria o painel na hora.
  function usarAqui() {
    setApiToken(criado.token);
    setCriado(null);
    onTokenTrocado?.();
  }

  return (
    <div className="table-panel">
      <h3>Acessos e tokens</h3>

      {!authRequired ? (
        <p className="notice warning">
          Nenhum token ativo: a API esta <strong>aberta</strong> e qualquer um que a alcance ve tudo. Ao criar o
          primeiro token ela passa a exigir token de todo mundo — inclusive deste painel e da extensao.
        </p>
      ) : null}

      {erro ? <p className="notice error">{erro}</p> : null}

      {criado ? (
        <div className="notice success token-revelado">
          <p>
            Token de <strong>{criado.item.name}</strong> criado. Ele <strong>nao aparece de novo</strong>: copie agora
            e entregue para a pessoa.
          </p>
          <code>{criado.token}</code>
          <div className="token-revelado-acoes">
            <button className="secondary-button" type="button" onClick={usarAqui}>
              <KeyRound aria-hidden="true" size={16} />
              Usar neste painel
            </button>
            <button className="link-button" type="button" onClick={() => setCriado(null)}>
              Ja copiei
            </button>
          </div>
        </div>
      ) : null}

      <div className="table-scroll">
        {carregando ? (
          <p className="notice">Carregando...</p>
        ) : !items.length ? (
          <p className="notice">Nenhum token emitido ate agora.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Ve</th>
                <th>Token</th>
                <th>Ultimo uso</th>
                <th>Situacao</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>
                    {item.role === "ADMIN" ? (
                      <span className="badge ativo">tudo (ADMIN)</span>
                    ) : (
                      `${item.attendant} + tickets sem atendente`
                    )}
                  </td>
                  <td>
                    <code>{item.tokenHint}</code>
                  </td>
                  <td>{item.lastUsedAt ? formatDateTime(item.lastUsedAt) : "nunca"}</td>
                  <td>{item.isActive ? "ativo" : `revogado em ${formatDateTime(item.revokedAt)}`}</td>
                  <td>
                    {item.isActive ? (
                      <button className="link-button danger" type="button" onClick={() => revogar(item)}>
                        <Trash2 aria-hidden="true" size={15} />
                        Revogar
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form className="settings-form" onSubmit={criar}>
        <label>
          Nome do token
          <input
            value={novo.name}
            onChange={(event) => setNovo({ ...novo, name: event.target.value })}
            placeholder="Stephanie - notebook"
            required
          />
        </label>

        <label>
          Perfil
          <select value={novo.role} onChange={(event) => setNovo({ ...novo, role: event.target.value })}>
            <option value="ATENDENTE">Atendente (ve os proprios tickets)</option>
            <option value="ADMIN">Administrador (ve tudo e a aba IA)</option>
          </select>
        </label>

        {novo.role === "ATENDENTE" ? (
          <label>
            Atendente
            <input
              value={novo.attendant}
              onChange={(event) => setNovo({ ...novo, attendant: event.target.value })}
              placeholder="Stephanie"
              required
            />
            <small>
              O nome como aparece no MTalk. Variacoes conhecidas sao unificadas sozinhas ("Alek NETFIBRA" vira
              "Aleksandro").
            </small>
          </label>
        ) : null}

        <button className="primary-button" type="submit" disabled={salvando}>
          <Plus aria-hidden="true" size={17} />
          {salvando ? "Criando..." : "Criar token"}
        </button>
      </form>
    </div>
  );
}
