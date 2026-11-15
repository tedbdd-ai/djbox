#!/bin/bash
# Auf dem Raspi ausführen: richtet Server-Dienst und Vollbild-Autostart ein.
set -e
cd "$(dirname "$0")/.."
mkdir -p ~/.config/systemd/user ~/.config/autostart
cp deploy/djbox.service ~/.config/systemd/user/
cp deploy/djbox.desktop ~/.config/autostart/
chmod +x kiosk.sh
systemctl --user daemon-reload
systemctl --user enable --now djbox.service
echo "DJBOX installiert. Neustart oder: ./kiosk.sh &"
