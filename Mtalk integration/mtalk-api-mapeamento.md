# MTALK (Ticketz) - Mapeamento da API de atendimento

Instancia: https://s11.mtalk.com.br  |  Base da API: https://s11.mtalk.com.br/backend
Levantado em: 13/08/2026 (via inspecao de rede + bundles JS do painel)

## 1. Autenticacao

- Header: Authorization: Bearer <token>  (token guardado em localStorage["token"])
- POST /backend/auth/refresh_token  -> renova o token
- GET  /backend/auth/me             -> usuario logado
- localStorage tambem guarda companyId e userId (usados para montar os nomes dos eventos de socket)

## 2. Mensagens - leitura / recebimento (historico)

Endpoint central:

```http
GET /backend/messages/{ticketId}?markAsRead=true
GET /backend/messages/{ticketId}?nextId={id}        # paginacao (mensagens antigas)
GET /backend/messages/{ticketId}?minUpdatedAt={ISO} # sincroniza alteracoes (ack, edicao, exclusao)
```

Resposta: { count, messages[], ticket, hasMore, nextId }

Campos de cada mensagem:
id, body, fromMe, read, ack, mediaType, mediaUrl, thumbnailUrl, dataJson,
isDeleted, isEdited, quotedMsgId, quotedMsg, replies (reacoes), ticketId,
contactId, userId, queueId, companyId, channel, remoteJid, participant,
error, createdAt, updatedAt + objetos aninhados contact, ticket, user, queue

Regras uteis:
- fromMe = true  -> mensagem ENVIADA (atendente/bot/API)
- fromMe = false -> mensagem RECEBIDA (cliente)
- ack -> status de entrega (0 pendente ... 4 lida)
- mediaType/mediaUrl -> anexos; mediaType "reactionMessage" cai em replies do quotedMsgId

Complementares:
- GET /backend/messages/{contactId}/history
- GET /backend/messages/history/{contactId}/{whatsappId}

## 3. Tempo real (Socket.IO)

- Conexao: socket.io sobre a URL do backend, transports ["websocket"], query { token }, pingTimeout/pingInterval 18000
- Emits do cliente: joinChatBox (ticketId), joinTickets (status), joinNotification, leaveTickets, leaveNotification
- Eventos recebidos (nomeados por empresa, companyId = 11):
  - company-11-appMessage   -> { action: "create" | "update", message, ticket, contact }  (mensagens enviadas e recebidas)
  - company-11-ticket       -> criacao/atualizacao do ticket (troca de fila, atendente, status)
  - company-11-contact      -> atualizacao de contato
  - company-11-chat         -> chat interno entre atendentes
  - company-11-whatsappSession -> estado da conexao WhatsApp
  - outros: connection-refresh, userOnlineChange, settings, company-announcement, wsRefreshRequired

## 4. Mensagens - envio

Texto (JSON):
```http
POST /backend/messages/{ticketId}
{ "read": 1, "fromMe": true, "mediaUrl": "", "body": "<texto>",
  "quotedMsg": <msg|null>, "internal": false, "quickMessageMediaId": null }
```
Obs.: quando a assinatura do atendente esta ativa, o nome e prefixado no body.

Midia / arquivo (multipart/form-data no mesmo endpoint):
campos: medias (arquivo), body, fromMe, sendAsDocument (opcional)

Audio PTT: multipart com medias (.ogg), body vazio, fromMe=true, ptt=true

Outras operacoes:
- POST   /backend/messages/edit/{messageId}      -> editar
- DELETE /backend/messages/{messageId}           -> apagar
- POST   /backend/messages/react/{messageId}     -> { ticketId, emoji }
- POST   /backend/messages/forward               -> { contactId, ticketId, messageId, queueId }
- POST   /backend/messages/forward/internal      -> { chatId, ticketId, messageId }

## 5. API externa de envio (pagina "API de mensagens")

```bash
curl -X POST https://s11.mtalk.com.br/api/messages/send \
  -H "Authorization: Bearer {TOKEN_DA_CONEXAO}" \
  -H "Content-Type: application/json" \
  -d '{ "number": "558599999999", "body": "Sua mensagem",
        "saveOnTicket": true, "linkPreview": true, "startChatbot": true }'
```
Midia por URL: acrescentar "mediaType" e "mediaPath".
Upload direto: multipart/form-data com number, body, medias.

## 6. Contexto do ticket / apoio

- GET /backend/tickets/u/{uuid}   -> resolve o uuid da URL para o ticket numerico
- GET /backend/tickets?withUnreadMessages=true&notClosed=true&userQueues=true
- GET /backend/contacts/{id}
- GET /backend/ticket-notes/list?ticketId={id}&contactId={id}
- GET /backend/tags/list  |  GET /backend/quick-messages/list  |  GET /backend/whatsapp
- GET /backend/users/{id}  |  GET /backend/queue (ou /backend/queue/{id})
- Chat interno (entre atendentes): GET/POST /backend/chats/{id}/messages

## 7. Identificadores do ticket analisado

| Campo | Valor |
|---|---|
| id (ticket) | 631450 |
| uuid | 4855886a-0eb5-42e9-ad60-ed1cb7fccab0 |
| status | open |
| channel | whatsapp |
| queueId | 207 |
| queue.name | Suporte-MIX |
| queue.color | #1273DE |
| queueOptionId | null |
| chatbot | false |
| userId (atendente) | 157 |
| user.name | Gabriel Oliveira |
| whatsappId | 83 |
| whatsapp.name | 0800 MIXTEL |
| companyId | 11 |
| contactId | 45078 |
| createdAt (abertura) | 2026-08-13T11:09:17.366Z (08:09 BRT) |
| updatedAt | 2026-08-13T11:15:48.670Z (08:15 BRT) |
| unreadMessages | 0 |
| tags | [] |

Observacao: datas retornadas em UTC (ISO 8601); a interface exibe em BRT (UTC-3).