# Endpoints da API — MTALK (s11.mtalk.com.br)

Levantamento das requisições feitas pelo front-end do MTALK ao carregar a tela de atendimento e abrir o ticket do cliente **Gabriel Oliveira** (ticket `#641422`, `ticketId=641422`, `contactId=45078`, uuid do ticket `6cd12700-6648-4a82-854d-c9fa7baa9619`).

As requisições abaixo foram capturadas via rede do navegador enquanto a tela era carregada, o ticket era aberto e, em seguida, algumas ações de teste eram executadas no próprio ticket do Gabriel Oliveira (envio de mensagem, criação de nota interna e inclusão/remoção de tag), para também capturar os endpoints de escrita (`POST`/`DELETE`).

Host base: `https://s11.mtalk.com.br`

---

## 1. Configurações (settings)

Buscam flags/configurações gerais do sistema, carregadas no início da sessão.

| Endpoint | Método | Exemplo |
|---|---|---|
| `/backend/settings/allowSilentlyClose` | GET | `https://s11.mtalk.com.br/backend/settings/allowSilentlyClose` |
| `/backend/settings/allowSpy` | GET | `https://s11.mtalk.com.br/backend/settings/allowSpy` |
| `/backend/settings/desktopActionIconZoom` | GET | `https://s11.mtalk.com.br/backend/settings/desktopActionIconZoom` |
| `/backend/settings/tagsMode` | GET | `https://s11.mtalk.com.br/backend/settings/tagsMode` |
| `/backend/settings/CheckMsgIsGroup` | GET | `https://s11.mtalk.com.br/backend/settings/CheckMsgIsGroup` |

## 2. Listas de apoio (tags, usuários, mensagens rápidas)

Carregadas repetidamente pela interface (a cada troca de tela/ticket).

| Endpoint | Método | Descrição | Exemplo |
|---|---|---|---|
| `/backend/tags/list` | GET | Lista de tags disponíveis para os tickets | `https://s11.mtalk.com.br/backend/tags/list` |
| `/backend/users/list` | GET | Lista de usuários/atendentes do sistema | `https://s11.mtalk.com.br/backend/users/list` |
| `/backend/quick-messages/list` | GET | Lista de mensagens rápidas (respostas prontas) | `https://s11.mtalk.com.br/backend/quick-messages/list` |

## 3. Listagem de tickets

Endpoint `/backend/tickets` usado com diferentes combinações de query params conforme a aba/filtro selecionado (busca, pendentes, abertos).

| Uso | Método | Exemplo |
|---|---|---|
| Busca geral (todas as filas, sem termo de busca) | GET | `https://s11.mtalk.com.br/backend/tickets?isSearch=true&searchParam=&tags=[]&users=[]&showAll=true&queueIds=[157,360,396,...]` |
| Tickets com status **pendente** | GET | `https://s11.mtalk.com.br/backend/tickets?status=pending&queueIds=[157,360,396,...]` |
| Tickets com status **aberto** | GET | `https://s11.mtalk.com.br/backend/tickets?status=open&showAll=true&queueIds=[157,360,396,...]` |

Parâmetros identificados:
- `isSearch` (boolean) — indica se é uma busca textual
- `searchParam` (string) — termo digitado na busca
- `tags` (array, JSON) — filtro por tags
- `users` (array, JSON) — filtro por atendente
- `status` (string) — `pending` | `open` (entre outros possíveis)
- `showAll` (boolean) — exibe tickets de todos os atendentes/filas
- `queueIds` (array, JSON) — lista de IDs das filas visíveis ao usuário logado

## 4. Detalhe do ticket e conversa (exemplo: Gabriel Oliveira)

Sequência de chamadas disparadas ao abrir o ticket `#641422` do cliente **Gabriel Oliveira**:

| Ordem | Endpoint | Método | Descrição |
|---|---|---|---|
| 1 | `/backend/tickets/u/{uuid}` | GET | Busca o ticket pelo UUID. Exemplo: `https://s11.mtalk.com.br/backend/tickets/u/6cd12700-6648-4a82-854d-c9fa7baa9619` |
| 2 | `/backend/ticket-notes/list?ticketId={ticketId}&contactId={contactId}` | GET | Notas internas do ticket. Exemplo: `https://s11.mtalk.com.br/backend/ticket-notes/list?ticketId=641422&contactId=45078` |
| 3 | `/backend/contacts/{contactId}` | GET | Dados cadastrais do contato/cliente. Exemplo: `https://s11.mtalk.com.br/backend/contacts/45078` |
| 4 | `/backend/messages/{ticketId}?markAsRead=true` | GET | Histórico de mensagens do ticket, marcando como lidas. Exemplo: `https://s11.mtalk.com.br/backend/messages/641422?markAsRead=true` |

> Observação: a mesma sequência foi observada para outro ticket aberto durante a navegação (ticket `#641393`, `contactId=718870`, uuid `eda4bdbc-a370-4493-9d72-a4488e43c8fd`), confirmando o padrão do fluxo.

## 5. Lista de conversas (inbox)

| Endpoint | Método | Descrição | Exemplo |
|---|---|---|---|
| `/backend/chats?pageNumber={n}` | GET | Lista paginada de conversas/chats | `https://s11.mtalk.com.br/backend/chats?pageNumber=1` |

## 6. Arquivos estáticos / imagens

| Endpoint | Método | Descrição |
|---|---|---|
| `/backend/public/{arquivo}` | GET | Arquivos públicos (ex.: logotipo `Cr2TQ-Logotipo_Mtalk_Png_(1).png`) |
| `/nopicture.png` | GET | Avatar padrão quando o contato não possui foto |

## 7. Recursos externos (fora da API do MTALK)

Além das chamadas ao backend do MTALK, a tela também carrega fotos de perfil diretamente do WhatsApp:

- `https://pps.whatsapp.net/v/t61.24694-24/...` — miniaturas de foto de perfil dos contatos no WhatsApp (alguns retornaram `403`, provavelmente por expiração do link assinado `oh=...&oe=...`).

## 8. Ações de escrita (POST / DELETE) — testadas no ticket do Gabriel Oliveira

Endpoints confirmados ao executar, de fato, as ações no ticket `#641422` (`ticketId=641422`, `contactId=45078`) como teste:

| Ação testada | Endpoint | Método | Status | Observações |
|---|---|---|---|---|
| Enviar mensagem no chat do ticket | `/backend/messages/{ticketId}` | POST | 200 (uma tentativa anterior retornou 403) | Exemplo: `https://s11.mtalk.com.br/backend/messages/641422`. Mensagem enviada: "Mensagem de teste, favor desconsiderar." — apareceu no WhatsApp real do cliente. |
| Criar nota interna do ticket | `/backend/ticket-notes` | POST | 200 | Corpo provável: `{ ticketId, contactId, note }` (mesmos parâmetros usados no GET `ticket-notes/list`). Após o POST, o front dispara automaticamente um GET em `/backend/ticket-notes/list?ticketId=641422&contactId=45078` para atualizar a lista. Nota não é visível ao cliente. |
| Adicionar tag ao ticket | `/backend/tickets/{ticketId}/tags` | POST | 200 | Exemplo: `https://s11.mtalk.com.br/backend/tickets/641422/tags`. Tag de teste usada: "AIA - VILA NOVA" (id `386`). |
| Remover tag do ticket | `/backend/tickets/{ticketId}/tags/{tagId}` | DELETE | 200 | Exemplo: `https://s11.mtalk.com.br/backend/tickets/641422/tags/386`. Usado para remover a tag de teste logo em seguida. |
| Transferir ticket para outra fila | `/backend/tickets/{ticketId}` | PUT | 200 | Exemplo: `https://s11.mtalk.com.br/backend/tickets/641422`. Ticket transferido da fila original para a fila **Suporte-MIX** via o modal "Transfer Ticket" (campo "Transfer to queue"). Corpo provável: `{ queueId, status: "pending", userId: null }` (o ticket some da aba "Assigned" do atendente e passa a aparecer em "Pending" da nova fila). |
| Aceitar ticket pendente de uma fila | `/backend/tickets/{ticketId}` | PUT | 200 | Mesmo endpoint da transferência (`PUT /backend/tickets/{ticketId}`), porém disparado pela opção **"Accept"** do menu do ticket (visível apenas quando o ticket está pendente/sem atendente). Corpo provável: `{ status: "open", userId: <id do atendente> }`. Após o accept, o front refaz automaticamente os GETs de `ticket-notes/list` e `messages/{ticketId}?markAsRead=true` para recarregar a conversa. |

> A tag de teste foi removida imediatamente após a inclusão, a mensagem de teste enviada ao cliente foi identificada como tal no próprio texto ("favor desconsiderar"), e o ticket transferido para Suporte-MIX foi aceito de volta logo em seguida — tudo para minimizar qualquer impacto real no atendimento.

> **Observação sobre a captura de payloads:** a ferramenta de rede usada aqui só expõe `url`, `método` e `status HTTP` das requisições, não o corpo (body) enviado. Os corpos descritos acima como "provável" foram inferidos pelo comportamento da tela (parâmetros já vistos em outros endpoints do mesmo recurso), não confirmados diretamente.

---

## Resumo — endpoints únicos identificados

```
GET /backend/tags/list
GET /backend/users/list
GET /backend/quick-messages/list
GET /backend/settings/allowSilentlyClose
GET /backend/settings/allowSpy
GET /backend/settings/desktopActionIconZoom
GET /backend/settings/tagsMode
GET /backend/settings/CheckMsgIsGroup
GET /backend/tickets?isSearch=&searchParam=&tags=&users=&showAll=&queueIds=
GET /backend/tickets?status=pending&queueIds=
GET /backend/tickets?status=open&showAll=&queueIds=
GET /backend/tickets/u/{uuid}
GET /backend/ticket-notes/list?ticketId={id}&contactId={id}
GET /backend/contacts/{contactId}
GET /backend/messages/{ticketId}?markAsRead=true
GET /backend/chats?pageNumber={n}
GET /backend/public/{arquivo}
GET /nopicture.png

POST   /backend/messages/{ticketId}
POST   /backend/ticket-notes
POST   /backend/tickets/{ticketId}/tags
DELETE /backend/tickets/{ticketId}/tags/{tagId}
PUT    /backend/tickets/{ticketId}          (transferir de fila)
PUT    /backend/tickets/{ticketId}          (aceitar ticket pendente)
```

**Total de requisições capturadas na sessão:** 106 requisições de leitura no carregamento inicial + as requisições de escrita testadas manualmente no ticket do Gabriel Oliveira.

**Limitação:** as ações de escrita testadas cobrem envio de mensagem, criação de nota interna, inclusão/remoção de tag, transferência de ticket entre filas e aceite de ticket pendente. Outras ações de escrita do sistema (fechar/resolver ticket, agendar mensagem, editar dados do contato, deletar nota, retornar ticket para fila anterior, etc.) não foram testadas e portanto seus endpoints não estão documentados aqui.
