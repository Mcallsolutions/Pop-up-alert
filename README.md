# Mcall Ticket Tag Monitor

Extensao Chrome Manifest V3 para monitorar a tela de tickets do MTalk, identificar tickets sem TAG de cliente e enviar snapshots para uma API local. O projeto tambem inclui um painel administrativo para consulta dos relatorios.

## Estrutura

```text
extension/  Extensao Chrome MV3
api/        API Node.js + Express + SQLite
admin/      Painel web React + Vite
docker/     Dockerfiles, compose e Nginx
```

## Rodando localmente

### API

Requisito: Node.js 22.5 ou superior. O projeto usa o SQLite nativo do Node para evitar dependencias com compilacao local.

```bash
cd api
npm install
cp .env.example .env
npm run dev
```

A API roda em `http://localhost:3333`.

Abra `http://localhost:3333` no navegador para usar a interface local da API. Ela permite testar `/health`, login, envio de snapshot de exemplo e relatorios.

Credenciais iniciais do painel, configuradas em `.env.example`:

- Email: `admin@mcall.local`
- Senha: `admin123`

Troque esses valores antes de usar fora de ambiente local.

### Painel administrativo

```bash
cd admin
npm install
npm run dev
```

O painel roda em `http://localhost:5173` e se conecta por padrao a `http://localhost:3333`.

### Extensao Chrome

1. Abra `chrome://extensions`.
2. Ative o modo de desenvolvedor.
3. Clique em "Carregar sem compactacao".
4. Selecione a pasta `extension`.
5. Acesse `https://s11.mtalk.com.br/tickets`.
6. Abra o popup da extensao e confirme a URL da API: `http://localhost:3333`.

## Como funciona a extensao

- O content script roda apenas em `https://s11.mtalk.com.br/tickets*`.
- A cada 1 minuto, e tambem quando a lista muda no DOM, a extensao processa os tickets visiveis.
- A verificacao considera apenas as filas monitoradas: `Suporte-TerraNet`, `Suporte-PLANET`, `Suporte-MIX`, `Suporte-IDEZ`, `Suporte-BDG` e `Suporte-AIA`.
- A funcao `parseTicketsFromDOM()` tenta localizar cards/list items por estrutura, textos, horarios e dimensoes visiveis.
- A funcao `detectClientTag(ticketElement)` procura uma TAG real sem depender de cor fixa ou classe dinamica.
- Tickets sem TAG geram um alerta visual: `Registre a TAG do cliente`.
- O service worker envia o snapshot para `POST /api/tickets/snapshot`.

## Heuristica de TAG

A extensao considera como TAG textos como:

- `PRL - ST PLANALTO`
- `MNI-BETEL`
- `BDG - CIDADE VELHA`
- `AIA - CENTRO`
- `MIX - SETOR SUL`

Ela ignora fila, atendente, empresa/conexao, icones e botoes. A deteccao combina:

- padrao textual com codigo curto + hifen;
- texto em caixa alta ou majoritariamente caixa alta;
- elemento visual pequeno, com padding, fundo, texto claro e aparencia de etiqueta.

## API

Os relatorios da API e do painel admin tambem filtram os dados para as mesmas filas monitoradas. Qualquer ticket recebido fora dessa lista e ignorado no salvamento.

Endpoints publicos:

- `GET /health`
- `POST /api/auth/login`

Endpoints autenticados com JWT:

- `GET /api/auth/me`
- `GET /api/reports/summary`
- `GET /api/reports/missing-tags`
- `GET /api/reports/by-attendant`
- `GET /api/reports/by-queue`

Endpoint da extensao:

- `POST /api/tickets/snapshot`

Se `EXTENSION_TOKEN` estiver preenchido no `.env`, a extensao precisa enviar o mesmo valor no popup/opcoes. O token e enviado no header `x-extension-token`.

## Banco de dados

O ambiente local usa SQLite em `api/data/mcall.sqlite`. As tabelas sao criadas automaticamente a partir de `api/src/database/migrations/001_init.sql`.

Para VPS, o projeto ja separa acesso a dados em servicos e variaveis de ambiente. Para usar PostgreSQL, crie um adaptador em `api/src/database` mantendo os contratos usados por `ticket.service.js` e `report.service.js`, depois ajuste `DATABASE_CLIENT=postgres` e `DATABASE_URL`.

## Docker

Na raiz do projeto:

```bash
docker compose -f docker/docker-compose.yml up -d
```

Servicos:

- API: `http://localhost:3333`
- Admin: `http://localhost:8080`

Antes de publicar em VPS:

1. Use HTTPS no proxy reverso.
2. Troque `JWT_SECRET`, `ADMIN_PASSWORD` e `EXTENSION_TOKEN`.
3. Configure `CORS_ORIGINS` com o dominio real do painel.
4. Atualize a URL da API no popup/opcoes da extensao para `https://api.dominio.com.br`.
5. Ajuste `host_permissions` no `extension/manifest.json` se o dominio final for diferente.

## Seguranca e LGPD

O projeto coleta apenas dados necessarios para o relatorio de TAG: cliente, fila, atendente, conexao, horario, TAG/status, URL e data de leitura. Ele nao captura senhas, cookies ou mensagens completas. O painel usa JWT, a API aplica rate limit, valida payloads e evita logar dados sensiveis.
