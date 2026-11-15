# DJBOX

Player-Box für den Raspberry Pi 5 mit Touch Display 2 (Querformat, 1280×720).
Zwei Decks, Mixer, Automix, Plattenkisten zum Stöbern, MIDI-Learn. OLED-Mono-Look.

- `server.py` – Python-Server (nur Standardbibliothek + ffmpeg): liest die Sammlung
  aus `/mnt/musik` (SMB-Freigabe), liefert Audio (AIFF → FLAC-Cache), Cover,
  Wellenform/BPM-Analyse, Einstellungen und USB-MIDI-Events (SSE). Port 8765, nur localhost.
- `static/` – Oberfläche (HTML/CSS/JS, kein Build-Schritt).
- `kiosk.sh` – startet Chromium im Vollbild.
- `deploy/` – systemd-User-Dienst, Autostart-Eintrag, `install-pi.sh`.
- `deploy.sh` – vom Mac aus auf den Raspi übertragen und neu laden.

Cache: `~/.cache/djbox` · Einstellungen/MIDI-Mapping: `~/.config/djbox/settings.json`
Selbsttest: Oberfläche mit `?selftest` öffnen, Ergebnis steht im Browser-Log.

Lokal auf dem Mac testen: `DJBOX_MUSIC=/Volumes/files/media/music_plex python3 server.py`
(braucht ffmpeg, z. B. `brew install ffmpeg`), dann http://127.0.0.1:8765 öffnen.
