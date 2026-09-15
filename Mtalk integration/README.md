# Integracao com a API oficial do MTalk

Este diretorio guarda os levantamentos da API e este guia, que descreve como o
projeto le os tickets **somente pela API oficial do MTalk**.

| Arquivo | Conteudo |
| --- | --- |
| `mtalk-api-endpoints.md` | Levantamento de rede da tela de atendimento: cada chamada que o painel faz, com os parametros reais, inclusive as de escrita. **E a referencia do formato das chamadas do monitor.** |
| `mtalk-api-mapeamento.md` | Mapeamento anterior (rede + bundles JS): autenticacao, mensagens, socket e rotas de apoio como `GET /backend/queue`. |

## Arquitetura

```text
MTalk (API /backend)  <--  servidor local (coleta a cada 60s)  -->  SQLite
                                     |
                     +---------------+----------------+
                     |                                |
            painel web (relatorios)       extensao Chrome (so o pop-up)
```

- **Quem fala com o MTalk e so o servidor** (`server/src/services/mtalk/`). Ele
  autentica com URL + token, le os tickets, grava o snapshot e guarda a ultima
  leitura em memoria.
- **A extensao nao le nada do MTalk**: nao olha o DOM, nao le o `localStorage`
  nem a sessao do navegador e nao chama a API do MTalk. Ela busca os alertas ja
  calculados em `GET /api/mtalk/alerts` no servidor local e desenha o pop-up na
  tela de tickets.
## Autenticacao: URL + token

| Variavel | Valor |
| --- | --- |
| `MTALK_BASE_URL` | backend da instancia, terminando em `/backend` (ex.: `https://s11.mtalk.com.br/backend`) |
| `MTALK_TOKEN` | token Bearer de um usuario do MTalk |

- Cada leitura vai com `Authorization: Bearer <MTALK_TOKEN>`. O servidor **nao faz
  login** nem chama `/auth/refresh_token`.
- O token pode ser colado cru, com `Bearer ` na frente ou entre aspas (como fica
  em `localStorage["token"]` no painel do MTalk).
- O token nunca vai para o banco, para o log ou para `GET /api/mtalk/status`.
- **Token expirado ou revogado**: o MTalk responde 401/403, a coleta falha, o
  erro aparece em **Configuracoes** do painel e no popup da extensao, e o pop-up
  some. Gere um novo token, atualize o `.env` e reinicie a API.
- Use o token de um usuario com acesso as filas monitoradas. Um perfil
  administrativo aceita `showAll=true` e enxerga os tickets de todos os
  atendentes; sem ele, a coleta le as filas do proprio usuario.

## O que o monitor chama — e so isso

Por coleta (padrao de 1 minuto, `MTALK_COLLECT_INTERVAL_SECONDS`):

| Chamada | Para que | Quando |
| --- | --- | --- |
| `GET /backend/tickets?status=open&showAll=true&queueIds=[...]` | tickets em atendimento, de todos os atendentes | 1x por coleta |
| `GET /backend/tickets?status=pending&queueIds=[...]` | tickets aguardando na fila (a aba de pendentes do painel nao usa `showAll`) | 1x por coleta |
| `...&pageNumber=N` | paginas extras, so quando o status tem mais de 40 tickets | raro |
| `GET /backend/queue` | traduzir os nomes das filas monitoradas nos ids do `queueIds` | 1x a cada 60 min (cache) |
| `GET /backend/tags/list` | nomear TAG que chega so com o id | so quando isso acontece; cache de 10 min |
| `GET /backend/contacts/{id}` | TAG do cliente, quando a listagem nao a traz | so ticket sem TAG e com atendente; cache por contato; ate 20 consultas novas por coleta |

Ou seja: **2 requisicoes por coleta** no caso comum. Nao existe chamada por
ticket.

### O que fica de fora de proposito

| Chamada do painel | Por que o monitor nao usa |
| --- | --- |
| `GET /backend/messages/{ticketId}?markAsRead=true` | marcaria a conversa como lida para o atendente. O monitor nao le conteudo de mensagem. |
| `POST /backend/messages/{ticketId}`, `POST /backend/ticket-notes`, `POST`/`DELETE /backend/tickets/{id}/tags`, `PUT /backend/tickets/{id}` | escrita: a mensagem de teste do levantamento chegou ao WhatsApp real do cliente. O cliente HTTP do servidor so tem leituras (`GET`). |
| `GET /backend/settings/*`, `/users/list`, `/quick-messages/list`, `/chats`, `/ticket-notes/list`, `/tickets/u/{uuid}` | servem para montar a tela; nenhum desses dados entra no alerta ou no relatorio. |

### Cache e travas

- **Filas** (`/queue`): 60 minutos. Os ids so mudam quando uma fila e recriada.
- **Catalogo de TAGs** (`/tags/list`): so e lido quando algum vinculo chega sem
  nome. Quando lido, fica 10 minutos em cache.
- **Contato** (`/contacts/{id}`): cache por contato — 30 minutos quando o cliente
  ja tem TAG, 3 minutos quando nao tem, para o alerta sumir pouco depois de o
  atendente registrar a TAG no contato.
- **Uma coleta por vez**: o botao "Coletar agora" durante uma coleta agendada
  espera a que ja esta rodando em vez de dobrar as chamadas.

A conta de requisicoes aparece em **Configuracoes** do painel e em
`requisicoesPorEndpoint` na resposta de `POST /api/mtalk/collect`.

## Identificacao das TAGs

Uma TAG pode estar vinculada em dois lugares, e o painel do MTalk mostra os dois
no mesmo campo:

| Origem | Campo na resposta de `GET /backend/tickets` |
| --- | --- |
| TAG marcada no atendimento | `ticket.tags[]` |
| TAG marcada no cliente | `ticket.contact.tags[]` |

O monitor le **as duas**: qualquer uma tira o ticket da lista de alerta.

O catalogo (`GET /backend/tags/list`) da nome ao vinculo que chega so com o id
(`{ tagId: 7 }`) e descarta vinculo de TAG ja excluida. Se ele falhar, a leitura
continua: para o alerta, o que decide e existir vinculo.

Quando a instancia **nao** devolve `contact.tags` na listagem (campo ausente, nao
vazio), o monitor consulta `GET /backend/contacts/{id}` com as travas acima.

Codigo: `server/src/services/mtalk/mtalk.tags.js`.

## Alertas e relatorios

- **Registre a TAG do cliente**: ticket sem TAG, com atendente vinculado e contato
  com nome.
- **Alerta de inatividade**: ticket parado ha mais de
  `INACTIVITY_THRESHOLD_MINUTES` (15) desde o `updatedAt`, com ou sem atendente.

Ticket `pending` normalmente chega **sem atendente** (`user` nulo): ninguem o
assumiu. Ele fica fora dos relatorios e do alerta de TAG — nao ha a quem cobrar —,
mas continua no de inatividade, onde "parado e sem responsavel" e o caso mais
grave.

O pop-up so aparece com uma coleta recente (ate 3 intervalos, minimo 3 minutos).
Com a API local fora do ar ou o MTalk recusando o token, ele some em vez de
mostrar alerta velho.

## Parametros monitorados

| Parametro | Onde fica | Valor |
| --- | --- | --- |
| Filas | `server/src/services/queue-filter.js` | Suporte-TerraNet, PLANET, MIX, IDEZ, BDG, AIA |
| Atendentes | `server/src/services/attendant-filter.js` | tabela de apelidos (`Alek` -> `Aleksandro`) |
| Empresas | `whatsapp.name` do ticket | conexao do MTalk (ex.: `0800 MIXTEL`) |
| TAGs | `tags[]` do ticket e `contact.tags[]` do cliente | qualquer TAG vinculada = `COM_TAG` |
| Inatividade | `INACTIVITY_THRESHOLD_MINUTES` | 15 minutos |
| Status lidos | `MTALK_TICKET_STATUSES` | `open` e `pending` |
| Fuso | `MONITOR_TIME_ZONE` | `America/Sao_Paulo` |

## Banco

SQLite local (`server/data/monitor.sqlite`). Cada coleta grava um snapshot e uma
linha por ticket; os relatorios usam `external_ticket_id` (o id do ticket no
MTalk) para ficar so com a leitura mais recente de cada ticket.

`collected_at` e gravado na hora local da operacao com o offset
(`2026-09-15T21:40:05-03:00`), para que o filtro de dia do painel seja o dia de
Brasilia e nao o de UTC.