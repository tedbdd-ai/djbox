#!/bin/bash
# Auf dem Mac ausführen: schickt den aktuellen Stand auf den Raspi und lädt neu.
#   ./deploy.sh            -> Server neu starten + Oberfläche neu laden
set -e
PI=${DJBOX_PI:-commander@192.168.178.41}
cd "$(dirname "$0")"
rsync -av --delete --exclude .git --exclude __pycache__ --exclude .DS_Store ./ "$PI:djbox/"
ssh "$PI" 'systemctl --user restart djbox && pkill -x chromium || true'
echo "Fertig – die Oberfläche startet in ein paar Sekunden neu."
