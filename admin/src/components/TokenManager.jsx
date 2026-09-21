import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../services/api";
import { formatDateTime } from "../services/datetime";

const NOVO_VAZIO = { name: "", attendant: "", role: "ATENDENTE" };

// Emissao e revogacao dos tokens da extensao (pop-up). Cada token identifica
// um atendente e recorta os alertas que chegam no navegador dele. O painel em
// si nao usa token: entra com usuario e senha.
export default function TokenManager() {
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

  const modoAberto = !carregando && !erro && !items.some((item) => item.isActive);

  return (
    <div className="table-panel">
      <h3>Tokens da extensao</h3>

      {modoAberto ? (
        <p className="notice warning">
          Nenhum token ativo: a extensao esta <strong>aberta</strong> e qualquer um que alcance a API recebe todos os
          alertas. Ao criar o primeiro token, a extensao passa a exigir o token de cada atendente.
        </p>
      ) : null}

      {erro ? <p className="notice error">{erro}</p> : null}

      {criado ? (
        <div className="notice success token-revelado">
          <p>
            Token de <strong>{criado.item.name}</strong> criado. Ele <strong>nao aparece de novo</strong>: copie agora
            e entregue para a pessoa colar nas opcoes da extensao.
          </p>
          <code>{criado.token}</code>
          <div className="token-revelado-acoes">
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
                      <span className="badge ativo">todos os alertas</span>
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
            <option value="ADMIN">Supervisao (recebe os alertas de todos)</option>
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
