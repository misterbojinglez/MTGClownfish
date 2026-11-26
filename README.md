# MTGClownfish

A Magic: The Gathering table with an Arena-style 3D client and Forge AI opponents: 1v1 or 4-player Commander
against the AI, or online with friends through a relay. Ships as a desktop app (Electron) for macOS and Windows.
Picking the project up? Start with [docs/handoff.md](docs/handoff.md).

```
client/   Three.js 3D table + HTML HUD (TypeScript, Vite)
bridge/   Java WebSocket bridge: runs Forge headless and speaks JSON to the client
relay/    Cloudflare Worker for online lobbies
desktop/  Electron shell that packages the bridge, a Java runtime and the client
engine/   Forge (fetched by scripts/build-engine.sh at the commit in engine/FORGE_REV, not committed),
          plus engine/patches/: our fixes to Forge itself, applied by the build
scripts/  build + smoke-test helpers
docs/     protocol and Arena reference notes
```

## Running

```sh
scripts/build-engine.sh                      # once: clone + build Forge, build the bridge jar
java -jar bridge/target/forge-bridge-0.1.0.jar   # starts ws://127.0.0.1:7777
node scripts/smoke-test.mjs commander 4      # optional: plays a whole game headless
```

Card images come from Scryfall. Rules, cards and AI come from [Forge](https://github.com/Card-Forge/forge) (GPL-3.0).
