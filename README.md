# Mcall Ticket Tag Monitor

Monitor de TAG e de inatividade dos tickets do MTalk. O servidor le os tickets **somente pela API oficial do MTalk**, grava os snapshots em um banco local e alimenta:

- um **painel web** com relatorios, inatividade e resumos de IA;
- uma **extensao Chrome** que mostra o pop-up de alertas na tela de tickets do MTalk;
- opcionalmente, a **analise de atendimento por IA**, que le as conversas com os dados pessoais mascarados. Ela vem
  **desligada** — veja [Analise de atendimento (IA)](#analise-de-atendimento-ia).

O **painel** e de administracao e entra com **usuario e senha** — veja [Login do painel](#login-do-painel). A
**extensao** identifica cada atendente por um **token por pessoa**: cada um recebe os proprios alertas (e todos os
tickets sem atendente) — veja [Tokens da extensao](#tokens-da-extensao-quem-ve-o-que).

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
npm run admin       # cria usuarios do painel e troca senhas
npm run token       # emite, lista e revoga os tokens da extensao
npm test            # testes (node:test): mascaramento, metricas, mensagens e integracao com MTalk/OpenAI falsos
```

### Credenciais do MTalk

A autenticacao e por **URL + token**:

- `MTALK_BASE_URL` — backend da instancia, terminando em `/backend` (ex.: `https://s11.mtalk.com.br/backend`);
- `MTALK_TOKEN` — token Bearer de um usuario de **perfil admin** do MTalk. So o admin tem o `showAll` atendido: com
  usuario comum o MTalk ignora o parametro, sem erro, e a coleta passa a ver apenas os tickets abertos do proprio dono
  do token. Pode ser colado cru, com `Bearer ` na frente ou entre aspas.

O servidor nao faz login nem renova o token. Quando o MTalk recusar (token expirado ou revogado), a coleta falha e o erro aparece no painel e no popup da extensao: gere um novo token, atualize o `.env` e reinicie a API. O token fica **so no `.env`**, que nao vai para o git — este repositorio e publico.

Sem token a API sobe normalmente, mas a coleta automatica fica desligada e o log avisa. Detalhes em [`Mtalk integration/README.md`](Mtalk%20integration/README.md).

Para conferir: **Configuracoes** no painel mostra se o token foi aceito, a ultima coleta e o botao **Coletar agora**.

## Login do painel

O painel e so de administracao: quem entra ve a operacao inteira, a aba IA, o diagnostico da coleta e emite os
tokens da extensao. O acesso e por **usuario e senha**; token nenhum abre o painel.

Os usuarios sao criados pela linha de comando — nao ha cadastro pela web, entao um painel recem-publicado nao tem como
ser "reivindicado" por quem chegar primeiro. **Sem nenhum usuario, o painel nao abre.**

```bash
npm run admin -- criar --login supervisao --nome "Supervisao"   # pede a senha no terminal
npm run admin -- senha --login supervisao                        # troca a senha e derruba as sessoes abertas
npm run admin -- desativar --login supervisao                    # bloqueia e derruba as sessoes
npm run admin -- ativar --login supervisao
npm run admin -- listar
```

A senha e pedida sem eco, para nao ficar no historico do shell (`--senha "<valor>"` existe para automacao) e precisa
de pelo menos 8 caracteres. O banco guarda so o hash scrypt dela, com sal proprio.

O login devolve uma **sessao** que vale `ADMIN_SESSION_HOURS` horas (padrao 12) e fica no `localStorage` daquele
navegador; "Sair" encerra a sessao no servidor. Sessao vencida, senha trocada ou usuario desativado levam de volta para
a tela de login na proxima chamada. Senhas erradas sao limitadas a 10 por IP a cada 15 minutos.

## Tokens da extensao (quem ve o que)

Cada atendente tem o **seu** token, usado **so pela extensao**. Ele nao tem nada a ver com o `MTALK_TOKEN`: a coleta
continua sendo uma so, com um token unico do MTalk, e o token da pessoa apenas **recorta os alertas** que chegam no
pop-up dela.

| Perfil | Recebe |
| --- | --- |
| `ATENDENTE` | os alertas dos tickets dele **mais todos os tickets sem atendente** |
| `ADMIN` (supervisao) | os alertas de todos |

Um token, mesmo de perfil `ADMIN`, **nao abre o painel**.

Ticket **sem atendente aparece para todo mundo** de proposito: ninguem e dono dele, e cliente esquecido na fila e
justamente o que nao pode passar despercebido.

O recorte olha a **situacao atual** do ticket. Um ticket que a Stephanie atendeu de manha e que agora esta com outra
pessoa sai da tela dela — nao e o caso de ela continuar sendo cobrada por ele.

### Emitindo tokens

```bash
npm run token -- criar --nome "Stephanie - notebook" --atendente "Stephanie"
npm run token -- criar --nome "Supervisao" --admin
npm run token -- listar
npm run token -- revogar --id 3
```

O token aparece **uma unica vez**, na criacao — o banco guarda so o SHA-256 dele. Perdeu, revoga e emite outro.
Revogar vale na hora. Tambem da para emitir e revogar pelo painel, em **Configuracoes > Tokens da extensao**.

O `--atendente` e o nome como aparece no MTalk; as variacoes conhecidas sao unificadas sozinhas (`Alek NETFIBRA` vira
`Aleksandro`), a mesma tabela que os relatorios usam.

### Modo aberto

O modo aberto e **so para desenvolvimento**. Com `EXTENSION_OPEN_MODE=1` no `.env` e nenhum token ativo, as rotas da
extensao (`/api/mtalk`) ficam abertas e todo mundo recebe todos os alertas — assim um clone novo sobe com
`npm run dev` sem passo extra (o `.env.example` ja traz a variavel ligada). **Criar o primeiro token liga a
exigencia** para todas as extensoes.

**Sem a variavel — como na VPS —, nao existe modo aberto**: sem nenhum token ativo, toda chamada da extensao recebe
`401`, e a API avisa no log ao subir. Revogar o ultimo token, portanto, nunca abre os alertas para a internet. O modo
aberto nunca vale para o painel, que sempre pede login.

### Onde o atendente cola o token

Campo **Seu token de acesso**, no popup ou nas opcoes da extensao. O popup mostra em **Alertas de** de quem e o
recorte que esta chegando — a forma mais rapida de conferir que o token certo foi colado.

## Extensao Chrome

A extensao **nao le a pagina nem a sessao do MTalk** e nao chama a API dele: so busca os alertas ja calculados no servidor local e desenha o pop-up.

1. Com a API rodando, abra `chrome://extensions`.
2. Ative o modo de desenvolvedor.
3. Clique em "Carregar sem compactacao" e selecione a pasta `extension`.
4. Abra o popup da extensao e cole **o token daquela pessoa**.
5. Acesse `https://s11.mtalk.com.br/tickets`.

### Compartilhar a extensao

Quem nao tem o repositorio na maquina baixa a extensao pelo proprio painel: **Configuracoes > Extensao do Chrome >
Baixar extensao (.zip)**. O botao chama `GET /api/extension/download`, que compacta a pasta `extension` do servidor na
hora (so com login no painel). O zip traz uma pasta so, para
descompactar e apontar o "Carregar sem compactacao" nela, e **nao leva token nem `.env` dentro**: cada pessoa cola o
seu token depois de instalar.

A URL da API vem como `http://localhost:3333`; troque no popup ou nas opcoes da extensao se precisar. O token fica no
`chrome.storage.local` daquele perfil do Chrome, entao cada atendente cola o seu uma vez.

Como funciona:

- a cada 1 minuto o content script pede `GET /api/mtalk/alerts` com o token da pessoa (a chamada sai do service worker, porque a pagina https do MTalk nao pode chamar `http://localhost`), e recebe so os alertas do recorte dela;
- **Registre a TAG do cliente** lista tickets sem TAG com atendente vinculado; **Alerta de inatividade** lista tickets parados ha mais de 15 minutos, com ou sem atendente;
- clicar no item abre o ticket (`/tickets/<uuid>`); fechar o pop-up silencia por 5 minutos;
- quando um cliente **com atendente vinculado** passa do limite de inatividade, toca um **bip** curto e baixo, uma vez
  por cliente (se ele for respondido e parar de novo, toca de novo). Ticket aguardando sem atendente nao toca. Com
  varias abas do MTalk abertas o bip toca numa so; durante o silencio de 5 minutos ele espera e toca quando o pop-up
  volta. Quem ja estava parado quando o MTalk foi aberto aparece no pop-up, sem bip. O Chrome so libera som depois do
  primeiro clique ou tecla na pagina. Da para desligar no popup ou nas opcoes da extensao;
- sem coleta recente no servidor (API fora do ar, token do MTalk recusado) o pop-up some, em vez de mostrar alerta velho;
- no popup, **Coletar agora** pede uma coleta imediata (com token de atendente, se a ultima terminou ha menos de 30 s,
  ela e reaproveitada) e **Testar API** confere a API local e o token do MTalk.

## Hospedando numa VPS (Ubuntu)

O passo a passo completo, da maquina recem-criada ate o painel no ar, esta em **[deploy/VPS.md](deploy/VPS.md)**.
Os arquivos de exemplo ficam na mesma pasta: `tag-monitor.service` (systemd), `nginx.conf`,
`.env.production.example` e `atualizar.sh`. O desenho e **systemd rodando o Node + nginx na frente**: uma app Node
so, com o banco em arquivo, nao ganha nada com Docker — o container so acrescentaria a dor de cuidar do volume do
SQLite.

Os caminhos da VPS levam o nome do projeto: codigo em `/opt/tag-monitor`, banco em `/var/lib/tag-monitor`, servico e
usuario `tag-monitor`. Quem subiu antes, quando esses caminhos eram `mcall`, tem a troca passo a passo em
[Migrando uma VPS que ainda usa os caminhos `mcall`](deploy/VPS.md#migrando-uma-vps-que-ainda-usa-os-caminhos-mcall).

O dominio da operacao e `tag-monitor.mcallsolutions.com.br`. Ele aparece em tres lugares que precisam combinar: o
`server_name` do nginx, o `CORS_ORIGINS` do `.env` e o `host_permissions` do `manifest.json` da extensao. Os
enderecos antigos (`gestao...` e o acentuado `xn--gesto-dra...`) sao tratados como legado: a extensao troca sozinha
quem ainda tiver um deles salvo.

1. **DNS**: registro `A` de `tag-monitor.mcallsolutions.com.br` apontando para o IP da VPS.
2. **Node 24**: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -` e `sudo apt install -y nodejs`.
   O banco usa `node:sqlite`, que so existe a partir do Node 22.5 e so e estavel no 24.
3. **Codigo**: clone em `/opt/tag-monitor`, com um usuario de servico proprio
   (`sudo useradd --system --create-home tag-monitor`). O banco fica fora da pasta do deploy:
   `sudo install -d -o tag-monitor -g tag-monitor /var/lib/tag-monitor`.
4. **.env**: copie `deploy/.env.production.example` para `/opt/tag-monitor/.env`, preencha `MTALK_TOKEN` e
   `OPENAI_API_KEY` e feche o arquivo (`chmod 600`).
5. **Build**: `npm ci` (completo — o build do painel usa as devDependencies) e `npm run build`.
6. **systemd**: copie `deploy/tag-monitor.service` para `/etc/systemd/system/`, `daemon-reload` e
   `enable --now tag-monitor`.
7. **nginx + TLS**: copie `deploy/nginx.conf` para `/etc/nginx/sites-available/tag-monitor`, ative o link e rode
   `sudo certbot --nginx -d tag-monitor.mcallsolutions.com.br`.
8. **Firewall**: `sudo ufw allow 22,80,443/tcp && sudo ufw enable`. A porta 3333 nunca e liberada — com
   `HOST=127.0.0.1` ela so existe para o nginx.
9. **Antes de abrir o dominio**: crie o seu usuario do painel (`npm run admin -- criar ...`) e emita os tokens da
   extensao — enquanto nao houver token, a extensao de todo mundo recebe `401`. Na VPS nao existe
   [modo aberto](#modo-aberto): nunca coloque `EXTENSION_OPEN_MODE` no `.env` de producao.

Depois disso, atualizar e `./deploy/atualizar.sh` (git pull, build e restart).

### O que muda em relacao ao ambiente local

| Variavel | Local | VPS |
| --- | --- | --- |
| `HOST` | `0.0.0.0` (a extensao de cada maquina alcanca a API) | `127.0.0.1` (so o nginx) |
| `TRUST_PROXY` | `0` | `1` — sem isso o rate limit conta todo mundo como o nginx |
| `SERVE_ADMIN` | `1` (a API serve `/dist` se ele existir) | `0` — quem serve os estaticos e o nginx |
| `SQLITE_PATH` | `server/data/monitor.sqlite` | `/var/lib/tag-monitor/monitor.sqlite` |
| `CORS_ORIGINS` | padrao (localhost + extensao) | `https://tag-monitor.mcallsolutions.com.br,chrome-extension://` |

Na extensao, o `manifest.json` precisa do dominio em `host_permissions` — sem isso o service worker nao consegue
chamar a API — e o `apiBaseUrl` padrao ja aponta para ele. Quem usar a API local troca a URL no popup.

### Backup

O banco e o historico inteiro de coletas. Nunca copie o arquivo com a API rodando (o WAL fica de fora); use o
`.backup` do proprio SQLite num cron diario:

```bash
sqlite3 /var/lib/tag-monitor/monitor.sqlite ".backup /var/backups/tag-monitor-$(date +%F).sqlite"
```

## API

Fora `GET /health` e `POST /api/auth/login`, todo endpoint exige o cabecalho `Authorization: Bearer <valor>`, com
uma de duas credenciais:

- **sessao do painel** (`mcs_...`, devolvida pelo login): abre tudo;
- **token da extensao** (`mca_...`): abre so `/api/mtalk/*` e `/api/auth/me`, e `/api/mtalk/alerts` responde
  **recortado** pelo token. Sem nenhum token ativo, essas rotas so ficam abertas com `EXTENSION_OPEN_MODE=1`
  ([modo aberto](#modo-aberto)); sem a variavel, respondem `401`.

Quando o MTalk recusa o `MTALK_TOKEN`, a API responde `502`, e nao `401`: `401` e sempre sobre a credencial de quem
chamou (sessao do painel ou token da extensao).

Sem credencial valida a resposta e `401` — inclusive token da extensao em rota do painel.

Acesso:

- `POST /api/auth/login` — `{ username, password }` → `{ session, expiresAt, user }`
- `POST /api/auth/logout` — encerra a sessao enviada no cabecalho
- `GET /api/auth/session` — quem esta logado no painel
- `GET /api/auth/me` — para a extensao: de quem e o token, qual o recorte e se a API exige token
- `GET /api/auth/tokens` / `POST /api/auth/tokens` / `DELETE /api/auth/tokens/:id` (painel)

Coleta e alertas:

- `GET /api/mtalk/alerts` — alertas da ultima coleta, no formato do pop-up. `inactive.items` traz no maximo 6
  tickets; `inactive.assignedTicketIds` traz os ids de **todos** os inativos com atendente, que a extensao usa para o bip
- `GET /api/mtalk/status` — estado do token do MTalk, agendamento e ultima coleta (sem expor o token)
- `POST /api/mtalk/collect` — coleta agora; `?dryRun=1` le a API e nao grava. Com token de atendente nao ha `dryRun`
  nem diagnostico: a resposta traz so os totais do recorte dele, e uma coleta que terminou ha menos de 30 s e
  reaproveitada em vez de chamar o MTalk de novo

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

IA (so ADMIN):

- `GET /api/ai/status`
- `GET /api/ai/prompts` / `POST /api/ai/prompts` / `PUT /api/ai/prompts/:id` / `DELETE /api/ai/prompts/:id`
- `POST /api/ai/summary` (gera um resumo novo chamando a OpenAI)
- `GET /api/ai/summary/latest`
- `GET /api/ai/summaries?limit=10`

Analise de atendimento (so painel; o token da extensao recebe `401` mesmo com perfil ADMIN):

- `GET /api/attendance/status` — se esta ligada, orcamento usado na hora, mensagens no banco, ultima leitura e erro
- `GET /api/attendance/analyses` — lista com os totais dos cards; filtros `day`, `startDate`, `endDate`,
  `attendant`, `queue`, `company`, `clientName`, `riscoCancelamento`, `sentimentoCliente`, `notaMax` e `limit`
- `GET /api/attendance/analyses/:id` — a analise mais a transcricao **mascarada** da janela, com as evidencias marcadas
- `GET /api/attendance/by-attendant` — nota media, % de sentimento negativo, 1a resposta media, riscos altos e orgao externo
- `POST /api/attendance/tickets/:ticketId/analyze` — analise manual (le as mensagens do ticket antes). Com a
  analise desligada responde `403`

Diagnostico: `GET /health` (status da API e do banco).

Os endpoints de `/api/reports` aceitam os filtros `day`, `startDate`, `endDate`, `attendant`, `company`, `queue`, `clientName` e `limit`. A busca por texto e parcial; `attendant` tambem casa com o nome canonico (`Alek` encontra `Aleksandro`). Data impossivel (ex.: `2026-09-31`) responde `400`. Os relatorios consideram apenas as filas monitoradas e uma leitura por ticket: os de TAG usam a **mais recente**; os de inatividade (e o `totalInactive` do `summary`), a de **maior parada no periodo** — quem ficou 50 min parado de manha e depois foi atendido continua no relatorio do dia, com o atendente que estava com o ticket naquela hora.

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

1. **Prompts e treinamentos** — instrucoes (`INSTRUCAO`) e exemplos (`TREINAMENTO`), cada um com o seu **uso**
   (`scope`): `RESUMO` (o resumo gerencial desta aba, como sempre foi) ou `ATENDIMENTO` (a
   [analise de cada conversa](#analise-de-atendimento-ia)). Tudo que estiver **ativo** vai junto com os dados, e cada
   uso so recebe os seus. Os prompts ja cadastrados ficaram como `RESUMO`.
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

## Analise de atendimento (IA)

Avalia cada conversa de atendimento: le as mensagens dos tickets pela API do MTalk, **mascara os dados pessoais antes
de gravar**, calcula os tempos de resposta em codigo e pede a OpenAI uma avaliacao estruturada (resumo, assunto,
sentimento do cliente, risco de cancelamento, orgao externo citado, resolvido, nota de 1 a 5, pontos positivos e de
melhoria, alertas e as mensagens que servem de evidencia). O resultado aparece na pagina **Atendimento IA** do painel,
com filtros, cards, tabela por atendente, transcricao mascarada e exportacao em PDF/DOCX.

### Como ligar

Vem **desligada**. Com `AI_ATTENDANCE_ANALYSIS=0` (padrao) o sistema faz exatamente o que fazia antes: nenhuma
chamada a `/messages` e nenhuma tabela nova preenchida. Para ligar, antes de tudo passe pelo
[checklist de validacao](Mtalk%20integration/README.md#checklist-antes-de-ligar-a-analise-de-atendimento) com um
ticket de teste; depois:

```bash
# no .env
AI_ATTENDANCE_ANALYSIS=1
OPENAI_API_KEY=...
```

e reinicie a API. **Configuracoes** mostra se esta ligada, o orcamento usado na hora e a ultima leitura.

| Variavel | Padrao | Para que |
| --- | --- | --- |
| `AI_ATTENDANCE_ANALYSIS` | `0` | `1` liga a leitura das mensagens e a analise |
| `MTALK_MAX_MESSAGE_FETCHES` | `20` | teto de `GET /messages/{ticketId}` por coleta (`0` para de ler mensagens novas) |
| `MESSAGE_RETENTION_DAYS` | `30` | dias que as mensagens mascaradas ficam no banco (`0` nao desliga: vale o padrao) |
| `AI_ANALYSIS_IDLE_MINUTES` | `20` | minutos de conversa parada para ela entrar na fila (ticket fechado entra na hora) |
| `AI_ANALYSIS_MIN_MESSAGES` | `4` | minimo de mensagens novas, com 1+ do cliente e 1+ humana da empresa |
| `AI_ANALYSIS_MAX_MESSAGES` | `80` | maximo de mensagens por analise; passando disso ficam as mais recentes (`truncada`) |
| `AI_ANALYSIS_MAX_PER_HOUR` | `30` | teto de chamadas a OpenAI por hora (`0` pausa a analise automatica) |
| `AI_ANALYSIS_MODEL` | vazio | modelo so desta analise; vazio usa `OPENAI_MODEL` |

### Como funciona

1. **Leitura incremental**, depois de cada coleta gravada e fora do caminho dos alertas (a coleta nao espera; uma
   falha aqui nunca derruba a coleta). Primeiro os tickets que sairam de `open`/`pending` (uma busca final, para pegar
   a despedida), depois os que mudaram, do mais antigo para o mais novo. Com cursor, pede so o que mudou
   (`minUpdatedAt`). **Nunca** manda `markAsRead`.
2. **Mascaramento na entrada** (`server/src/services/pii-mask.js`): o texto original nunca e gravado, nem em log.
3. **Metricas em codigo** (`attendance-metrics.js`): 1a resposta, tempo medio de resposta, maior espera do cliente
   (contada do INICIO de cada bloco de mensagens dele ate a proxima resposta humana; mensagem automatica nao conta),
   espera da empresa pelo cliente, duracao e transferencia. Alertas do sistema: `CLIENTE_AGUARDANDO` (espera acima de
   `INACTIVITY_THRESHOLD_MINUTES`), `CANCELAMENTO` e `ORGAO_EXTERNO` (palavras do cliente, sem IA).
4. **Analise**: automatica no maximo a cada 5 minutos, para conversa com mensagem nova desde a ultima analise e
   parada ha `AI_ANALYSIS_IDLE_MINUTES` (ou ticket fechado); ou manual, pelo botao **Analisar de novo**.

Quem escreveu cada mensagem: `CLIENTE` (`fromMe=false`), `ATENDENTE` (com assinatura `*Nome:*` ou `userId`),
`AUTOMATICA` (a empresa escreveu enquanto o ticket estava sem atendente: bot, fila, saudacao) e `EMPRESA` (a empresa
escreveu, mas nao da para saber se foi pessoa ou automatico — a IA e avisada). O atendente de cada mensagem vem da
leitura de tickets mais proxima **antes** dela: uma transferencia nao joga a conversa inteira em quem pegou depois.

### O que vai para a OpenAI

Por minimizacao, so a fila, as metricas e as mensagens mascaradas, com ids curtos (`m1`, `m2`...) e minutos desde a
primeira mensagem. **Nao vai** nome de cliente, de atendente ou de empresa, nem horario absoluto. Logo antes do envio,
`assertNoPii()` confere o payload inteiro: se sobrar qualquer dado pessoal, **nada e enviado**, a analise fica
`BLOQUEADA` e o registro guarda so o tipo e a quantidade. Os textos que a IA devolve passam pelo mascaramento de novo
antes de gravar, e evidencia citada com id fora da conversa e descartada.

### Marcadores

| Marcador | O que substitui |
| --- | --- |
| `[CPF]`, `[CNPJ]` (inclusive o alfanumerico), `[RG]`, `[DATA_NASCIMENTO]` | documentos e nascimento |
| `[ENDERECO]`, `[CEP]`, `[LOCALIZACAO]` | logradouro, numero, complemento e bairro; CEP; mapa e coordenadas (cidade e estado ficam) |
| `[TELEFONE]`, `[EMAIL]` | contato |
| `[CARTAO]`, `[CONTA_BANCARIA]`, `[CHAVE_PIX]` | dados financeiros |
| `[SENHA]` | senha, login e PPPoE |
| `[IP]`, `[EQUIPAMENTO]` | IP publico e IPv6; MAC e serial de ONU (IP privado como `192.168.0.1` fica) |
| `[CLIENTE]`, `[ATENDENTE]` | nome do contato e dos atendentes |
| `[NUMERO]` | qualquer sequencia de 8+ digitos que sobrou |
| `[CONTATO]` | vCard compartilhado (descartado inteiro) |
| `[AUDIO]`, `[IMAGEM]`, `[VIDEO]`, `[DOCUMENTO]`, `[FIGURINHA]` | anexos (a legenda de imagem e video e mascarada; nome de arquivo e descartado) |

Regra geral: **na duvida, mascara**. O digito verificador so escolhe o rotulo (`[CPF]`, `[TELEFONE]` ou `[NUMERO]`),
nunca decide se o numero sai.

### Custos e travas

- MTalk: ate `MTALK_MAX_MESSAGE_FETCHES` GETs por coleta, contados em `requisicoesPorEndpoint` no diagnostico; a
  leitura tem trava propria (se a anterior ainda roda, pula).
- OpenAI: ate `AI_ANALYSIS_MAX_PER_HOUR` chamadas por hora na analise automatica. A manual conta no orcamento, mas nao
  e barrada por ele. Chamada que falhou tambem conta; o ticket espera 30 minutos antes de tentar de novo.
- Cada analise leva um prompt de sistema de ~1.300 tokens mais a conversa (ate 80 mensagens) e devolve algumas
  centenas de tokens. Com o teto padrao, sao no maximo 30 analises por hora; o custo em dinheiro depende do preco do
  modelo na OpenAI. Os tokens de cada analise aparecem no detalhe em **Atendimento IA**.

### O que ainda escapa

- **Nomes de terceiros** citados no texto ("fala com o Pedro do financeiro"): so o nome do contato e o dos
  atendentes sao conhecidos.
- Dado pessoal escrito de um jeito que nenhum detector reconhece (endereco sem palavra-chave, senha sem "senha"
  perto). O `assertNoPii` repete os mesmos detectores, entao nao pega o que eles nao reconhecem.
- O conteudo de audio, imagem e documento nao e lido.

### Proximos passos

- Usar `maiorEsperaClienteMinutos` para corrigir o alerta de inatividade: hoje ele mede **ticket parado** e nao
  separa "cliente aguardando" de "aguardando o cliente". Com as mensagens, da para alertar so o primeiro caso.

## Horarios

As tabelas mostram o **horario do ticket**: a ultima movimentacao no MTalk (`updatedAt`, gravado em `last_message_at`), que tambem e a origem do calculo de inatividade. O horario da coleta aparece so em "Ultima atualizacao" e "Ultima coleta".

Por isso a inatividade mede **ticket parado**, e nao "cliente sem resposta": o `updatedAt` nao diz se quem esta esperando e o cliente ou o atendente. O painel e o prompt da IA usam esse vocabulario de proposito.

O filtro de dia usa o fuso `MONITOR_TIME_ZONE` (padrao `America/Sao_Paulo`).

## Banco de dados

SQLite em `server/data/monitor.sqlite` (ou `SQLITE_PATH`). As migrations ficam em `server/src/database/index.js` (constante `MIGRATIONS`) e rodam ao subir a API, controladas pela tabela `schema_migrations`. Para adicionar uma, crie uma nova chave — nunca edite uma que ja rodou.

**Retencao:** cada coleta grava de novo todos os tickets em atendimento (uma linha por ticket por minuto), entao as leituras com mais de `RETENTION_DAYS` dias (padrao **90**; `0` guarda tudo) sao apagadas sozinhas — depois de uma coleta, no maximo a cada 6 horas e em lotes, para nao travar a API. As analises de atendimento seguem o mesmo `RETENTION_DAYS`; as mensagens mascaradas e os cursores de leitura, `MESSAGE_RETENTION_DAYS` (padrao **30**, e aqui `0` nao desliga). O arquivo do SQLite nao encolhe: o espaco liberado e reaproveitado pelas coletas seguintes.

## Seguranca e LGPD

O painel exige login; o token da extensao separa **o que cada atendente recebe**. A sessao do painel e o token da
extensao ficam em texto no navegador (`localStorage` do painel, `chrome.storage.local` da extensao): contra quem ja
tem acesso a maquina, isso nao protege. **Nao exponha a porta 3333 nem a 5173 fora da maquina** — e, com
`EXTENSION_OPEN_MODE=1` e nenhum token da extensao criado, as rotas de alertas ficam abertas para qualquer um que
alcance a API.

Na VPS, o que fica exposto e o nginx com TLS ([Hospedando numa VPS](#hospedando-numa-vps-ubuntu)): sem HTTPS a senha
do login, a sessao e os tokens viajam em texto e qualquer intermediario passa a ver os tickets. Se todos os
atendentes ja estao numa mesma rede ou VPN, restringir o nginx por IP tira o painel da internet.

Para os relatorios e alertas, o projeto coleta apenas: cliente, fila, atendente, conexao, horario, TAGs, status e
identificadores do ticket. Ele nunca faz escrita no atendimento: o cliente HTTP do MTalk so tem `GET`. O historico de
coletas e apagado depois de `RETENTION_DAYS` dias (padrao 90).

**Conteudo das mensagens.** Com a [analise de atendimento](#analise-de-atendimento-ia) **desligada** (padrao), o
sistema nao le mensagem nenhuma. **Ligada** (`AI_ATTENDANCE_ANALYSIS=1`), ele passa a ler `GET
/backend/messages/{ticketId}` — sem `markAsRead`, entao a conversa nao aparece como lida para o atendente — com estas
camadas de protecao:

1. **mascaramento na entrada**: o texto e mascarado antes de tocar o banco e so a versao mascarada e gravada; o
   original nunca vai para log, erro ou resposta da API. Localizacao e vCard sao descartados inteiros, anexo e nome de
   arquivo tambem. Se o mascaramento falhar, grava `[MENSAGEM_OCULTA]`, nunca o texto cru;
2. **verificacao antes do envio**: `assertNoPii()` confere o payload inteiro; se algo escapou, nada vai para a OpenAI;
3. **minimizacao**: a OpenAI nao recebe nome de cliente, de atendente ou de empresa, nem horario absoluto; o que ela
   devolve e mascarado de novo antes de gravar;
4. **retencao curta**: mensagens mascaradas saem em `MESSAGE_RETENTION_DAYS` (padrao **30**) dias; as analises, em
   `RETENTION_DAYS`;
5. **acesso so de administrador**: mensagens e analises so saem pelas rotas do painel (login com usuario e senha); o
   token da extensao nunca as le.

O banco guarda so a **contagem** do que foi mascarado em cada mensagem (`{"CPF":1}`), nunca o valor. **O que ainda
escapa**: nomes de terceiros citados no texto e dado pessoal escrito de um jeito que nenhum detector reconhece — veja
[O que ainda escapa](#o-que-ainda-escapa).

Os tokens do MTalk e da OpenAI ficam apenas no `.env` local; a API nunca os grava no banco nem os devolve. Os tokens
da extensao e as sessoes do painel ficam no banco **so como SHA-256**, e as senhas do painel como hash scrypt — nada
disso pode ser reconstituido a partir do banco.

Atencao ao usar a aba **IA**: gerar um **resumo gerencial** envia para a OpenAI o recorte filtrado, incluindo nomes de
clientes, atendentes e empresas. A analise de atendimento, ao contrario, nunca envia esses nomes.
