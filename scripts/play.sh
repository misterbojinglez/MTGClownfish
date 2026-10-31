#!/usr/bin/env bash
# Starts the Forge bridge and the 3D client, then opens the table in your browser. Ctrl+C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
JAR="$ROOT/bridge/target/forge-bridge-0.1.0.jar"

[ -f "$JAR" ] || "$ROOT/scripts/build-engine.sh"
[ -d "$ROOT/client/node_modules" ] || (cd "$ROOT/client" && npm install)

# run from a copy: rebuilding the bridge while a game is running would otherwise pull classes out from under it
RUN_JAR="$ROOT/bridge/target/run/forge-bridge.jar"
mkdir -p "$(dirname "$RUN_JAR")" && cp "$JAR" "$RUN_JAR"
"$JAVA_HOME/bin/java" -Xmx3g -Dforge.assets="$ROOT/engine/forge/forge-gui" -jar "$RUN_JAR" &
BRIDGE=$!
(cd "$ROOT/client" && npx vite --host 127.0.0.1) &
VITE=$!
trap 'kill $BRIDGE $VITE 2>/dev/null' EXIT INT TERM

sleep 2
open "http://127.0.0.1:5173/"
wait
