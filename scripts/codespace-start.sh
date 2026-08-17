#!/usr/bin/env bash
# Lancement de KoRoyale au démarrage d'un Codespace.
#
# Appelé par postStartCommand : doit rendre la main IMMÉDIATEMENT, tout en laissant
# le superviseur tourner en tâche de fond pour la durée de vie du Codespace.

set -u
cd "$(dirname "$0")/.." || exit 1

PORT="${PORT:-8080}"
LOG="${KOROYALE_LOG:-/tmp/koroyale.log}"

# --- un seul superviseur à la fois -----------------------------------------
# postStartCommand est rejoué à chaque réveil du Codespace : sans ce garde-fou,
# deux superviseurs se battraient pour le port 8080.
PIDFILE=/tmp/koroyale-supervisor.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "KoRoyale tourne déjà (pid $(cat "$PIDFILE")) — journal : $LOG"
  exit 0
fi

# --- dépendances (au cas où postCreateCommand n'a pas tourné) ---------------
if [ ! -d node_modules ]; then
  echo "Installation des dépendances…"
  npm install --no-audit --no-fund >> "$LOG" 2>&1
fi

# --- lancement détaché ------------------------------------------------------
if command -v setsid >/dev/null 2>&1; then
  setsid nohup node scripts/watch-and-serve.mjs >> "$LOG" 2>&1 &
else
  nohup node scripts/watch-and-serve.mjs >> "$LOG" 2>&1 &
fi
disown 2>/dev/null || true

# --- adresse à partager -----------------------------------------------------
echo
echo "  🐐 KoRoyale démarre…"
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  echo "  Adresse à partager : https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
else
  echo "  Adresse : http://localhost:${PORT}"
fi
echo "  Journal : tail -f $LOG"
echo
