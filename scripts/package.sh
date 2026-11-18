#!/usr/bin/env bash
# Builds the MTGClownfish desktop app, one per platform, each with its own Java runtime, so players install
# nothing:
#   dist/MTGClownfish-mac-apple-silicon.zip   (M1 and newer Macs)    MTGClownfish.app
#   dist/MTGClownfish-mac-intel.zip           (older Macs)           MTGClownfish.app
#   dist/MTGClownfish-windows.zip             (64-bit Windows)       MTGClownfish.exe
# The app (desktop/, Electron) starts the bridge out of sight and shows the game in its own window. Its game/
# resources hold the bridge (Forge included), Forge's card data, the built client (which the bridge serves) and
# a trimmed Java runtime (jlink'd from Eclipse Temurin).
#
# Temurin JDKs are downloaded once into dist/.jdk (checksums verified), Electron once into its own cache. This
# must run on an Apple Silicon Mac: its JDK's jlink builds all three runtimes (jlink can target other platforms
# from their jmods, same version), and the Macs' apps are signed (ad hoc) with its codesign.
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

# name  temurin-os  temurin-arch  electron-platform  electron-arch
TARGETS=(
  "mac-apple-silicon mac aarch64 darwin arm64"
  "mac-intel mac x64 darwin x64"
  "windows windows x64 win32 x64"
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
rm -f "$PAYLOAD/client/clownfishlog.png"  # the full-size source art; the start screen uses logo-large.webp / logo-360.webp
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

# ---- the desktop app's own dependencies (Electron, its packager) ----
(cd "$ROOT/desktop" && npm install --silent --no-audit --no-fund)
PACKAGER="$ROOT/desktop/node_modules/.bin/electron-packager"
VERSION=$(node -p "require('$ROOT/desktop/package.json').version")

readme() {
  local dir=$1 how=$2
  cat > "$dir/README.txt" <<TXT
MTGClownfish $VERSION: play Magic against Forge AI opponents (1v1 or 4-player Commander), or online with friends

Nothing else to install: the app brings everything it needs.

$how

Online: Main menu > Online > Host, then share the invite link. Friends who don't have the app can join from
a browser; friends who do can paste the code in Online > Join.

Card images come from Scryfall, so you need an internet connection.
Each game is recorded: Help > Open Game Logs. Please send the latest one along when reporting a bug
(and Help > Open Engine Log if the game stopped or wouldn't start).

The rules engine is Forge (GPL-3.0, https://github.com/Card-Forge/forge).
Java runtime: Eclipse Temurin (GPL-2.0 with Classpath Exception, https://adoptium.net). App shell: Electron (MIT).
TXT
}

MAC_HOW='To start:
  1. Drag MTGClownfish.app into your Applications folder, then open it from there.
  2. The first time, macOS says it can'"'"'t check the app for malicious software. Click Done, then open
     System Settings > Privacy & Security, scroll down and click "Open Anyway" next to MTGClownfish
     (on older macOS: right-click the app > Open > Open). After that it opens normally.'
WIN_HOW='To start:
  1. Unzip the whole folder somewhere (your Documents, say), not just the .exe.
  2. Open the folder and double-click MTGClownfish.exe.
  3. If Windows SmartScreen warns you: More info > Run anyway. It only does this the first time.'

# ---- one app per platform ----
rm -rf "$DIST/MTGClownfish" "$DIST/MTGClownfish.zip"
STAGE="$DIST/.stage"
for t in "${TARGETS[@]}"; do
  read -r name os arch eplat earch <<<"$t"
  home=$(fetch_jdk "$os" "$arch")
  echo "== $name"
  # the game files the app carries, with this platform's Java
  game="$STAGE/$name/game"
  rm -rf "$STAGE/$name"
  mkdir -p "$game"
  rsync -a "$PAYLOAD/" "$game/"
  "$JLINK" --module-path "$home/jmods" --add-modules "$MODULES" \
    --strip-debug --no-man-pages --no-header-files --compress=2 --output "$game/runtime"
  # jlink leaves some files read-only, which gets in the way of unzipping over an old copy or deleting it
  chmod -R u+w "$game/runtime"
  # its legal/ notices are symlinks between modules, which the packager would copy as links into this machine's
  # disk (and macOS won't sign an app with links leading out of it): make them plain files
  rsync -aL "$game/runtime/legal/" "$game/runtime/legal.real/"
  rm -rf "$game/runtime/legal"
  mv "$game/runtime/legal.real" "$game/runtime/legal"

  "$PACKAGER" "$ROOT/desktop" MTGClownfish --platform="$eplat" --arch="$earch" \
    --out="$STAGE/$name/electron" --overwrite --asar --icon="$ROOT/desktop/build/icon" \
    --extra-resource="$game" --app-bundle-id=app.mtgclownfish --app-version="$VERSION" \
    --app-copyright="MTGClownfish alpha" --win32metadata.ProductName=MTGClownfish \
    --win32metadata.FileDescription=MTGClownfish --ignore='^/node_modules' --quiet
  built="$STAGE/$name/electron/MTGClownfish-$eplat-$earch"

  out="$DIST/MTGClownfish-$name"
  rm -rf "$out" "$out.zip"
  mkdir -p "$out"
  case "$os" in
    mac)
      mv "$built/MTGClownfish.app" "$out/"
      # every binary on a Mac needs a valid signature (Apple Silicon won't run one without), and changing the
      # app's resources broke Electron's: sign the whole app again, ad hoc
      codesign --force --deep --sign - "$out/MTGClownfish.app"
      codesign --verify --deep --strict "$out/MTGClownfish.app"
      readme "$out" "$MAC_HOW"
      # ditto keeps the app's framework symlinks and permissions intact
      (cd "$DIST" && ditto -c -k --keepParent "MTGClownfish-$name" "MTGClownfish-$name.zip")
      ;;
    windows)
      mv "$built" "$out/MTGClownfish"
      readme "$out/MTGClownfish" "$WIN_HOW"
      # Notepad wants Windows line endings
      perl -pi -e 's/\r?\n/\r\n/' "$out/MTGClownfish/README.txt"
      (cd "$out" && zip -qry "../MTGClownfish-$name.zip" MTGClownfish -x '*.DS_Store')
      ;;
  esac
  du -sh "$out.zip"
done
rm -rf "$STAGE"
echo "done: $(cd "$DIST" && ls MTGClownfish-*.zip | tr '\n' ' ')"
