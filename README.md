# Mcall Ticket Tag Monitor

Monitor de TAG e de inatividade dos tickets do MTalk. O servidor le os tickets **somente pela API oficial do MTalk**, grava os snapshots em um banco local e alimenta:

- um **painel web** com relatorios, inatividade e resumos de IA;
- uma **extensao Chrome** que mostra o pop-up de alertas na tela de tickets do MTalk.

Por enquanto o projeto roda **apenas localmente** e o painel **nao tem login**.

## Estrutura

```text
server/             API Node.js + Express, coleta na API do MTalk e banco SQLite
admin/              Painel web React + Vite
extension/          Extensao Chrome MV3 (so o pop-up de alertas)
Mtalk integration/  Mapeamento da API oficial do MTalk e guia da integracao
package.json        Dependencias unicas do projeto (API + painel)
vite.config.js      Painel (root em admin/, saida em dist/, proxy de /api em dev)
```

## Rodando localmente

Requisitos: Node.js 22.5 ou superior. O banco e SQLite, embutido no Node (`node:sqlite`) — nao ha servidor de banco para instalar.

```bash
npm install
cp .env.example .env
# preencha MTALK_BASE_URL e MTALK_TOKEN no .env
npm run dev
```

Isso sobe:

- API em `http://localhost:3333`, ja coletando o MTalk a cada 60 segundos;
- Painel em `http://localhost:5173` (o Vite repassa `/api` e `/health` para a API).

O banco e criado sozinho em `server/data/monitor.sqlite` na primeira execucao (a pasta esta no `.gitignore`).

Outros comandos:

```bash
npm run dev:api     # so a API
npm run dev:admin   # so o painel
npm run build       # build do painel em dist/
npm start           # API sem --watch
npm run migrate     # cria/atualiza o banco e sai
```

### Credenciais do MTalk

A autenticacao e por **URL + token**:

- `MTALK_BASE_URL` — backend da instancia, terminando em `/backend` (ex.: `https://s11.mtalk.com.br/backend`);
- `MTALK_TOKEN` — token Bearer de um usuario com acesso as filas monitoradas. Pode ser colado cru, com `Bearer ` na frente ou entre aspas.

O servidor nao faz login nem renova o token. Quando o MTalk recusar (token expirado ou revogado), a coleta falha e o erro aparece no painel e no popup da extensao: gere um novo token, atualize o `.env` e reinicie a API. O token fica **so no `.env`**, que nao vai para o git — este repositorio e publico.

Sem token a API sobe normalmente, mas a coleta automatica fica desligada e o log avisa. Detalhes em [`Mtalk integration/README.md`](Mtalk%20integration/README.md).

Para conferir: **Configuracoes** no painel mostra se o token foi aceito, a ultima coleta e o botao **Coletar agora**.

## Extensao Chrome

A extensao **nao le a pagina nem a sessao do MTalk** e nao chama a API dele: so busca os alertas ja calculados no servidor local e desenha o pop-up.

1. Com a API rodando, abra `chrome://extensions`.
2. Ative o modo de desenvolvedor.
3. Clique em "Carregar sem compactacao" e selecione a pasta `extension`.
4. Acesse `https://s11.mtalk.com.br/tickets`.

A URL da API vem como `http://localhost:3333`; troque no popup ou nas opcoes da extensao se precisar.

Como funciona:

- a cada 1 minuto o content script pede `GET /api/mtalk/alerts` (a chamada sai do service worker, porque a pagina https do MTalk nao pode chamar `http://localhost`);
- **Registre a TAG do cliente** lista tickets sem TAG com atendente vinculado; **Alerta de inatividade** lista tickets parados ha mais de 15 minutos, com ou sem atendente;
- clicar no item abre o ticket (`/tickets/<uuid>`); fechar o pop-up silencia por 5 minutos;
- sem coleta recente no servidor (API fora do ar, token do MTalk recusado) o pop-up some, em vez de mostrar alerta velho;
- no popup, **Coletar agora** pede uma coleta imediata e **Testar API** confere a API local e o token do MTalk.

## API

Todos os endpoints sao abertos (ambiente local, sem login).

Coleta e alertas:

- `GET /api/mtalk/alerts` — alertas da ultima coleta, no formato do pop-up
- `GET /api/mtalk/status` — estado do token do MTalk, agendamento e ultima coleta (sem expor o token)
- `POST /api/mtalk/collect` — coleta agora; `?dryRun=1` le a API e nao grava

Relatorios:

- `GET /api/reports/summary`
- `GET /api/reports/filters` (valores disponiveis para os filtros do painel)
- `GET /api/reports/missing-tags`
- `GET /api/reports/by-attendant`
- `GET /api/reports/by-queue`
- `GET /api/reports/inactivity/summary`
- `GET /api/reports/inactivity/tickets`
- `GET /api/reports/inactivity/by-attendant`
- `GET /api/reports/inactivity/by-company`

IA:

- `GET /api/ai/status`
- `GET /api/ai/prompts` / `POST /api/ai/prompts` / `PUT /api/ai/prompts/:id` / `DELETE /api/ai/prompts/:id`
- `POST /api/ai/summary` (gera um resumo novo chamando a OpenAI)
- `GET /api/ai/summary/latest`
- `GET /api/ai/summaries?limit=10`

Diagnostico: `GET /health` (status da API e do banco).

Os endpoints de `/api/reports` aceitam os filtros `day`, `startDate`, `endDate`, `attendant`, `company`, `queue`, `clientName` e `limit`. A busca por texto e parcial; `attendant` tambem casa com o nome canonico (`Alek` encontra `Aleksandro`). Os relatorios consideram apenas as filas monitoradas e, de cada ticket, so a leitura mais recente.

### Tickets aguardando na fila (sem atendente)

Um ticket `pending` normalmente vem **sem atendente vinculado**: ninguem o assumiu ainda.

| Relatorio | Ticket sem atendente |
| --- | --- |
| `missing-tags`, `by-queue`, `by-attendant`, contadores de TAG do `summary` | **fora** — nao ha responsavel a quem cobrar a TAG |
| `inactivity/*` e `totalInactive` do `summary` | **dentro** — parado e sem responsavel e o caso mais grave |

Quantos ficaram de fora aparece em `semAtendenteOcultos` (`missing-tags`) e em `totalWithoutAttendant` (`summary`). A `compliancePercent` considera apenas o que da para cobrar.

As listas de tickets so trazem contato com nome; os demais sao contados em `incompletosOcultos`.

## Aba IA (OpenAI)

O painel tem uma aba **IA** com tres partes:

1. **Prompts e treinamentos** — instrucoes (`INSTRUCAO`) e exemplos (`TREINAMENTO`). Tudo que estiver **ativo** e enviado junto com os dados a cada resumo.
2. **Resumo da IA** — os filtros da barra definem o recorte enviado ao modelo, montado com os mesmos relatorios que o painel exibe.
3. **Historico** — cada resumo fica salvo com modelo, tokens e filtros. O ultimo tambem aparece no Dashboard.

A resposta e pedida com `response_format: json_schema` em modo **strict**:

```json
{
  "resumo": "texto",
  "nivelRisco": "BAIXO | MEDIO | ALTO",
  "pontosCriticos": ["..."],
  "atendentes": [{ "nome": "...", "observacao": "..." }],
  "filas": [{ "fila": "...", "observacao": "..." }],
  "recomendacoes": ["..."]
}
```

Se o modelo nao aceitar `json_schema`, a chamada reenvia com `json_object`. Parametros recusados por familias de modelo mais novas (`max_tokens`, `temperature`) sao corrigidos a partir da propria resposta `400`, no maximo duas vezes.

As listas de ticket enviadas ao modelo sao **amostras** de no maximo 40 linhas, rotuladas com o `total` real, para o modelo nunca contar linhas da amostra.

Variaveis: `OPENAI_API_KEY` (obrigatoria para gerar), `OPENAI_MODEL` (padrao `gpt-4o-mini`) e as opcionais `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, `OPENAI_TEMPERATURE` (`0.2`), `OPENAI_MAX_OUTPUT_TOKENS` (`2000`), `OPENAI_TIMEOUT_MS` (`25000`). Valor vazio cai no padrao.

## Horarios

As tabelas mostram o **horario do ticket**: a ultima movimentacao no MTalk (`updatedAt`, gravado em `last_message_at`), que tambem e a origem do calculo de inatividade. O horario da coleta aparece so em "Ultima atualizacao" e "Ultima coleta".

O filtro de dia usa o fuso `MONITOR_TIME_ZONE` (padrao `America/Sao_Paulo`).

## Banco de dados

SQLite em `server/data/monitor.sqlite` (ou `SQLITE_PATH`). As migrations ficam em `server/src/database/index.js` (constante `MIGRATIONS`) e rodam ao subir a API, controladas pela tabela `schema_migrations`. Para adicionar uma, crie uma nova chave — nunca edite uma que ja rodou.

## Seguranca e LGPD

Enquanto o painel nao tem login, **nao exponha a porta 3333 nem a 5173 fora da maquina**: qualquer um que alcance a API le os relatorios.

O projeto coleta apenas o necessario para o relatorio: cliente, fila, atendente, conexao, horario, TAGs, status e identificadores do ticket. Ele **nao le o conteudo das mensagens** — nunca chama `GET /backend/messages/{ticketId}` — e nao faz nenhuma escrita no atendimento.

Os tokens do MTalk e da OpenAI ficam apenas no `.env` local; a API nunca os grava no banco nem os devolve.

Atencao ao usar a aba **IA**: gerar um resumo envia para a OpenAI o recorte filtrado, incluindo nomes de clientes, atendentes e empresas.
