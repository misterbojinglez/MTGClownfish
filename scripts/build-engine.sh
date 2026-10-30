#!/usr/bin/env bash
# Builds Forge's engine modules and the WebSocket bridge into bridge/target/forge-bridge-0.1.0.jar.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"

if [ ! -d "$ROOT/engine/forge" ]; then
  git clone --depth 1 https://github.com/Card-Forge/forge.git "$ROOT/engine/forge"
fi

cd "$ROOT/engine/forge"
REV=$(mvn -q -N help:evaluate -Dexpression=revision -DforceStdout 2>/dev/null || true)
mvn -q -B -N install -Dcheckstyle.skip
mvn -q -B -pl forge-gui -am install -DskipTests -Dcheckstyle.skip

# Forge publishes POMs with an unresolved ${revision}; pin it so other projects can depend on them.
REV=${REV:-$(ls ~/.m2/repository/forge/forge-gui | grep SNAPSHOT | head -1)}
find ~/.m2/repository/forge -name "*.pom" -exec sed -i '' "s/\${revision}/$REV/g" {} +
mkdir -p ~/.m2/repository/forge/forge/"$REV"
cp pom.xml ~/.m2/repository/forge/forge/"$REV"/forge-"$REV".pom
sed -i '' "s/\${revision}/$REV/g" ~/.m2/repository/forge/forge/"$REV"/forge-"$REV".pom

cd "$ROOT/bridge"
mvn -q -B package -Dforge.version="$REV"
echo "built $ROOT/bridge/target/forge-bridge-0.1.0.jar (Forge $REV)"
