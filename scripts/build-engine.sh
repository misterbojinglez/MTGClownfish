#!/usr/bin/env bash
# Builds Forge's engine modules and the WebSocket bridge into bridge/target/forge-bridge-0.1.0.jar.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"

# the Forge commit the bridge and the patches are made against (engine/FORGE_REV); moving to a newer Forge
# is changing that file, then fixing whatever patch or bridge code no longer fits
FORGE_REV=$(tr -d '[:space:]' < "$ROOT/engine/FORGE_REV")
if [ ! -d "$ROOT/engine/forge" ]; then
  git init -q "$ROOT/engine/forge"
  git -C "$ROOT/engine/forge" remote add origin https://github.com/Card-Forge/forge.git
fi

cd "$ROOT/engine/forge"
if [ "$(git rev-parse -q --verify HEAD || true)" != "$FORGE_REV" ]; then
  echo "checking out Forge ${FORGE_REV:0:11}"
  # a checkout at another commit: take our patches back off first, so only Forge's own files change
  for patch in $(ls -r "$ROOT"/engine/patches/*.patch 2>/dev/null); do
    git apply --reverse --check "$patch" 2>/dev/null && git apply --reverse "$patch"
  done
  if [ -n "$(git status --porcelain)" ]; then
    echo "engine/forge has changes that aren't in engine/patches; save or discard them, then run this again" >&2
    exit 1
  fi
  git fetch -q --depth 1 origin "$FORGE_REV"
  git checkout -q --detach "$FORGE_REV"
fi
# our fixes to Forge itself (engine/patches/*.patch, in order), for bugs the bridge can't work around from
# outside; each is applied once, so this can run again on the same checkout. A patch that no longer applies
# (Forge changed under it, or fixed it upstream) stops the build rather than going missing
for patch in "$ROOT"/engine/patches/*.patch; do
  [ -e "$patch" ] || continue
  if git apply --reverse --check "$patch" 2>/dev/null; then
    continue
  elif git apply --check "$patch" 2>/dev/null; then
    git apply "$patch"
    echo "applied $(basename "$patch")"
  else
    echo "engine/patches/$(basename "$patch") doesn't apply to this Forge checkout: update or remove it" >&2
    exit 1
  fi
done
REV=$(mvn -q -N help:evaluate -Dexpression=revision -DforceStdout 2>/dev/null || true)
mvn -q -B -N install -Dcheckstyle.skip
mvn -q -B -pl forge-gui -am install -DskipTests -Dcheckstyle.skip

# Forge publishes POMs with an unresolved ${revision}; pin it so other projects can depend on them.
REV=${REV:-$(ls ~/.m2/repository/forge/forge-gui | grep SNAPSHOT | sort -V | tail -1)}
find ~/.m2/repository/forge -name "*.pom" -exec sed -i '' "s/\${revision}/$REV/g" {} +
mkdir -p ~/.m2/repository/forge/forge/"$REV"
cp pom.xml ~/.m2/repository/forge/forge/"$REV"/forge-"$REV".pom
sed -i '' "s/\${revision}/$REV/g" ~/.m2/repository/forge/forge/"$REV"/forge-"$REV".pom

cd "$ROOT/bridge"
mvn -q -B package -Dforge.version="$REV"
echo "built $ROOT/bridge/target/forge-bridge-0.1.0.jar (Forge $REV)"
