import './style.css';
import * as THREE from 'three';
import { Bridge } from './net';
import type { RequestMsg, ServerMsg, UpdateMsg } from './protocol';
import { Stage } from './scene/stage';
import { Table } from './game/table';
import { Input } from './game/input';
import { Hud } from './ui/hud';

const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement);
const table = new Table(stage);
const hud = new Hud();
// ?bridge=7778 points the client at another bridge instance (used for automated testing)
const bridgePort = new URLSearchParams(location.search).get('bridge') ?? '7777';
const bridge = new Bridge(`ws://127.0.0.1:${bridgePort}`);

let lastFormat: { format: 'constructed' | 'commander'; players: number } = { format: 'constructed', players: 2 };
let gameOverShown = false;

// Every server message runs in arrival order; updates await their animations so the
// player always sees what the AI did before being asked to respond.
const queue: ServerMsg[] = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const msg = queue.shift()!;
    const backlog = queue.filter((m) => m.type === 'update').length;
    table.timeScale = Math.min(5, 1 + backlog / 6);
    try {
      await handle(msg);
    } catch (err) {
      console.error('failed handling', msg, err);
    }
  }
  draining = false;
  refreshPrompt();
}

function refreshPrompt(): void {
  if (!table.state) return;
  hud.setPrompt(table.prompt, table.selection, draining && queue.length > 0);
  hud.setPhase(table.state, table.localId);
}

async function handle(msg: ServerMsg): Promise<void> {
  switch (msg.type) {
    case 'starting':
      hud.loading(`Shuffling up…\n${msg.decks.join('  vs  ')}`);
      break;
    case 'gameStarted':
      table.reset();
      hud.resetPlayers();
      table.localId = msg.you[0];
      gameOverShown = false;
      hud.closeOverlay();
      break;
    case 'update':
      await applyUpdate(msg);
      break;
    case 'request':
      await answer(msg);
      break;
    case 'notice':
      if (msg.kind === 'message' || msg.kind === 'error') hud.toast(msg.text ?? '', msg.kind);
      if (msg.kind === 'gameFinished') showGameOver();
      break;
  }
}

async function applyUpdate(msg: UpdateMsg): Promise<void> {
  await table.apply(msg);
  refreshPrompt();
  if (msg.state.gameOver) showGameOver();
}

async function answer(req: RequestMsg): Promise<void> {
  const value = await hud.request(req, table.state);
  bridge.respond(req.id, value);
}

function showGameOver(): void {
  const s = table.state;
  if (!s || gameOverShown || !s.gameOver) return;
  gameOverShown = true;
  const me = s.players.find((p) => p.id === table.localId);
  const won = !!me && s.winner === me.name;
  setTimeout(() => hud.gameOver(won, s.winner, () => startGame(lastFormat.format, lastFormat.players)), 900);
}

function startGame(format: 'constructed' | 'commander', players: number): void {
  lastFormat = { format, players };
  hud.loading('Starting game…');
  bridge.start(format, players);
}

bridge.onMessage((msg) => {
  if (msg.type === 'pong') return;
  queue.push(msg);
  void drain();
});
bridge.onStatus((connected) => hud.setConnection(connected));

hud.bind({
  ok: () => bridge.act({ action: 'ok' }),
  cancel: () => bridge.act({ action: 'cancel' }),
  player: (id) => bridge.act({ action: 'player', id }),
  passTurn: () => bridge.act({ action: 'passUntilEndOfTurn' }),
  concede: () => bridge.act({ action: 'concede' }),
});

new Input(stage, table, {
  clickCard: (id, button) => {
    const stackItem = table.stackItemFor(id);
    const targetsStack = stackItem != null && table.selection.targets.some((t) => t?.stack === stackItem);
    if (targetsStack) bridge.act({ action: 'stack', id: stackItem! });
    else bridge.act({ action: 'card', id, button });
  },
  hover: (id) => {
    const inHand = id != null && table.isLocalHand(id);
    table.hoveredHand = inHand ? id : null;
    table.relayout(0.16);
    const card = id != null ? table.cards.get(id)?.state ?? null : null;
    hud.showZoom(inHand ? null : card, 'left');
  },
});

// player plates track their table anchors every frame
stage.onTick(() => {
  const s = table.state;
  if (!s) return;
  const screen = new Map<number, { x: number; y: number }>();
  for (const p of s.players) {
    const w = table.playerWorld(p.id);
    if (w) screen.set(p.id, table.toScreen(new THREE.Vector3(w.x, w.y, w.z)));
  }
  hud.updatePlayers(s, table.localId, screen, table.targetablePlayers());
});

bridge.connect();
hud.menu(startGame);

// dev-only hook so the headless driver (scratch tooling) can read state and act like a player
if (import.meta.env.DEV) (window as unknown as { __debug: unknown }).__debug = { table, bridge };
