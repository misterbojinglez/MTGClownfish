#!/usr/bin/env bash
# Builds ready-to-run copies of MTGClownfish, one per platform, each with its own Java runtime, so players
# install nothing:
#   dist/MTGClownfish-mac-apple-silicon.zip   (M1 and newer Macs)
#   dist/MTGClownfish-mac-intel.zip           (older Macs)
#   dist/MTGClownfish-windows.zip             (64-bit Windows)
# Inside each: the bridge (Forge included), Forge's card data, the built client (which the bridge serves), a
# trimmed Java runtime (jlink'd from Eclipse Temurin), a launcher and a README.
#
# Temurin JDKs are downloaded once into dist/.jdk (checksums verified). This must run on an Apple Silicon Mac:
# its JDK's jlink builds all three runtimes (jlink can target other platforms from their jmods, same version).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
JAR="$ROOT/bridge/target/forge-bridge-0.1.0.jar"
RES="$ROOT/engine/forge/forge-gui/res"
PAYLOAD="$DIST/.payload"
JDKS="$DIST/.jdk"

# one exact Temurin build for every platform (jlink needs matching versions)
JDK_RELEASE="jdk-17.0.21+9"
# what the bridge uses (jdeps --print-module-deps), plus what jdeps can't see: TLS's elliptic curves (the relay,
# Claude, Scryfall), zip file systems, extra charsets, logging
MODULES="java.base,java.compiler,java.desktop,java.management,java.naming,java.net.http,java.scripting,java.security.jgss,java.sql,jdk.httpserver,jdk.sctp,jdk.unsupported,jdk.crypto.ec,jdk.zipfs,jdk.charsets,java.logging"

# name  temurin-os  temurin-arch
TARGETS=(
  "mac-apple-silicon mac aarch64"
  "mac-intel mac x64"
  "windows windows x64"
)

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "package.sh runs on an Apple Silicon Mac (its jlink builds every runtime)"; exit 1; }
[ -f "$JAR" ] || "$ROOT/scripts/build-engine.sh"

# ---- the game itself, shared by every platform ----
echo "building the client…"
(cd "$ROOT/client" && npm run build --silent)
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/forge"
cp "$JAR" "$PAYLOAD/forge-bridge.jar"
cp -R "$ROOT/client/dist" "$PAYLOAD/client"
rm -f "$PAYLOAD/client/clownfishlog.png"  # the full-size source art; the start screen uses logo.webp
echo "copying Forge's card data…"
# Forge's Adventure mode and its music aren't used here
rsync -a --exclude 'adventure/' --exclude 'music/' "$RES" "$PAYLOAD/forge/"

# ---- Temurin JDKs (downloaded once, checksum-verified) ----
# prints the JDK's home directory (where bin/ and jmods/ are)
fetch_jdk() {
  local os=$1 arch=$2 dir="$JDKS/$1-$2"
  if [ ! -f "$dir/.ok" ]; then
    local api="https://api.adoptium.net/v3/assets/release_name/eclipse/${JDK_RELEASE/+/%2B}?architecture=$arch&image_type=jdk&os=$os&jvm_impl=hotspot&heap_size=normal&vendor=eclipse"
    local meta link sum name
    meta=$(curl -fsSL "$api")
    link=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["binaries"][0]["package"]["link"])' <<<"$meta")
    sum=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["binaries"][0]["package"]["checksum"])' <<<"$meta")
    name=$(basename "$link")
    rm -rf "$dir"
    mkdir -p "$dir"
    echo "downloading ${name}…" >&2
    curl -fL --progress-bar -o "$dir/$name" "$link"
    echo "$sum  $dir/$name" | shasum -a 256 -c - >&2
    case "$name" in
      *.zip) (cd "$dir" && unzip -q "$name") ;;
      *) (cd "$dir" && tar xzf "$name") ;;
    esac
    rm -f "$dir/$name"
    touch "$dir/.ok"
  fi
  local home
  home=$(find "$dir" -maxdepth 4 -type d -name jmods -print -quit)
  dirname "$home"
}

HOST_JDK=$(fetch_jdk mac aarch64)
JLINK="$HOST_JDK/bin/jlink"

# ---- launchers and readme, per platform ----
mac_launcher() {
  cat > "$1/Start MTGClownfish.command" <<'SH'
#!/usr/bin/env bash
# macOS: double-click to play. (The first time macOS may block it: see README.txt.)
cd "$(dirname "$0")"
# the Java that comes with the game: out of a downloaded zip it's marked as quarantined, which would stop it running
xattr -dr com.apple.quarantine runtime 2>/dev/null || true
echo "Starting MTGClownfish… (leave this window open while you play; close it to quit)"
runtime/bin/java -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT INT TERM
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:7780/ && break; sleep 1; done
open "http://127.0.0.1:7780/"
wait $BRIDGE
SH
  chmod +x "$1/Start MTGClownfish.command"
}

windows_launcher() {
  cat > "$1/Start MTGClownfish.bat" <<'BAT'
@echo off
rem Windows: double-click to play. Leave the black window open while you play; close it to quit.
cd /d "%~dp0"
echo Starting MTGClownfish... the game opens in your browser when it's ready.
start "" /b "%~dp0runtime\bin\java.exe" -Xmx3g -Dforge.assets=forge -Dclient.dir=client -jar forge-bridge.jar
rem wait for the game to answer (up to a minute), then open the table
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
}

readme() {
  local dir=$1 how=$2
  cat > "$dir/README.txt" <<TXT
MTGClownfish — play Magic against Forge AI opponents (1v1 or 4-player Commander), or online with friends

Nothing to install: the game brings its own Java.

1. Start the game:
$how
2. The game opens in your browser at http://127.0.0.1:7780/ (Chrome, Safari, Firefox or Edge).
   Keep the launcher window open while you play; close it to quit.

Online: Main menu > Online > Host, then share the invite link. Friends only need a browser.

Card images come from Scryfall, so you need an internet connection.
Each game is recorded in the logs/ folder; send it along when reporting a bug.

The rules engine is Forge (GPL-3.0, https://github.com/Card-Forge/forge).
Java runtime: Eclipse Temurin (GPL-2.0 with Classpath Exception, https://adoptium.net).
TXT
}

MAC_HOW='     Double-click "Start MTGClownfish.command".
     The first time, macOS may say it can'"'"'t be opened. Then open
     System Settings > Privacy & Security, scroll down and click
     "Open Anyway" (on older macOS: right-click it > Open > Open).'
WIN_HOW='     Double-click "Start MTGClownfish.bat".
     If Windows SmartScreen warns you: More info > Run anyway.
     Allow Java through the firewall if asked (it only talks to
     your own computer and the game'"'"'s relay).'

# ---- one package per platform ----
# the old single, bring-your-own-Java package
rm -rf "$DIST/MTGClownfish" "$DIST/MTGClownfish.zip"
for t in "${TARGETS[@]}"; do
  read -r name os arch <<<"$t"
  home=$(fetch_jdk "$os" "$arch")
  out="$DIST/MTGClownfish-$name"
  echo "== $name"
  rm -rf "$out" "$out.zip"
  mkdir -p "$out"
  rsync -a "$PAYLOAD/" "$out/"
  "$JLINK" --module-path "$home/jmods" --add-modules "$MODULES" \
    --strip-debug --no-man-pages --no-header-files --compress=2 --output "$out/runtime"
  # jlink leaves some files read-only, which gets in the way of unzipping over an old copy or deleting it
  chmod -R u+w "$out/runtime"
  case "$os" in
    mac)
      # every binary on a Mac needs a valid signature (Apple Silicon won't run one without): re-sign the runtime
      codesign --force --deep --sign - "$out/runtime" >/dev/null 2>&1 || true
      mac_launcher "$out"
      readme "$out" "$MAC_HOW"
      ;;
    windows)
      windows_launcher "$out"
      readme "$out" "$WIN_HOW"
      # Windows' cmd misreads labels and goto in a batch file with Unix line endings; Notepad wants them too
      perl -pi -e 's/\r?\n/\r\n/' "$out/Start MTGClownfish.bat" "$out/README.txt"
      ;;
  esac
  (cd "$DIST" && zip -qry "MTGClownfish-$name.zip" "MTGClownfish-$name" -x '*.DS_Store')
  du -sh "$out.zip"
done
echo "done: $(cd "$DIST" && ls MTGClownfish-*.zip | tr '\n' ' ')"
