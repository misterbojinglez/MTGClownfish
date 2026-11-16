#!/usr/bin/env bash
# Builds a shareable, ready-to-run copy of MTGClownfish: dist/MTGClownfish.zip.
# Testers unzip it and double-click the launcher for their system; the only thing they need is Java 17+.
# Inside: the bridge (Forge included), Forge's card data, and the built client, which the bridge serves.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/MTGClownfish"
JAR="$ROOT/bridge/target/forge-bridge-0.1.0.jar"
RES="$ROOT/engine/forge/forge-gui/res"

[ -f "$JAR" ] || "$ROOT/scripts/build-engine.sh"
echo "building the client…"
(cd "$ROOT/client" && npm run build --silent)

rm -rf "$OUT" "$ROOT/dist/MTGClownfish.zip"
mkdir -p "$OUT/forge"
cp "$JAR" "$OUT/forge-bridge.jar"
cp -R "$ROOT/client/dist" "$OUT/client"
rm -f "$OUT/client/clownfishlog.png"  # the full-size source art; the start screen uses logo.webp
echo "copying Forge's card data…"
# Forge's Adventure mode and its music aren't used here
rsync -a --exclude 'adventure/' --exclude 'music/' "$RES" "$OUT/forge/"

# ---- launchers ----
cat > "$OUT/Start MTGClownfish.command" <<'SH'
#!/usr/bin/env bash
# macOS: double-click to play. (First time macOS may block it: see README.txt.)
cd "$(dirname "$0")"
# a Java 17+: a registered JDK (Temurin's .pkg), then Homebrew's (not registered unless linked), then PATH
ok17() { [ -x "$1" ] && "$1" -version 2>&1 | grep -Eq 'version "(1[7-9]|[2-9][0-9])'; }
JAVA=""
for c in "$(/usr/libexec/java_home -v 17+ 2>/dev/null)/bin/java" /opt/homebrew/opt/openjdk*/bin/java /usr/local/opt/openjdk*/bin/java "$(command -v java 2>/dev/null)"; do
  if ok17 "$c"; then JAVA="$c"; break; fi
done
if [ -z "$JAVA" ]; then
  osascript -e 'display dialog "MTGClownfish needs Java 17 or newer.\n\nInstall it from adoptium.net (Temurin 21, the .pkg for your Mac), then open this again." buttons {"OK"} with icon caution' >/dev/null
  open "https://adoptium.net/temurin/releases/?version=21"
  exit 1
fi
echo "Starting MTGClownfish… (leave this window open while you play; close it to quit)"
"$JAVA" -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT INT TERM
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:7780/ && break; sleep 1; done
open "http://127.0.0.1:7780/"
wait $BRIDGE
SH
chmod +x "$OUT/Start MTGClownfish.command"

cat > "$OUT/start.sh" <<'SH'
#!/usr/bin/env bash
# Linux: run ./start.sh, then open http://127.0.0.1:7780/ if no browser opens.
cd "$(dirname "$0")"
command -v java >/dev/null 2>&1 || { echo "MTGClownfish needs Java 17+ (e.g. sudo apt install openjdk-21-jre)"; exit 1; }
java -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT INT TERM
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:7780/ && break; sleep 1; done
xdg-open "http://127.0.0.1:7780/" >/dev/null 2>&1 || echo "Open http://127.0.0.1:7780/ in your browser"
wait $BRIDGE
SH
chmod +x "$OUT/start.sh"

cat > "$OUT/Start MTGClownfish.bat" <<'BAT'
@echo off
rem Windows: double-click to play. Leave the black window open while you play; close it to quit.
cd /d "%~dp0"
rem needs Java 17+: an old Java 8 ("1.8.0_...") reads as major version 1
set JMAJ=0
set JVER=
for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /i "version"') do set JVER=%%~v
if defined JVER for /f "delims=." %%m in ("%JVER%") do set JMAJ=%%m
if %JMAJ% LSS 17 (
  echo MTGClownfish needs Java 17 or newer. Install Temurin 21 from adoptium.net, then run this again.
  start "" "https://adoptium.net/temurin/releases/?version=21"
  pause
  exit /b 1
)
echo Starting MTGClownfish... the game opens in your browser when it's ready.
start "" /b java -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar
rem wait for the bridge to answer (up to a minute), then open the table
set /a TRIES=0
:waitloop
curl -s -o nul http://127.0.0.1:7780/ >nul 2>nul && goto ready
set /a TRIES+=1
if %TRIES% GEQ 60 goto ready
timeout /t 1 /nobreak >nul
goto waitloop
:ready
start "" "http://127.0.0.1:7780/"
echo Close this window to quit.
pause >nul
BAT

cat > "$OUT/README.txt" <<'TXT'
MTGClownfish — play Magic against Forge AI opponents (1v1 or 4-player Commander)

1. Install Java 17 or newer if you don't have it: https://adoptium.net (Temurin 21).
2. Start the game:
     macOS:   double-click "Start MTGClownfish.command"
              The first time, macOS may say it can't be opened. Then open
              System Settings > Privacy & Security, scroll down and click
              "Open Anyway" (on older macOS: right-click it > Open > Open).
     Windows: double-click "Start MTGClownfish.bat"
              If Windows SmartScreen warns you: More info > Run anyway.
              Allow Java through the firewall if asked (it only talks to
              your own computer).
     Linux:   run ./start.sh
3. The game opens in your browser at http://127.0.0.1:7780/ (Chrome, Safari, Firefox or Edge).
   Keep the launcher window open while you play; close it to quit.

Card images come from Scryfall, so you need an internet connection.
Each game is recorded in the logs/ folder — send it along when reporting a bug.

The rules engine is Forge (GPL-3.0, https://github.com/Card-Forge/forge).
TXT

# Windows' cmd misreads labels and goto in a batch file with Unix line endings; Notepad wants them for README too
perl -pi -e 's/\r?\n/\r\n/' "$OUT/Start MTGClownfish.bat" "$OUT/README.txt"

echo "zipping…"
(cd "$ROOT/dist" && zip -qry MTGClownfish.zip MTGClownfish -x '*.DS_Store')
du -sh "$OUT" "$ROOT/dist/MTGClownfish.zip"
echo "done: dist/MTGClownfish.zip"
