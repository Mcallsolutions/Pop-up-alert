# Mcall Ticket Tag Monitor

Monitor de TAG e de inatividade dos tickets do MTalk. O servidor le os tickets **somente pela API oficial do MTalk**, grava os snapshots em um banco local e alimenta:

- um **painel web** com relatorios, inatividade e resumos de IA;
- uma **extensao Chrome** que mostra o pop-up de alertas na tela de tickets do MTalk.

Por enquanto o projeto roda **apenas localmente**. O acesso e por **token por pessoa**: cada atendente ve os
proprios tickets (e todos os que estao sem atendente) — veja [Acesso por token](#acesso-por-token-quem-ve-o-que).

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
npm run token       # emite, lista e revoga os tokens de acesso
```

### Credenciais do MTalk

A autenticacao e por **URL + token**:

- `MTALK_BASE_URL` — backend da instancia, terminando em `/backend` (ex.: `https://s11.mtalk.com.br/backend`);
- `MTALK_TOKEN` — token Bearer de um usuario com acesso as filas monitoradas. Pode ser colado cru, com `Bearer ` na frente ou entre aspas.

O servidor nao faz login nem renova o token. Quando o MTalk recusar (token expirado ou revogado), a coleta falha e o erro aparece no painel e no popup da extensao: gere um novo token, atualize o `.env` e reinicie a API. O token fica **so no `.env`**, que nao vai para o git — este repositorio e publico.

Sem token a API sobe normalmente, mas a coleta automatica fica desligada e o log avisa. Detalhes em [`Mtalk integration/README.md`](Mtalk%20integration/README.md).

Para conferir: **Configuracoes** no painel mostra se o token foi aceito, a ultima coleta e o botao **Coletar agora**.

## Acesso por token (quem ve o que)

Cada pessoa tem o **seu** token de acesso a esta API. Ele nao tem nada a ver com o `MTALK_TOKEN`: a coleta continua
sendo uma so, com um token unico do MTalk, e o token da pessoa apenas **recorta o que ela le** do que ja foi coletado.

| Perfil | Ve |
| --- | --- |
| `ATENDENTE` | os tickets dele **mais todos os tickets sem atendente** |
| `ADMIN` | tudo, incluindo a aba IA e o diagnostico da coleta |

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
Revogar vale na hora. Quem ja tem token de ADMIN tambem emite e revoga pelo painel, em **Configuracoes**.

O `--atendente` e o nome como aparece no MTalk; as variacoes conhecidas sao unificadas sozinhas (`Alek NETFIBRA` vira
`Aleksandro`), a mesma tabela que os relatorios usam.

### Modo aberto

**Enquanto nao existe nenhum token ativo, a API fica aberta** e todo mundo enxerga tudo, como era antes — assim um
clone novo sobe com `npm run dev` sem passo extra. **Criar o primeiro token liga a exigencia para todo mundo**,
inclusive para o painel e a extensao que estiverem abertos: emita o seu token de ADMIN junto com os dos atendentes.

### Onde cada um cola o token

- **Painel**: a tela de acesso pede o token e ele fica no `localStorage` daquele navegador. "Sair" limpa.
- **Extensao**: campo **Seu token de acesso**, no popup ou nas opcoes. O popup mostra em **Alertas de** de quem e o
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
hora (qualquer token serve — quem instala e a propria pessoa do atendimento). O zip traz uma pasta so, para
descompactar e apontar o "Carregar sem compactacao" nela, e **nao leva token nem `.env` dentro**: cada pessoa cola o
seu token depois de instalar.

A URL da API vem como `http://localhost:3333`; troque no popup ou nas opcoes da extensao se precisar. O token fica no
`chrome.storage.local` daquele perfil do Chrome, entao cada atendente cola o seu uma vez.

Como funciona:

- a cada 1 minuto o content script pede `GET /api/mtalk/alerts` com o token da pessoa (a chamada sai do service worker, porque a pagina https do MTalk nao pode chamar `http://localhost`), e recebe so os alertas do recorte dela;
- **Registre a TAG do cliente** lista tickets sem TAG com atendente vinculado; **Alerta de inatividade** lista tickets parados ha mais de 15 minutos, com ou sem atendente;
- clicar no item abre o ticket (`/tickets/<uuid>`); fechar o pop-up silencia por 5 minutos;
- sem coleta recente no servidor (API fora do ar, token do MTalk recusado) o pop-up some, em vez de mostrar alerta velho;
- no popup, **Coletar agora** pede uma coleta imediata e **Testar API** confere a API local e o token do MTalk.

## Hospedando numa VPS (Ubuntu)

O passo a passo completo, da maquina recem-criada ate o painel no ar, esta em **[deploy/VPS.md](deploy/VPS.md)**.
Os arquivos de exemplo ficam na mesma pasta: `mcall.service` (systemd), `nginx.conf`, `.env.production.example` e
`atualizar.sh`. O desenho e **systemd rodando o Node + nginx na frente**: uma app Node so, com o banco em arquivo,
nao ganha nada com Docker — o container so acrescentaria a dor de cuidar do volume do SQLite.

O dominio da operacao tem um caractere acentuado. Manifest de extensao, nginx e certbot so aceitam a forma em
**ASCII (punycode)**: `xn--gesto-dra.mcallsolutions.com.br`. E tambem a forma que o navegador manda no cabecalho
`Origin`, entao e ela que vai no `CORS_ORIGINS`. Um alias sem acento (`gestao.mcallsolutions.com.br`) evita o assunto
inteiro e ja esta liberado na configuracao.

1. **DNS**: registro `A` do dominio (e do alias sem acento, se usar) apontando para o IP da VPS.
2. **Node 24**: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -` e `sudo apt install -y nodejs`.
   O banco usa `node:sqlite`, que so existe a partir do Node 22.5 e so e estavel no 24.
3. **Codigo**: clone em `/opt/mcall`, com um usuario de servico proprio (`sudo useradd --system --create-home mcall`).
   O banco fica fora da pasta do deploy: `sudo install -d -o mcall -g mcall /var/lib/mcall`.
4. **.env**: copie `deploy/.env.production.example` para `/opt/mcall/.env`, preencha `MTALK_TOKEN` e
   `OPENAI_API_KEY` e feche o arquivo (`chmod 600`).
5. **Build**: `npm ci` (completo — o build do painel usa as devDependencies) e `npm run build`.
6. **systemd**: copie `deploy/mcall.service` para `/etc/systemd/system/`, `daemon-reload` e `enable --now mcall`.
7. **nginx + TLS**: copie `deploy/nginx.conf` para `/etc/nginx/sites-available/mcall`, ative o link e rode
   `sudo certbot --nginx -d xn--gesto-dra.mcallsolutions.com.br`.
8. **Firewall**: `sudo ufw allow 22,80,443/tcp && sudo ufw enable`. A porta 3333 nunca e liberada — com
   `HOST=127.0.0.1` ela so existe para o nginx.
9. **Emita o token de ADMIN antes de abrir o dominio**: enquanto nao houver token a API fica em
   [modo aberto](#modo-aberto), e na internet isso significa que qualquer um le tudo.

Depois disso, atualizar e `./deploy/atualizar.sh` (git pull, build e restart).

### O que muda em relacao ao ambiente local

| Variavel | Local | VPS |
| --- | --- | --- |
| `HOST` | `0.0.0.0` (a extensao de cada maquina alcanca a API) | `127.0.0.1` (so o nginx) |
| `TRUST_PROXY` | `0` | `1` — sem isso o rate limit conta todo mundo como o nginx |
| `SERVE_ADMIN` | `1` (a API serve `/dist` se ele existir) | `0` — quem serve os estaticos e o nginx |
| `SQLITE_PATH` | `server/data/monitor.sqlite` | `/var/lib/mcall/monitor.sqlite` |
| `CORS_ORIGINS` | padrao (localhost + extensao) | o dominio em punycode + `chrome-extension://` |

Na extensao, o `manifest.json` precisa do dominio em `host_permissions` — sem isso o service worker nao consegue
chamar a API — e o `apiBaseUrl` padrao ja aponta para ele. Quem usar a API local troca a URL no popup.

### Backup

O banco e o historico inteiro de coletas. Nunca copie o arquivo com a API rodando (o WAL fica de fora); use o
`.backup` do proprio SQLite num cron diario:

```bash
sqlite3 /var/lib/mcall/monitor.sqlite ".backup /var/backups/mcall-$(date +%F).sqlite"
```

## API

Fora `GET /health`, todo endpoint exige o cabecalho `Authorization: Bearer <token>` — a menos que a API esteja em
[modo aberto](#modo-aberto). Sem token valido a resposta e `401`; area de ADMIN acessada com token de atendente da
`403`. `/api/reports` e `/api/mtalk/alerts` ja respondem **recortados** pelo token.

Acesso:

- `GET /api/auth/me` — quem e o token, qual o recorte e se a API exige token
- `GET /api/auth/tokens` / `POST /api/auth/tokens` / `DELETE /api/auth/tokens/:id` (ADMIN)

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

IA (so ADMIN):

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

O token por pessoa separa **o que cada um enxerga**; ele nao transforma o projeto em algo exposto com seguranca.
O token fica em texto no navegador (`localStorage` do painel, `chrome.storage.local` da extensao): contra quem ja tem
acesso a maquina ou a rede, isso nao protege. **Nao exponha a porta 3333 nem a 5173 fora da maquina** — e, se nenhum
token foi criado ainda, a API esta aberta e qualquer um que a alcance le tudo.

Na VPS, o que fica exposto e o nginx com TLS ([Hospedando numa VPS](#hospedando-numa-vps-ubuntu)): sem HTTPS o token
viaja em texto no cabecalho `Authorization` e qualquer intermediario passa a ver os tickets daquela pessoa. Se todos os
atendentes ja estao numa mesma rede ou VPN, restringir o nginx por IP tira o painel da internet e devolve ao token o
papel que ele tem: recorte de visao, nao barreira de acesso.

O projeto coleta apenas o necessario para o relatorio: cliente, fila, atendente, conexao, horario, TAGs, status e identificadores do ticket. Ele **nao le o conteudo das mensagens** — nunca chama `GET /backend/messages/{ticketId}` — e nao faz nenhuma escrita no atendimento.

Os tokens do MTalk e da OpenAI ficam apenas no `.env` local; a API nunca os grava no banco nem os devolve. Os tokens
de acesso ao painel ficam no banco **so como SHA-256** — nem a listagem de tokens consegue reconstituir um deles.

Atencao ao usar a aba **IA**: gerar um resumo envia para a OpenAI o recorte filtrado, incluindo nomes de clientes, atendentes e empresas.
