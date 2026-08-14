# Integracao com a API oficial do MTalk

Este diretorio guarda o mapeamento da API (`mtalk-api-mapeamento.md`) e este
guia, que descreve como o projeto passou a **ler os tickets pela API oficial**
em vez de interpretar a tela do painel.

## Por que mudou

A leitura de tela dependia de heuristica: pontuava elementos do DOM para
adivinhar qual bloco era um ticket e qual texto era cliente, fila, atendente,
empresa ou TAG. Qualquer ajuste de layout no MTalk podia quebrar tudo, o
horario vinha como texto (`08:15`) e a inatividade era estimada a partir dele.

Na API cada campo ja vem separado e com o dado real:

| Dado | Antes (tela) | Agora (API) |
| --- | --- | --- |
| Cliente | maior linha em caixa alta do card | `contact.name` |
| Fila | linha com `Suporte-...` | `queue.name` |
| Atendente | linha que casava com a lista de apelidos | `user.name` |
| Empresa | linha comecando com NETFIBRA/MIX/... | `whatsapp.name` |
| TAG | elemento pequeno, colorido, `XXX - NOME` | `tags[]` |
| Horario | `HH:mm` lido do card | `updatedAt` (ISO, UTC) |
| Inatividade | diferenca do `HH:mm` para agora | diferenca real de `updatedAt` |
| Identidade | cliente + fila + atendente + empresa + hora | `id` do ticket |

## Quantas requisicoes cada leitura faz

O objetivo e manter a leitura barata. Por ciclo (padrao de 1 minuto):

| Chamada | Quando | Frequencia |
| --- | --- | --- |
| `GET /backend/queue` | resolver os ids das filas monitoradas | 1x a cada 10 min (cache) |
| `GET /backend/tickets?status=open` | tickets em atendimento | 1x por ciclo |
| `GET /backend/tickets?status=pending` | tickets aguardando | 1x por ciclo |
| paginas extras | so quando ha mais de 40 tickets no status | raro |

Ou seja: **2 requisicoes por ciclo** no caso comum, 3 quando o cache de filas
expira. Nao existe nenhuma chamada por ticket — fila, atendente, empresa e tags
vem dentro da propria listagem.

Duas decisoes ajudam nisso:

- as filas monitoradas viram `queueIds` na query, entao o proprio MTalk ja
  devolve so o que interessa;
- o `MutationObserver` que disparava uma leitura a cada mudanca no DOM foi
  removido. Com chamadas de rede ele viraria rajada de requisicao a toa; o
  intervalo fixo e a unica fonte de leituras automaticas.

## Os dois caminhos de coleta

### 1. Extensao (padrao, nao precisa configurar nada)

`extension/src/mtalk-api.js` roda dentro da pagina do painel do MTalk, entao:

- usa o token da **sessao ja aberta** (`localStorage["token"]`), sem segredo
  novo para guardar;
- as chamadas sao de mesma origem (`s11.mtalk.com.br` -> `/backend`), sem CORS;
- quando o token expira, tenta `POST /backend/auth/refresh_token` uma vez e
  refaz a chamada. O token renovado fica **so em memoria**, para nao mexer no
  estado da aplicacao do MTalk.

`extension/src/content.js` ficou responsavel apenas por agendar as leituras,
desenhar os alertas na tela e mandar o snapshot para `POST /api/tickets/snapshot`.

### 2. Servidor (opcional, sem navegador aberto)

`POST /api/mtalk/collect` faz a mesma leitura direto do servidor e grava o
snapshot. Exige `MTALK_TOKEN` no ambiente e o mesmo `EXTENSION_TOKEN` das outras
rotas de coleta (ou o `CRON_SECRET`, para Cron Job da Vercel).

```bash
curl -X POST "https://seu-projeto.vercel.app/api/mtalk/collect" -H "x-extension-token: SEU_TOKEN"
```

Para conferir sem gravar nada, use `?dryRun=1`.

Atencao: o token do MTalk expira junto com a sessao do usuario que o gerou,
entao esse caminho precisa de manutencao periodica. A extensao nao tem esse
problema porque le a sessao viva do navegador.

## Parametros monitorados

Sao os mesmos de antes, agora aplicados sobre dados estruturados:

| Parametro | Onde fica | Valor |
| --- | --- | --- |
| Filas | `server/src/services/queue-filter.js` e `extension/src/mtalk-api.js` | Suporte-TerraNet, PLANET, MIX, IDEZ, BDG, AIA |
| Atendentes | `server/src/services/attendant-filter.js` e `extension/src/mtalk-api.js` | tabela de apelidos (`Alek` -> `Aleksandro`) |
| Empresas | `whatsapp.name` do ticket | conexao do MTalk (ex.: `0800 MIXTEL`) |
| TAGs | `tags[]` do ticket | qualquer tag registrada = `COM_TAG` |
| Inatividade | `server/src/config/monitoring.js` (`INACTIVITY_THRESHOLD_MINUTES`) | 15 minutos |
| Status lidos | `MTALK_TICKET_STATUSES` | `open` e `pending` |

## O que mudou no banco

A migration `005_mtalk_api.sql` adiciona colunas que so existem quando a leitura
veio da API: `external_ticket_id`, `ticket_uuid`, `ticket_status`,
`last_message_at`, `unread_messages` e `tags`. Registros antigos ficam com esses
campos nulos e continuam sendo lidos como antes.

Nos relatorios, `external_ticket_id` passa a ser a chave de deduplicacao — uma
linha por ticket, e nao mais uma por cliente. Nessas linhas as heuristicas de
limpeza sao puladas de proposito: o nome vem do cadastro do contato, entao um
cliente chamado "MIXTELECOM" nao e mais confundido com nome de empresa, e um
atendente novo aparece no relatorio sem precisar entrar na lista de apelidos.

## Tickets aguardando na fila

Ler o status `pending` traz tickets que **ninguem assumiu ainda**: o MTalk
devolve `userId` e `user` nulos, e o atendente chega vazio ate o relatorio. Ao
contrario da leitura de tela, onde atendente vazio era falha de leitura, aqui e
um fato — e os dois casos precisam de tratamento diferente:

- **relatorios de TAG** (`missing-tags`, `by-queue`, `by-attendant` e os
  contadores de TAG do `summary`): ficam de fora. Nao ha responsavel a quem
  cobrar a TAG, e conta-los como falha distorce a conformidade de quem esta
  atendendo;
- **relatorios de inatividade**: continuam dentro. Um ticket parado ha 50
  minutos sem ninguem atendendo e exatamente o alerta que importa.

O alerta na tela segue a mesma divisao: "Registre a TAG do cliente" so lista
tickets com atendente; "Alerta de inatividade" lista todos.

O corte e aplicado apenas nas linhas com `external_ticket_id` preenchido, ou
seja, nas gravadas pela API. O historico da leitura de tela continua com a regra
antiga.
