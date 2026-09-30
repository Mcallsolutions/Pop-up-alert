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
  some. Gere um novo token, atualize o `.env` e reinicie a API. A API local
  repassa esse caso como `502` — nunca `401`, que o painel e a extensao leem
  como problema da credencial deles.
- Use o token de um usuario de **perfil admin**. So ele tem o `showAll=true`
  atendido: com usuario comum o MTalk ignora o parametro (sem erro) e a listagem
  de `open` volta so com os tickets do proprio dono do token — os pendentes das
  filas continuam vindo. A coleta sempre manda `showAll` e nao tenta seguir sem
  ele: um erro nessa chamada derruba a coleta (visivel no painel) e a seguinte
  tenta de novo.

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
| `GET /backend/messages/{ticketId}` (com `minUpdatedAt` e `nextId`, **nunca** `markAsRead`) | conversa do ticket, para a [analise de atendimento](../README.md#analise-de-atendimento-ia) | **so com `AI_ATTENDANCE_ANALYSIS=1`**; depois da coleta gravada, sem atrasar os alertas; so ticket que mudou ou que acabou de sair da listagem; ate `MTALK_MAX_MESSAGE_FETCHES` (20) por coleta |

Ou seja: **2 requisicoes por coleta** no caso comum. Com a analise de atendimento
desligada (padrao) nao existe chamada por ticket; ligada, as leituras de mensagem
tem teto proprio por coleta.

### O que fica de fora de proposito

| Chamada do painel | Por que o monitor nao usa |
| --- | --- |
| `markAsRead=true` em `GET /backend/messages/{ticketId}` | marcaria a conversa como lida para o atendente. O monitor le as mensagens so com a analise de atendimento ligada, e `listMessages` nem aceita esse parametro (um teste prova que ele nunca entra na URL). |
| `GET /backend/messages/{contactId}/history` e o Socket.IO (`appMessage`) | historico de outros tickets do contato e tempo real ficam fora desta fase: a leitura e incremental, dentro da coleta. |
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

- **Mensagens** (`/messages/{ticketId}`, so com a analise ligada): cursor por
  ticket (`last_message_updated_at`, enviado como `minUpdatedAt`), teto de
  `MTALK_MAX_MESSAGE_FETCHES` por coleta e trava propria — se a leitura anterior
  ainda roda, a da coleta seguinte e pulada.

A conta de requisicoes aparece em **Configuracoes** do painel e em
`requisicoesPorEndpoint` na resposta de `POST /api/mtalk/collect` (a chave
`GET /messages/{ticketId}` so existe com a analise ligada e e preenchida logo
depois da coleta, porque a leitura roda em segundo plano).

### Checklist antes de ligar a analise de atendimento

Os fatos abaixo foram confirmados no codigo do Ticketz; o MTalk e um fork e pode
diferir. Antes de por `AI_ATTENDANCE_ANALYSIS=1` em producao, valide com **um
ticket de teste** na instancia real (conversa com um numero da propria equipe):

1. **`markAsRead`**: abra o ticket de teste, mande uma mensagem pelo WhatsApp de
   teste sem abrir a conversa no MTalk e chame
   `GET /backend/messages/{ticketId}` sem `markAsRead`. O `unreadMessages` do
   ticket (em `GET /backend/tickets`) precisa continuar maior que zero.
2. **`userId`**: a resposta traz `userId` em cada mensagem? Se trouxer, o
   monitor ja usa como sinal de ATENDENTE; se nao, vale so a assinatura.
3. **`minUpdatedAt`**: chame com `minUpdatedAt` igual ao `updatedAt` da ultima
   mensagem. Confira se volta so o que mudou depois (e se usa `>` ou `>=`), se
   `hasMore`/`nextId` continuam valendo e se a resposta inclui mensagens de
   tickets anteriores do mesmo contato (o monitor descarta as de outro
   `ticketId`).
4. **`mediaType`**: mande texto, audio, imagem com legenda, documento,
   figurinha, localizacao, contato e uma reacao. Anote os valores de
   `mediaType` (tipo do WhatsApp ou prefixo de mimetype). O monitor grava o
   valor cru em `messages.media_type`, entao da para conferir depois com
   `SELECT DISTINCT media_type FROM messages`.
5. **Assinatura**: com a assinatura ligada, confira o comeco do `body` de uma
   mensagem do atendente. O monitor espera `*Nome:*` seguido de quebra de linha
   (aceita tambem `*Nome*:`). Se for outro formato, as mensagens humanas caem
   como EMPRESA em vez de ATENDENTE.

Depois de ligar, acompanhe em **Configuracoes > Analise de atendimento (IA)** a
ultima leitura e o orcamento da hora.

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
| Filas | `server/src/services/queue-filter.js` | Suporte-TerraNet, MIX, IDEZ, BDG, AIA |
| Atendentes | `server/src/services/attendant-filter.js` | tabela de apelidos (`Alek` -> `Aleksandro`) |
| Empresas | `whatsapp.name` do ticket | conexao do MTalk (ex.: `0800 MIXTEL`) |
| TAGs | `tags[]` do ticket e `contact.tags[]` do cliente | qualquer TAG vinculada = `COM_TAG` |
| Inatividade | `INACTIVITY_THRESHOLD_MINUTES` | 15 minutos |
| Status lidos | `MTALK_TICKET_STATUSES` | `open` e `pending` |
| Fuso | `MONITOR_TIME_ZONE` | `America/Sao_Paulo` |

## Banco

SQLite local (`server/data/monitor.sqlite`). Cada coleta grava um snapshot e uma
linha por ticket; os relatorios usam `external_ticket_id` (o id do ticket no
MTalk) para ficar com uma leitura por ticket: a mais recente nos de TAG e a de
maior parada no periodo nos de inatividade. Leituras com mais de
`RETENTION_DAYS` dias (padrao 90) sao apagadas sozinhas.

Com a analise de atendimento ligada, as mensagens vao para a tabela `messages`
**ja mascaradas** (so `body_masked`; o texto original nunca e gravado), com
`message_sync` guardando o cursor de cada ticket. As duas saem depois de
`MESSAGE_RETENTION_DAYS` dias (padrao 30).

`collected_at` e gravado na hora local da operacao com o offset
(`2026-09-15T21:40:05-03:00`), para que o filtro de dia do painel seja o dia de
Brasilia e nao o de UTC.