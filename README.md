# Mcall Ticket Tag Monitor

Extensao Chrome Manifest V3 para monitorar a tela de tickets do MTalk, identificar tickets sem TAG de cliente e enviar snapshots para uma API. O projeto tambem inclui um painel administrativo para consulta dos relatorios.

## Estrutura

```text
api/            Entrypoint da Serverless Function da Vercel (um unico arquivo)
server/         Codigo da API Node.js + Express (PostgreSQL)
admin/          Codigo-fonte do painel web React + Vite
extension/      Extensao Chrome MV3
package.json    Dependencias unicas do projeto (API + painel)
vite.config.js  Build do painel (root em admin/, saida em dist/)
vercel.json     Rotas e build do projeto unico na Vercel
```

O projeto e um monorepo com **um unico `package.json` na raiz**. Nao existem mais `package.json` dentro de `api/`, `server/` ou `admin/`.

## Como o deploy na Vercel funciona

Um unico projeto Vercel publica tudo no mesmo dominio:

| Caminho | O que responde |
| --- | --- |
| `/` | Painel admin (arquivos estaticos gerados em `dist/`) |
| `/api/*` | API Express, via Serverless Function `api/index.js` |
| `/health` | Healthcheck da API |

Como painel e API dividem a mesma origem, **nao ha CORS entre eles** e o painel chama a API por caminho relativo.

A pasta `api/` contem apenas `index.js` de proposito: a Vercel transforma cada arquivo dessa pasta em uma function separada, e o plano Hobby permite no maximo 12. Por isso o codigo da API vive em `server/`.

## Rodando localmente

Requisitos: Node.js 22.5 ou superior e um PostgreSQL acessivel (a mesma URL usada em producao serve, ou um banco local).

```bash
npm install
cp .env.example .env
# preencha DATABASE_URL no .env antes de subir
npm run dev
```

Isso sobe as duas coisas ao mesmo tempo:

- API em `http://localhost:3333`
- Painel em `http://localhost:5173` (o Vite faz proxy de `/api` e `/health` para a API)

Para rodar separado:

```bash
npm run dev:api     # so a API
npm run dev:admin   # so o painel
npm run build       # build de producao do painel em dist/
npm start           # API em modo producao
npm run migrate     # roda as migrations e cria o admin inicial
```

Credenciais iniciais do painel, configuradas em `.env.example`:

- Email: `admin@mcall.local`
- Senha: `admin123`

Troque esses valores antes de usar fora de ambiente local.

## Deploy na Vercel

### 1. Banco de dados

A API so fala PostgreSQL — o disco da Vercel e efemero, entao nao existe banco em arquivo. Sem `DATABASE_URL`/`POSTGRES_URL` a API sobe e responde `/health` com `degradado`, e as rotas de dados devolvem 503 com a mensagem explicando o que falta.

Na Vercel, va em **Storage -> Create Database -> Postgres (Neon)** e conecte ao projeto. As variaveis `POSTGRES_URL` e `DATABASE_URL` sao injetadas automaticamente e a API passa a usar PostgreSQL sozinha, sem precisar definir `DATABASE_CLIENT`. As migrations rodam na primeira requisicao apos o deploy.

Se preferir um Postgres externo (Supabase, Railway, etc.), defina manualmente:

```env
DATABASE_URL=postgresql://usuario:senha@host:5432/banco?sslmode=require
```

### 2. Criar o projeto

- **Import Git Repository** apontando para este repositorio
- **Root Directory**: `.` (a raiz, nao `api` nem `admin`)
- **Framework Preset**: Other
- Build Command, Output Directory e Install Command ja vem do `vercel.json` — nao precisa preencher nada

### 3. Variaveis de ambiente

Copie de `.env.vercel.example`:

```env
NODE_ENV=production
JWT_SECRET=troque-por-um-segredo-longo-e-aleatorio
JWT_EXPIRES_IN=12h
ADMIN_EMAIL=admin@seudominio.com.br
ADMIN_NAME=Administrador
ADMIN_PASSWORD=troque-por-uma-senha-forte
EXTENSION_TOKEN=troque-por-um-token-longo-e-aleatorio
CORS_ORIGINS=chrome-extension://ID_DA_EXTENSAO
OPENAI_API_KEY=sk-troque-pela-chave-real
OPENAI_MODEL=gpt-4o-mini
```

Observacoes:

- Nao defina `VITE_API_URL`. Vazio faz o painel usar a propria origem.
- `OPENAI_API_KEY` e opcional: sem ela o painel funciona normalmente e apenas a aba **IA** fica sem gerar resumos. A chave e usada **so no servidor** — o navegador nunca a recebe.
- `CORS_ORIGINS` so precisa liberar a extensao. Troque `ID_DA_EXTENSAO` pelo ID real mostrado em `chrome://extensions`.
- A API sempre libera requisicoes de **mesma origem**, entao o painel funciona mesmo com `CORS_ORIGINS` vazio. Os dominios da Vercel (`VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`) tambem entram na lista automaticamente, incluindo os deploy previews.
- Barra final e maiusculas em `CORS_ORIGINS` sao ignoradas: `https://exemplo.vercel.app/` e `https://exemplo.vercel.app` valem a mesma coisa.

Se o login retornar `Origem nao permitida pelo CORS: <origem>`, a mensagem mostra exatamente qual valor precisa entrar em `CORS_ORIGINS`.

### 4. Depois do deploy

1. Abra `https://seu-projeto.vercel.app/health` e confirme `{"status":"ok"}`.
2. Faca login no painel em `https://seu-projeto.vercel.app`.
3. Ajuste `host_permissions` em `extension/manifest.json` se o dominio final for outro.
4. No popup/opcoes da extensao, configure a URL da API como `https://seu-projeto.vercel.app` e o mesmo `EXTENSION_TOKEN`.

### Diagnostico

Dois endpoints publicos ajudam a investigar um deploy:

- `GET /health` — status da API e do banco
- `GET /api` — as rotas que aquele deploy realmente publica

### O painel nao atualiza mesmo com a extensao lendo tickets

A leitura dos tickets acontece no DOM e funciona mesmo sem API. Se o painel nao mostra nada,
o snapshot nao chegou — quase sempre por token.

O campo **Token da extensao** no popup precisa ter exatamente o mesmo valor de
`EXTENSION_TOKEN`. Vazio ou diferente faz todo `POST /api/tickets/snapshot` voltar 401,
silenciosamente, porque a leitura continua funcionando normalmente.

Use o botao **Testar API** no popup: ele consulta `/health` e tambem faz `POST /api/tickets/ping`,
que passa pela mesma validacao de token do snapshot. Se o ping passar, o envio real tambem passa.

`/api/tickets/ping` nao toca no banco, entao responde mesmo com o Postgres fora do ar.

### "Rota nao encontrada" no botao Testar API

Significa que a URL configurada na extensao aponta para um endereco que a API nao serve.
Verifique, nesta ordem:

1. A URL da API no popup deve ser so a origem (`https://seu-projeto.vercel.app`), **sem** `/api` no final.
2. O deploy na Vercel precisa estar atualizado — `/api/tickets/ping` so existe a partir desta versao.
   Enquanto o deploy antigo estiver no ar, o popup mostra "API conectada" avisando que o token nao pode ser conferido.
3. `GET /api` lista todas as rotas que aquele deploy realmente publica.

### Limitacoes do ambiente serverless

- O rate limit em memoria vale por instancia, nao globalmente. Para limite real e compartilhado, use Vercel KV/Redis ou o WAF da Vercel.
- Cada cold start abre uma conexao nova com o Postgres (`pool.max = 1`). Use sempre a URL **pooled** do banco.

## Extensao Chrome

1. Abra `chrome://extensions`.
2. Ative o modo de desenvolvedor.
3. Clique em "Carregar sem compactacao".
4. Selecione a pasta `extension`.
5. Acesse `https://s11.mtalk.com.br/tickets`.
6. Abra o popup da extensao e confirme a URL da API.

### Como funciona

- O content script roda apenas em `https://s11.mtalk.com.br/tickets*`.
- A cada 1 minuto, e tambem quando a lista muda no DOM, a extensao processa os tickets visiveis.
- A verificacao considera apenas as filas monitoradas: `Suporte-TerraNet`, `Suporte-PLANET`, `Suporte-MIX`, `Suporte-IDEZ`, `Suporte-BDG` e `Suporte-AIA`.
- A funcao `parseTicketsFromDOM()` tenta localizar cards/list items por estrutura, textos, horarios e dimensoes visiveis.
- A funcao `detectClientTag(ticketElement)` procura uma TAG real sem depender de cor fixa ou classe dinamica.
- Tickets sem TAG geram um alerta visual: `Registre a TAG do cliente`.
- O service worker envia o snapshot para `POST /api/tickets/snapshot`.

### Heuristica de TAG

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

Os relatorios da API e do painel admin filtram os dados para as mesmas filas monitoradas. Qualquer ticket recebido fora dessa lista e ignorado no salvamento.

Endpoints publicos:

- `GET /health`
- `GET /api` (catalogo)
- `POST /api/auth/login`

Endpoints autenticados com JWT:

- `GET /api/auth/me`
- `GET /api/reports/summary`
- `GET /api/reports/filters` (valores disponiveis para os filtros do painel)
- `GET /api/reports/missing-tags`
- `GET /api/reports/by-attendant`
- `GET /api/reports/by-queue`
- `GET /api/reports/inactivity/summary`
- `GET /api/reports/inactivity/tickets`
- `GET /api/reports/inactivity/by-attendant`
- `GET /api/reports/inactivity/by-company`
- `GET /api/ai/status`
- `GET /api/ai/prompts` / `POST /api/ai/prompts` / `PUT /api/ai/prompts/:id` / `DELETE /api/ai/prompts/:id`
- `POST /api/ai/summary` (gera um resumo novo chamando a OpenAI)
- `GET /api/ai/summary/latest`
- `GET /api/ai/summaries?limit=10`

Todos os endpoints de `/api/reports` aceitam os mesmos filtros por query string:
`day`, `startDate`, `endDate`, `attendant`, `company`, `queue`, `clientName` e `limit`.
A busca por texto e parcial e ignora maiusculas; `attendant` tambem casa com as variacoes
do nome gravadas pelo MTalk (`Alek`, `Alek NETFIBRA`, ... todas caem em `Aleksandro`).

As listas de tickets (`missing-tags` e `inactivity/tickets`) so retornam registros em que
o **cliente** foi identificado. Linhas em que a leitura reconheceu apenas a fila nao viram
linhas vazias na tabela: elas sao contadas em `incompletosOcultos` na resposta de
`missing-tags`, e o painel mostra esse numero abaixo dos filtros.

Atendente e empresa nao entram nessa exigencia de proposito: na tela do MTalk os dois sao
alternativos (a coluna mostra um ou o outro), entao exigir ambos esvaziaria a lista.

Endpoints da extensao:

- `POST /api/tickets/ping` (testa conectividade e token, nao usa o banco)
- `POST /api/tickets/snapshot`

Se `EXTENSION_TOKEN` estiver preenchido, a extensao precisa enviar o mesmo valor no header `x-extension-token`.

## Aba IA (OpenAI)

O painel tem uma aba **IA** com tres partes:

1. **Prompts e treinamentos** — cadastro de instrucoes (`INSTRUCAO`, regra fixa que a IA segue) e exemplos (`TREINAMENTO`, referencia de estilo/criterio). Tudo que estiver **ativo** e enviado junto com os dados a cada resumo; itens inativos ficam guardados sem entrar no prompt.
2. **Resumo da IA** — os filtros da barra definem o recorte enviado ao modelo. O botao "Gerar resumo com IA" monta o contexto com os mesmos relatorios que o painel exibe (totais, tickets sem TAG, inatividade, quebras por atendente e fila) e chama a OpenAI.
3. **Historico** — cada resumo fica salvo com modelo, tokens, filtros e responsavel. O ultimo resumo tambem aparece como um card no Dashboard.

A resposta e sempre pedida em JSON (`response_format: json_object`) no formato:

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

Variaveis de ambiente: `OPENAI_API_KEY` (obrigatoria para gerar), `OPENAI_MODEL` (padrao `gpt-4o-mini`), e as opcionais `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_TIMEOUT_MS` (mantenha abaixo do `maxDuration` de 30s do `vercel.json`).

## Horarios no painel

As tabelas de tickets mostram o **horario do ticket** (o que aparece na tela do MTalk), e nao o horario da coleta. A data e composta no navegador: dia da leitura + hora do ticket; se a hora do ticket for maior que a da coleta, o registro e do dia anterior. O horario da coleta continua visivel apenas nos indicadores "Ultima atualizacao" e "Ultima coleta", que descrevem a leitura em si.

## Banco de dados

PostgreSQL em qualquer ambiente. As migrations ficam em `server/src/database/index.js` (constante `MIGRATIONS`) e rodam sozinhas na primeira conexao apos o deploy, controladas pela tabela `schema_migrations`. Para adicionar uma, crie uma nova chave no objeto — nunca edite uma que ja rodou.

## Seguranca e LGPD

O projeto coleta apenas dados necessarios para o relatorio de TAG: cliente, fila, atendente, conexao, horario, TAG/status, URL e data de leitura. Ele nao captura senhas, cookies ou mensagens completas. O painel usa JWT, a API aplica rate limit, valida payloads e evita logar dados sensiveis.

Atencao ao usar a aba **IA**: gerar um resumo envia para a OpenAI o recorte de dados filtrado, incluindo nomes de clientes, atendentes e empresas. Use os filtros para limitar o recorte e confirme que esse envio a um provedor externo esta previsto na politica de privacidade da operacao.
