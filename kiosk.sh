#!/bin/bash
# Startet die DJBOX-Oberfläche im Vollbild. Läuft per Autostart nach dem Login.
URL=http://127.0.0.1:8765/
KIOSK_URL="$URL?kiosk"
for i in $(seq 1 60); do curl -sf -o /dev/null "$URL" && break; sleep 1; done
while true; do
  chromium --kiosk --app="$KIOSK_URL" \
    --user-data-dir="$HOME/.config/djbox/chromium" \
    --ozone-platform=wayland --noerrdialogs --disable-infobars --no-first-run \
    --autoplay-policy=no-user-gesture-required --password-store=basic \
    --overscroll-history-navigation=0 --disable-pinch --disable-features=Translate,TouchpadOverscrollHistoryNavigation \
    --check-for-update-interval=31536000 --disable-session-crashed-bubble
  [ -e "$HOME/.config/djbox/stop" ] && { rm -f "$HOME/.config/djbox/stop"; break; }
  sleep 2
done
