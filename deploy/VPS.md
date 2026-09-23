# Preparando a VPS (Ubuntu 26.04)

Passo a passo do zero: maquina recem-criada ate o painel no ar em
`https://tag-monitor.mcallsolutions.com.br`, com a extensao disponivel para download.

Os arquivos citados aqui estao nesta mesma pasta: [`tag-monitor.service`](tag-monitor.service),
[`nginx.conf`](nginx.conf), [`.env.production.example`](.env.production.example) e
[`atualizar.sh`](atualizar.sh).

## Antes de comecar

Tenha em maos:

- acesso SSH da VPS (root ou um usuario com `sudo`);
- **DNS ja apontado**: registro `A` de `tag-monitor.mcallsolutions.com.br` para o IP da VPS. Sem DNS propagado o
  certbot falha no passo 12;
- o **token do MTalk** (`MTALK_TOKEN`) e, se for usar a aba IA, a chave da OpenAI.

Confira o DNS antes de subir qualquer coisa:

```bash
dig +short tag-monitor.mcallsolutions.com.br
```

## Roteiro da instalacao

A ordem importa: o firewall antes de expor a maquina, o `.env` antes de subir o servico (senao o banco nasce no lugar
errado), o nginx antes do certbot (que edita o arquivo dele) e o usuario do painel antes de divulgar o endereco. Cada
passo esta detalhado na secao correspondente.

| Passo | O que faz | Comando central |
| --- | --- | --- |
| [1](#1-primeiro-acesso-e-atualizacao) | atualiza o sistema e acerta o fuso | `apt update && apt upgrade -y` |
| [2](#2-usuario-de-deploy) | cria o usuario com `sudo` que sera dono do codigo | `adduser deploy && usermod -aG sudo deploy` |
| [3](#3-firewall) | libera SSH, 80 e 443 e liga o UFW | `sudo ufw allow OpenSSH` |
| [4](#4-pacotes-base) | git, nginx, sqlite3 e atualizacoes automaticas | `sudo apt install -y git curl ca-certificates nginx sqlite3 unattended-upgrades` |
| [5](#5-node-24) | Node 24 (o banco usa `node:sqlite`) | `node -e "require('node:sqlite')"` |
| [6](#6-usuario-de-servico-e-pastas) | usuario sem shell da API e pasta do banco | `sudo install -d -o tag-monitor -g tag-monitor -m 750 /var/lib/tag-monitor` |
| [7](#7-codigo) | clona o repositorio em `/opt/tag-monitor` | `git clone ... /opt/tag-monitor` |
| [8](#8-arquivo-env) | `.env` com `MTALK_TOKEN` e `SQLITE_PATH` | `sudo cp deploy/.env.production.example /opt/tag-monitor/.env` |
| [9](#9-dependencias-e-build-do-painel) | instala tudo e compila o painel em `dist/` | `npm ci && npm run build` |
| [10](#10-servico-systemd) | sobe a API pelo systemd | `sudo systemctl enable --now tag-monitor` |
| [11](#11-nginx) | serve o painel e repassa `/api` e `/health` | `sudo nginx -t && sudo systemctl reload nginx` |
| [12](#12-https) | certificado e renovacao automatica | `sudo certbot --nginx -d tag-monitor.mcallsolutions.com.br` |
| [13](#13-usuario-do-painel-e-tokens-da-extensao-faca-antes-de-divulgar-o-endereco) | **cria o login do painel** e os tokens da extensao | `... admins.js criar --login supervisao` |
| [14](#14-backup-do-banco) | backup diario do SQLite via cron | `sudo /usr/local/bin/tag-monitor-backup.sh` |
| [15](#15-conferencia-final) | confere painel, extensao e porta fechada | `curl -m 5 http://SEU_IP:3333/health` (tem que falhar) |

Ja tem uma VPS rodando? Nao repita a instalacao: para atualizar o codigo use
[Atualizando depois](#atualizando-depois), e se os caminhos dela ainda forem `mcall`, veja
[Migrando uma VPS que ainda usa os caminhos `mcall`](#migrando-uma-vps-que-ainda-usa-os-caminhos-mcall).

## 1. Primeiro acesso e atualizacao

```bash
ssh root@SEU_IP
```

```bash
apt update && apt upgrade -y
```

Fuso do sistema (o `MONITOR_TIME_ZONE` cuida do painel; isto alinha log, cron e backup):

```bash
timedatectl set-timezone America/Sao_Paulo
```

## 2. Usuario de deploy

Se voce entrou como root, crie um usuario com `sudo` e use ele daqui em diante — o servico nao roda como root e o
codigo tambem nao precisa pertencer a ele.

```bash
adduser deploy && usermod -aG sudo deploy
```

Reentre como `deploy` (`ssh deploy@SEU_IP`). Os comandos seguintes usam `sudo`.

## 3. Firewall

Libere o SSH **antes** de ligar o UFW, senao voce se tranca para fora. (Se o `ufw` nao existir na imagem da VPS:
`sudo apt install -y ufw`.)

```bash
sudo ufw allow OpenSSH
```

```bash
sudo ufw allow 80,443/tcp
```

```bash
sudo ufw enable
```

A porta 3333 nunca entra nessa lista: com `HOST=127.0.0.1` ela existe so para o nginx.

## 4. Pacotes base

```bash
sudo apt install -y git curl ca-certificates nginx sqlite3 unattended-upgrades
```

- `sqlite3` e a ferramenta de linha de comando, usada no backup (o banco em si vem do Node);
- `unattended-upgrades` aplica sozinho as correcoes de seguranca do Ubuntu.

## 5. Node 24

O banco usa o modulo `node:sqlite`, que **so existe a partir do Node 22.5 e so e estavel no 24**. Veja primeiro o que
o proprio Ubuntu oferece:

```bash
apt-cache policy nodejs
```

**Se o candidato for 24.x ou maior**, use o pacote do Ubuntu — e o caminho mais simples e ele recebe atualizacao de
seguranca junto com o sistema:

```bash
sudo apt install -y nodejs npm
```

**Se for menor que 24**, instale pelo NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs
```

**Se o NodeSource ainda nao publicou repositorio para o 26.04** (o script acima reclama da versao do sistema), use o
binario oficial — confira em <https://nodejs.org/dist/latest-v24.x/> qual e o arquivo `linux-x64.tar.xz` atual:

```bash
curl -fsSL https://nodejs.org/dist/latest-v24.x/node-v24.10.0-linux-x64.tar.xz | sudo tar -xJ -C /usr/local --strip-components=1
```

Confira a versao **e** se o modulo do banco carrega sem flag nenhuma — este segundo teste e o que importa:

```bash
node --version && node -e "require('node:sqlite'); console.log('node:sqlite ok')"
```

Se o Node nao tiver ficado em `/usr/bin/node`, veja onde ele esta e ajuste o `ExecStart` do
[`tag-monitor.service`](tag-monitor.service) no passo 10:

```bash
command -v node
```

## 6. Usuario de servico e pastas

A API roda como um usuario sem shell, que **so escreve na pasta do banco**. O codigo pertence ao `deploy`; o servico
apenas le.

```bash
sudo useradd --system --user-group --shell /usr/sbin/nologin --no-create-home tag-monitor
```

O `--user-group` garante o grupo `tag-monitor`, usado nos comandos logo abaixo e na permissao do `.env`.

```bash
sudo install -d -o tag-monitor -g tag-monitor -m 750 /var/lib/tag-monitor
```

```bash
sudo install -d -o root -g root -m 755 /var/backups/tag-monitor
```

## 7. Codigo

```bash
sudo install -d -o deploy -g tag-monitor -m 755 /opt/tag-monitor
```

```bash
git clone https://github.com/Mcallsolutions/Pop-up-alert.git /opt/tag-monitor
```

## 8. Arquivo .env

```bash
sudo cp /opt/tag-monitor/deploy/.env.production.example /opt/tag-monitor/.env
```

Preencha `MTALK_TOKEN` e, se for usar a aba IA, `OPENAI_API_KEY`:

```bash
sudo nano /opt/tag-monitor/.env
```

O arquivo fica do root, legivel pelo grupo do servico — o systemd le como root, e o usuario `tag-monitor` precisa
dele para achar o banco quando voce criar usuarios ou emitir tokens pela linha de comando:

```bash
sudo chown root:tag-monitor /opt/tag-monitor/.env && sudo chmod 640 /opt/tag-monitor/.env
```

Confira que `HOST=127.0.0.1`, `TRUST_PROXY=1`, `SERVE_ADMIN=0` e `SQLITE_PATH=/var/lib/tag-monitor/monitor.sqlite` estao
como no modelo.

## 9. Dependencias e build do painel

```bash
cd /opt/tag-monitor && npm ci
```

O `npm ci` e **completo** de proposito: o build do painel usa o Vite, que esta nas `devDependencies`.

```bash
cd /opt/tag-monitor && npm run build
```

> Se o build morrer com `Killed`, a VPS ficou sem memoria (acontece em maquina de 1 GB). Crie swap e repita:
> `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
> (para ficar permanente, acrescente `/swapfile none swap sw 0 0` ao `/etc/fstab`).

O resultado vai para `/opt/tag-monitor/dist`, que e a pasta que o nginx serve.

## 10. Servico (systemd)

```bash
sudo cp /opt/tag-monitor/deploy/tag-monitor.service /etc/systemd/system/tag-monitor.service
```

Se o `command -v node` do passo 5 nao devolveu `/usr/bin/node`, corrija o `ExecStart` agora:

```bash
sudo nano /etc/systemd/system/tag-monitor.service
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tag-monitor
```

Confira que subiu e que o banco foi criado no lugar certo:

```bash
systemctl status tag-monitor --no-pager
```

```bash
curl -s localhost:3333/health
```

A resposta tem que trazer `"status":"ok"` e o caminho `/var/lib/tag-monitor/monitor.sqlite`. Se algo falhar:

```bash
journalctl -u tag-monitor -n 50 --no-pager
```

## 11. nginx

```bash
sudo cp /opt/tag-monitor/deploy/nginx.conf /etc/nginx/sites-available/tag-monitor
```

```bash
sudo ln -sf /etc/nginx/sites-available/tag-monitor /etc/nginx/sites-enabled/tag-monitor
```

Tire o site padrao do caminho, senao ele responde antes:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Teste ainda em HTTP, direto pelo dominio:

```bash
curl -s http://tag-monitor.mcallsolutions.com.br/health
```

## 12. HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
```

```bash
sudo certbot --nginx -d tag-monitor.mcallsolutions.com.br
```

O dominio tem que ser o mesmo do `server_name` do nginx e do `CORS_ORIGINS` do `.env`. O certbot edita o proprio
arquivo do nginx, cria o bloco 443 e o redirecionamento do 80, e instala a renovacao automatica. Confira a renovacao:

```bash
sudo certbot renew --dry-run
```

## 13. Usuario do painel e tokens da extensao (faca antes de divulgar o endereco)

O painel entra com **usuario e senha**, e sem nenhum usuario ele nao abre. Crie o seu (a senha e pedida no
terminal, sem eco):

```bash
cd /opt/tag-monitor && sudo -u tag-monitor node server/src/scripts/admins.js criar --login supervisao --nome "Supervisao"
```

Para trocar a senha depois: `... admins.js senha --login supervisao` (derruba as sessoes abertas).

Os tokens sao so da extensao. Enquanto nao existe nenhum, as rotas de alertas ficam em **modo aberto**: qualquer um
que alcance o dominio recebe todos os alertas. Emita os dos atendentes pelo painel, em **Configuracoes > Tokens da
extensao**, ou por aqui:

```bash
cd /opt/tag-monitor && sudo -u tag-monitor node server/src/scripts/tokens.js criar --nome "Stephanie" \
  --atendente "Stephanie"
```

Confira que o recorte ficou como voce espera:

```bash
cd /opt/tag-monitor && sudo -u tag-monitor node server/src/scripts/tokens.js listar
```

> Localmente os atalhos sao `npm run admin -- ...` e `npm run token -- ...`. Aqui o comando chama o script direto
> porque o usuario `tag-monitor` nao tem home: o npm tentaria escrever cache em um diretorio que nao existe. O `node`
> le o mesmo `.env` da pasta e grava no banco de `/var/lib/tag-monitor`.

## 14. Backup do banco

O banco e o historico inteiro de coletas. Com WAL ligado, copiar o arquivo com a API rodando produz backup
incompleto — use o `.backup` do SQLite. Crie o script:

```bash
sudo nano /usr/local/bin/tag-monitor-backup.sh
```

Conteudo:

```sh
#!/bin/sh
set -e
sqlite3 /var/lib/tag-monitor/monitor.sqlite ".backup /var/backups/tag-monitor/monitor-$(date +%F).sqlite"
find /var/backups/tag-monitor -name 'monitor-*.sqlite' -mtime +14 -delete
```

Torne executavel e rode uma vez para conferir:

```bash
sudo chmod +x /usr/local/bin/tag-monitor-backup.sh && sudo /usr/local/bin/tag-monitor-backup.sh \
  && ls -l /var/backups/tag-monitor
```

Agende para as 3h da manha:

```bash
echo '0 3 * * * root /usr/local/bin/tag-monitor-backup.sh' | sudo tee /etc/cron.d/tag-monitor-backup
```

> O comando fica num script, e nao direto no cron, porque `%` tem significado especial em crontab: um `date +%F` cru
> naquela linha quebra o agendamento.

## 15. Conferencia final

1. `https://tag-monitor.mcallsolutions.com.br` abre a tela de login do painel;
2. o usuario criado no passo 13 entra e o Dashboard carrega;
3. em **Configuracoes**, "Coletar agora" traz tickets (se nao, o `MTALK_TOKEN` esta errado ou venceu);
4. em **Configuracoes > Extensao do Chrome**, o botao baixa o `.zip`;
5. descompactada e carregada no Chrome, a extensao mostra o alerta em `https://s11.mtalk.com.br/tickets`;
6. de fora da VPS, a porta 3333 nao responde: `curl -m 5 http://SEU_IP:3333/health` tem que falhar.

## Migrando uma VPS que ainda usa os caminhos `mcall`

Deploys feitos antes desta renomeacao usam `/opt/mcall`, `/var/lib/mcall`, o usuario `mcall` e o servico
`mcall.service`. O nome novo e `tag-monitor`, igual ao subdominio. Nada disso muda o banco: e so mover as pastas e
reapontar o servico.

Pare a API antes de mover qualquer coisa — mover o banco com a API escrevendo nele corrompe o WAL:

```bash
sudo systemctl disable --now mcall
```

Crie o usuario novo e mova as pastas (o banco vai junto, com o historico inteiro):

```bash
sudo useradd --system --user-group --shell /usr/sbin/nologin --no-create-home tag-monitor
```

```bash
sudo mv /opt/mcall /opt/tag-monitor && sudo mv /var/lib/mcall /var/lib/tag-monitor
```

```bash
sudo mv /var/backups/mcall /var/backups/tag-monitor
```

Ajuste donos e o `SQLITE_PATH` do `.env`:

```bash
sudo chown -R tag-monitor:tag-monitor /var/lib/tag-monitor && sudo chown -R deploy:tag-monitor /opt/tag-monitor
```

```bash
sudo sed -i 's#/var/lib/mcall#/var/lib/tag-monitor#' /opt/tag-monitor/.env
```

```bash
sudo chown root:tag-monitor /opt/tag-monitor/.env && sudo chmod 640 /opt/tag-monitor/.env
```

Pegue o codigo novo (ele traz o `tag-monitor.service`) e troque a unit:

```bash
cd /opt/tag-monitor && git pull --ff-only && npm ci && npm run build
```

```bash
sudo rm -f /etc/systemd/system/mcall.service
```

```bash
sudo cp /opt/tag-monitor/deploy/tag-monitor.service /etc/systemd/system/tag-monitor.service
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tag-monitor
```

No nginx, **renomeie o arquivo em vez de copiar o do repositorio**: o que esta na VPS tem o bloco 443 e os caminhos
do certificado que o certbot escreveu, e o do repositorio nao.

```bash
sudo mv /etc/nginx/sites-available/mcall /etc/nginx/sites-available/tag-monitor
```

```bash
sudo sed -i 's#/opt/mcall#/opt/tag-monitor#' /etc/nginx/sites-available/tag-monitor
```

```bash
sudo rm -f /etc/nginx/sites-enabled/mcall
```

```bash
sudo ln -sf /etc/nginx/sites-available/tag-monitor /etc/nginx/sites-enabled/tag-monitor
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

A renovacao do certificado continua valendo: o certbot acha o site pelo `server_name`, nao pelo nome do arquivo.

Troque tambem o backup e, por fim, apague o usuario antigo:

```bash
sudo rm -f /usr/local/bin/mcall-backup.sh /etc/cron.d/mcall-backup
```

```bash
sudo userdel mcall
```

Confira que voltou: `systemctl status tag-monitor --no-pager`, `curl -s localhost:3333/health` (o caminho do banco na
resposta tem que ser `/var/lib/tag-monitor/monitor.sqlite`) e o dominio abrindo no navegador.

## Atualizando depois

```bash
cd /opt/tag-monitor && ./deploy/atualizar.sh
```

O script faz `git pull`, `npm ci`, `npm run build` e reinicia o servico. As migrations do banco rodam sozinhas ao
subir a API.

## Problemas comuns

| Sintoma | Causa provavel |
| --- | --- |
| `502 Bad Gateway` no dominio | servico fora do ar — veja `journalctl -u tag-monitor -n 50` |
| `Origem nao permitida pelo CORS: https://...` | o dominio do erro nao esta no `CORS_ORIGINS` do `.env` |
| Extensao nunca conecta, painel funciona | dominio ausente de `host_permissions` no `manifest.json` |
| Todo mundo ve todos os tickets | nenhum token criado: API em modo aberto (passo 13) |
| `npm run build` morre com `Killed` | falta memoria — crie swap (passo 9) |
| `Cannot find module 'node:sqlite'` | Node menor que 22.5 (passo 5) |
| Banco aparece em `/opt/tag-monitor/server/data` | o processo nao leu o `.env` — confira dono e permissao do arquivo |
