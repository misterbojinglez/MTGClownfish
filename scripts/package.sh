#!/usr/bin/env bash
# Builds a shareable, ready-to-run copy of MTG Tabletop: dist/MTG-Tabletop.zip.
# Testers unzip it and double-click the launcher for their system; the only thing they need is Java 17+.
# Inside: the bridge (Forge included), Forge's card data, and the built client, which the bridge serves.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/MTG-Tabletop"
JAR="$ROOT/bridge/target/forge-bridge-0.1.0.jar"
RES="$ROOT/engine/forge/forge-gui/res"

[ -f "$JAR" ] || "$ROOT/scripts/build-engine.sh"
echo "building the client…"
(cd "$ROOT/client" && npm run build --silent)

rm -rf "$OUT" "$ROOT/dist/MTG-Tabletop.zip"
mkdir -p "$OUT/forge"
cp "$JAR" "$OUT/forge-bridge.jar"
cp -R "$ROOT/client/dist" "$OUT/client"
echo "copying Forge's card data…"
# Forge's Adventure mode and its music aren't used here
rsync -a --exclude 'adventure/' --exclude 'music/' "$RES" "$OUT/forge/"

# ---- launchers ----
cat > "$OUT/Start MTG Tabletop.command" <<'SH'
#!/usr/bin/env bash
# macOS: double-click to play. (First time: right-click > Open, since it wasn't downloaded from the App Store.)
cd "$(dirname "$0")"
if ! command -v java >/dev/null 2>&1 || ! java -version 2>&1 | grep -Eq 'version "(1[7-9]|[2-9][0-9])'; then
  osascript -e 'display dialog "MTG Tabletop needs Java 17 or newer.\n\nInstall it from adoptium.net (Temurin 21, the .pkg for your Mac), then open this again." buttons {"OK"} with icon caution' >/dev/null
  open "https://adoptium.net/temurin/releases/?version=21"
  exit 1
fi
echo "Starting MTG Tabletop… (leave this window open while you play; close it to quit)"
java -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT INT TERM
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:7780/ && break; sleep 1; done
open "http://127.0.0.1:7780/"
wait $BRIDGE
SH
chmod +x "$OUT/Start MTG Tabletop.command"

cat > "$OUT/start.sh" <<'SH'
#!/usr/bin/env bash
# Linux: run ./start.sh, then open http://127.0.0.1:7780/ if no browser opens.
cd "$(dirname "$0")"
command -v java >/dev/null 2>&1 || { echo "MTG Tabletop needs Java 17+ (e.g. sudo apt install openjdk-21-jre)"; exit 1; }
java -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT INT TERM
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:7780/ && break; sleep 1; done
xdg-open "http://127.0.0.1:7780/" >/dev/null 2>&1 || echo "Open http://127.0.0.1:7780/ in your browser"
wait $BRIDGE
SH
chmod +x "$OUT/start.sh"

cat > "$OUT/Start MTG Tabletop.bat" <<'BAT'
@echo off
rem Windows: double-click to play. Leave the black window open while you play; close it to quit.
cd /d "%~dp0"
where java >nul 2>nul
if errorlevel 1 (
  echo MTG Tabletop needs Java 17 or newer. Install Temurin 21 from adoptium.net, then run this again.
  start "" "https://adoptium.net/temurin/releases/?version=21"
  pause
  exit /b 1
)
echo Starting MTG Tabletop... the game opens in your browser in a few seconds.
start "" /b java -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar
timeout /t 8 /nobreak >nul
start "" "http://127.0.0.1:7780/"
echo Close this window to quit.
pause >nul
BAT

cat > "$OUT/README.txt" <<'TXT'
MTG Tabletop — play Magic against Forge AI opponents (1v1 or 4-player Commander)

1. Install Java 17 or newer if you don't have it: https://adoptium.net (Temurin 21).
2. Start the game:
     macOS:   double-click "Start MTG Tabletop.command"
              (the first time macOS may refuse: right-click it > Open > Open)
     Windows: double-click "Start MTG Tabletop.bat"
     Linux:   run ./start.sh
3. The game opens in your browser at http://127.0.0.1:7780/ (Chrome, Safari, Firefox or Edge).
   Keep the launcher window open while you play; close it to quit.

Card images come from Scryfall, so you need an internet connection.
Each game is recorded in the logs/ folder — send it along when reporting a bug.

The rules engine is Forge (GPL-3.0, https://github.com/Card-Forge/forge).
TXT

echo "zipping…"
(cd "$ROOT/dist" && zip -qry MTG-Tabletop.zip MTG-Tabletop)
du -sh "$OUT" "$ROOT/dist/MTG-Tabletop.zip"
echo "done: dist/MTG-Tabletop.zip"
