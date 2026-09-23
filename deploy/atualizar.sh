#!/usr/bin/env bash
# Atualiza o deploy da VPS: pega o codigo novo, recompila o painel e reinicia a
# API. Rode como o usuario dono de /opt/tag-monitor.
#
#   cd /opt/tag-monitor && ./deploy/atualizar.sh

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Codigo"
git pull --ff-only

echo "==> Dependencias"
# npm ci completo: o build do painel usa as devDependencies (vite).
npm ci

echo "==> Painel"
npm run build

echo "==> API"
# As migrations rodam sozinhas ao subir; o restart ja basta.
sudo systemctl restart tag-monitor
sudo systemctl --no-pager --lines=10 status tag-monitor
