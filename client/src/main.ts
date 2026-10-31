import './style.css';
import * as THREE from 'three';
import { Bridge } from './net';
import type { RequestMsg, ServerMsg, UpdateMsg } from './protocol';
import { Stage } from './scene/stage';
import { Table } from './game/table';
import { Input } from './game/input';
import { CameraDirector } from './game/camera';
import { Hud } from './ui/hud';
import { sfx } from './audio';
import { DeckSetup, type GameSetup } from './ui/decks';

const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement);
const table = new Table(stage);
const hud = new Hud();
const director = new CameraDirector(stage);
table.onOpponentCast = (card, who) => hud.revealCast(card, `${who} casts ${card.name}`, 2200);
table.onPlayerHit = (pid, amount) => hud.hitPlate(pid, amount);
// ?bridge=7778 points the client at another bridge instance (used for automated testing)
const bridgePort = new URLSearchParams(location.search).get('bridge') ?? '7777';
const bridge = new Bridge(`ws://127.0.0.1:${bridgePort}`);

let lastSetup: GameSetup = { format: 'constructed', players: 2, decks: [], names: [] };
let gameOverShown = false;

/** seconds each phase stays lit before the next is shown (shorter while catching up) */
const PHASE_DWELL = 0.32;

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
    // play at normal speed unless well behind, and never rush past what is happening
    table.timeScale = Math.min(2.5, 1 + Math.max(0, backlog - 8) / 20);
    const phaseBefore = table.state ? `${table.state.turn}|${table.state.phase}` : '';
    const started = performance.now();
    try {
      await handle(msg);
    } catch (err) {
      console.error('failed handling', msg, err);
    }
    // every step of the turn gets a beat on screen, even when nothing happens in it (end of combat, end
    // step, the next player's untap and upkeep), so the turn visibly passes instead of jumping
    if (msg.type === 'update' && table.state && `${table.state.turn}|${table.state.phase}` !== phaseBefore) {
      const dwell = PHASE_DWELL / table.timeScale - (performance.now() - started) / 1000;
      if (dwell > 0.01) await new Promise((r) => setTimeout(r, dwell * 1000));
    }
  }
  draining = false;
  refreshPrompt();
}

function refreshPrompt(): void {
  if (!table.state) return;
  hud.setPrompt(table.prompt, table.selection, draining && queue.length > 0, table.state);
  // clicks from here on answer this prompt
  bridge.shownInput = table.prompt.inputId;
  hud.setPhase(table.state, table.localId);
  hud.setStack(table.state, table.localId);
  refreshBrowser();
}

/** Selectable cards that aren't on the table (library search etc.) get the browser overlay. */
function refreshBrowser(): void {
  const s = table.state!;
  const offTable = table.selection.cards.filter((id) => !table.cards.has(id) && s.cards[id]);
  const chosen = new Set(table.selection.chosen.map((r) => r?.card).filter((x): x is number => x != null));
  hud.setBrowser(
    offTable.length ? offTable.map((id) => s.cards[id]) : null,
    chosen,
    table.prompt.message ?? '',
    (id) => bridge.act({ action: 'card', id }),
  );
}

async function handle(msg: ServerMsg): Promise<void> {
  switch (msg.type) {
    case 'starting':
      hud.loading(`Shuffling up…\n${msg.decks.join('  vs  ')}`);
      break;
    case 'gameStarted':
      table.reset();
      director.reset();
      hud.setStack(null, -1);
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
      // a click landed after the game had moved on from what was on screen: it was dropped, not misapplied
      if (msg.kind === 'stale' && performance.now() - lastStaleToast > 4000) {
        lastStaleToast = performance.now();
        hud.toast('The table was still catching up, so that click was skipped. Try again.');
      }
      if (msg.kind === 'gameFinished') showGameOver();
      break;
  }
}

/**
 * Arena-style payment: right after the player casts a spell or activates an ability themselves, Forge's
 * mana prompt is answered with "Auto" (it spends floating mana first, then taps sources). Payment prompts
 * the player didn't start — "counter unless you pay" and the like — are left for them to decide.
 */
/** when the "click was skipped" toast last showed, so a burst of clicks gets one */
let lastStaleToast = 0;
let autoPayUntil = 0;
/** set once the cast has moved past plain priority (targets, payment…), so a later priority prompt means it's over */
let autoPayMovedOn = false;

function armAutoPay(): void {
  autoPayUntil = performance.now() + 30000;
  autoPayMovedOn = false;
}

function maybeAutoPay(msg: UpdateMsg): void {
  const p = msg.prompt;
  if (performance.now() > autoPayUntil || !p.ok?.enabled) return;
  if (p.input === 'InputPassPriority') {
    // a priority prompt right after the click is stale; one after targeting/payment means the cast ended
    if (autoPayMovedOn) autoPayUntil = 0;
    return;
  }
  autoPayMovedOn = true;
  if (p.input?.startsWith('InputPayMana')) {
    autoPayUntil = 0;
    // answers this payment prompt specifically, not whatever is on screen (or whatever Forge shows by the time
    // it lands). Flagged as automatic: if Forge's plan would sacrifice a source (Lotus Petal, a Treasure), the
    // bridge leaves the prompt up and says so, and the player taps their mana or presses Auto themselves.
    bridge.act({ action: 'ok', auto: true }, p.inputId);
  }
}

/**
 * Combat explanations. Forge skips the blockers step when you have nothing that can block, and a creature
 * with haste attacks the turn it arrives; both are easy to miss, so say so.
 */
const combatNotes = { turn: -1, blockPrompt: false, blockNote: false, arrived: new Set<number>(), hasteNoted: new Set<number>() };

function explainCombat(msg: UpdateMsg): void {
  const s = table.state;
  if (!s) return;
  if (s.turn !== combatNotes.turn) {
    Object.assign(combatNotes, { turn: s.turn, blockPrompt: false, blockNote: false });
    combatNotes.arrived.clear();
    combatNotes.hasteNoted.clear();
  }
  for (const e of msg.events) {
    const to = (e.to as { zone?: string } | null)?.zone;
    const card = (e.card as { card?: number } | null)?.card;
    if (e.event === 'CardChangeZone' && to === 'Battlefield' && card != null) combatNotes.arrived.add(card);
  }
  if (msg.prompt.input === 'InputBlock') combatNotes.blockPrompt = true;
  const attacks = s.combat ?? [];
  // haste: an opponent's creature attacking the turn it came in
  for (const a of attacks) {
    const c = s.cards[a.attacker];
    if (!c || c.controller === table.localId || combatNotes.hasteNoted.has(a.attacker)) continue;
    if (combatNotes.arrived.has(a.attacker) && c.keywords?.includes('Haste')) {
      combatNotes.hasteNoted.add(a.attacker);
      hud.toast(`${c.name} has haste — it can attack the turn it arrives`, 'message');
    }
  }
  // blocks skipped: you were attacked, combat is past declaring blockers, and you were never asked
  const late = s.phase === 'COMBAT_FIRST_STRIKE_DAMAGE' || s.phase === 'COMBAT_DAMAGE' || s.phase === 'COMBAT_END';
  const atMe = attacks.filter((a) => a.defender?.player === table.localId);
  if (late && atMe.length && !combatNotes.blockPrompt && !combatNotes.blockNote) {
    combatNotes.blockNote = true;
    const me = s.players.find((p) => p.id === table.localId);
    const mine = (me?.zones.Battlefield ?? []).map((id) => s.cards[id]).filter((c) => c?.creature);
    const reasons = mine.flatMap((c) => (c!.cantBlock ? [`${c!.name} can't block`] : c!.tapped ? [`${c!.name} is tapped`] : []));
    const why = mine.length === 0 ? 'you have no creatures' : reasons.length ? reasons.join(', ') : 'none of your creatures can block these attackers';
    hud.toast(`No blocks possible: ${why}`, 'message');
  }
}

async function applyUpdate(msg: UpdateMsg): Promise<void> {
  if (msg.prompt.input !== 'InputAttack') attackGroup = [];
  maybeAutoPay(msg);
  const animating = table.apply(msg);
  // the camera turns toward what's about to happen while it animates
  director.update(table.state!, table.localId, msg.events, msg.selection, table.targetablePlayers());
  explainCombat(msg);
  await animating;
  refreshPrompt();
  if (msg.state.gameOver) showGameOver();
}

async function answer(req: RequestMsg): Promise<void> {
  if (req.kind !== 'reveal' || req.options?.length) sfx.chime();
  const value = await hud.request(req, table.state);
  bridge.respond(req.id, value);
}

function showGameOver(): void {
  const s = table.state;
  if (!s || gameOverShown || !s.gameOver) return;
  gameOverShown = true;
  const me = s.players.find((p) => p.id === table.localId);
  const won = !!me && s.winner === me.name;
  setTimeout(() => (won ? sfx.victory() : sfx.defeat()), 700);
  setTimeout(() => hud.gameOver(won, s.winner, () => startGame(lastSetup)), 900);
}

function startGame(setup: GameSetup): void {
  lastSetup = setup;
  hud.loading('Starting game…');
  bridge.start(setup.format, setup.players, undefined, setup.decks, setup.names);
}

const deckSetup = new DeckSetup(document.getElementById('hud')!, bridge);

function showMenu(): void {
  hud.menu(async (format, players, title) => {
    const setup = await deckSetup.open(format, players, title);
    if (setup) startGame(setup);
    else showMenu();
  });
}

bridge.onMessage((msg) => {
  if (msg.type === 'pong') return;
  queue.push(msg);
  void drain();
});
bridge.onStatus((connected) => hud.setConnection(connected));

/**
 * Declaring attackers in multiplayer: Forge sends clicked creatures at its "current defender" (the first
 * opponent until you pick another). Picking an opponent also re-aims the creatures you clicked since your
 * last pick, so "creatures, then opponent" works as well as "opponent, then creatures".
 */
let attackGroup: number[] = [];

function trackAttacker(id: number): void {
  if (!table.isDeclaringAttack()) return;
  const c = table.state?.cards[id];
  if (!c || c.controller !== table.localId || c.zone !== 'Battlefield') return;
  // clicking an attacker that's already aimed where you're pointing takes it back out
  const i = attackGroup.indexOf(id);
  if (i >= 0) attackGroup.splice(i, 1);
  else attackGroup.push(id);
}

/** Pick a player (or a planeswalker/battle card) to attack, taking the pending group along. */
function chooseDefender(pick: () => void): void {
  pick();
  if (table.isDeclaringAttack()) {
    for (const id of attackGroup) if (table.state?.cards[id]?.attacking) bridge.act({ action: 'card', id });
  }
  attackGroup = [];
}

function pickPlayer(id: number): void {
  if (table.isDeclaringAttack()) chooseDefender(() => bridge.act({ action: 'player', id }));
  else bridge.act({ action: 'player', id });
}

hud.bind({
  ok: () => bridge.act({ action: 'ok' }),
  cancel: () => bridge.act({ action: 'cancel' }),
  // a plate click picks that player when the engine is asking for one; otherwise the camera goes to
  // their side (clicking the player already shown goes back to the whole table)
  player: (id) => {
    if (!director.multiplayer || table.targetablePlayers().has(id)) return pickPlayer(id);
    if (director.isShowing(id)) director.showTable();
    else director.focusPlayer(id);
  },
  passTurn: () => bridge.act({ action: 'passUntilEndOfTurn', turn: table.state?.turn }),
  concede: () => bridge.act({ action: 'concede' }),
});

const input = new Input(stage, table, {
  clickCard: (id, button) => {
    // a graveyard or exile card you can't use right now opens that whole pile
    const pileCard = table.state?.cards[id];
    const usableNow = table.selection.cards.includes(id) || table.selection.actionable.includes(id);
    if (button === 1 && pileCard && (pileCard.zone === 'Graveyard' || pileCard.zone === 'Exile')) {
      // piles are drawn stacked, so a click lands on the top card: when more than one card in the pile could be
      // used (Animate Dead's targets), open the pile and let the player choose rather than taking the top one
      const pileOwner = table.state?.players.find((p) => p.id === (pileCard.owner ?? pileCard.controller));
      const zoneIds = pileOwner?.zones[pileCard.zone] ?? [];
      const usableInPile = zoneIds.filter((z) => table.selection.cards.includes(z) || table.selection.actionable.includes(z)).length;
      if (!usableNow || usableInPile > 1) {
        openPile(pileCard.owner ?? pileCard.controller, pileCard.zone);
        return;
      }
    }
    const stackItem = table.stackItemFor(id);
    const targetsStack = stackItem != null && table.selection.targets.some((t) => t?.stack === stackItem);
    if (targetsStack) {
      bridge.act({ action: 'stack', id: stackItem! });
      return;
    }
    // aiming at a player but clicked one of their cards (that isn't itself a choice): target the player
    const sel = table.selection;
    const owner = table.cards.get(id)?.state.controller;
    // (a planeswalker or battle you're declaring attacks on is clicked itself)
    const attackable = table.isDeclaringAttack() && /Planeswalker|Battle/.test(table.cards.get(id)?.state.typeLine ?? '');
    if (!sel.cards.includes(id) && !attackable && owner != null && table.targetablePlayers().has(owner)) {
      pickPlayer(owner);
      return;
    }
    if (attackable && owner !== table.localId) {
      chooseDefender(() => bridge.act({ action: 'card', id }));
      return;
    }
    if (table.isDeclaringAttack()) {
      trackAttacker(id);
      bridge.act({ action: 'card', id, button });
      return;
    }
    // casting from hand or activating a non-land permanent arms auto-pay for the payment prompt that follows;
    // tapping a land for mana (picking colours up front) doesn't
    const c = table.cards.get(id)?.state;
    const paying = table.prompt.input?.startsWith('InputPayMana');
    if (c && !paying && button === 1 && !c.land && (table.isLocalHand(id) || c.zone === 'Battlefield' || c.zone === 'Command')) {
      armAutoPay();
    }
    bridge.act({ action: 'card', id, button });
  },
  clickTable: (pid) => {
    if (table.targetablePlayers().has(pid)) pickPlayer(pid);
  },
  hover: (id) => {
    const inHand = id != null && table.isLocalHand(id);
    if (inHand && id !== table.hoveredHand) sfx.hover();
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
  hud.updatePlayers(table.shownState() ?? s, table.localId, screen, table.targetablePlayers(), table.currentDefender());
});

function openPile(pid: number | null, zone: 'Graveyard' | 'Exile'): void {
  const s = table.state;
  const p = s?.players.find((x) => x.id === pid);
  if (!s || !p) return;
  const cards = p.zones[zone].map((id) => s.cards[id]).filter((c): c is NonNullable<typeof c> => !!c);
  const usable = new Set([...table.selection.cards, ...table.selection.actionable].filter((id) => p.zones[zone].includes(id)));
  const whose = p.id === table.localId ? 'Your' : `${p.name}'s`;
  hud.showPile(`${whose} ${zone === 'Graveyard' ? 'graveyard' : 'exile'}`, cards, usable, (id) => bridge.act({ action: 'card', id }));
}

// ---- camera views (multiplayer) ----
function refreshViewBar(): void {
  if (!director.multiplayer || !table.state) return hud.viewBar(null, viewHandlers);
  const names = new Map(table.state.players.map((p) => [p.id, p.name]));
  const showing = director.isShowing('table') ? 'table' : director.seats.find((f) => director.isShowing(f.playerId))?.playerId ?? null;
  hud.viewBar({ seats: director.seats.map((f) => ({ id: f.playerId, name: names.get(f.playerId) ?? '?', local: f.local })), showing, auto: director.auto }, viewHandlers);
}
const viewHandlers = {
  table: () => director.showTable(),
  seat: (id: number) => director.focusPlayer(id),
  auto: (on: boolean) => director.setAuto(on),
};
director.onChange = refreshViewBar;

window.addEventListener('keydown', (e) => {
  if (!director.multiplayer || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('.modal') || (e.target as HTMLElement).closest?.('input, textarea, select')) return;
  if (e.key === '0' || e.key === '`') director.showTable();
  else if (/^[1-4]$/.test(e.key)) {
    const seat = director.seats[Number(e.key) - 1];
    if (seat) director.focusPlayer(seat.playerId);
  } else if (e.key === 'c' || e.key === 'C') director.setAuto(!director.auto);
});

// wheel in over a player's side to look at it, wheel out for the whole table
let wheelAt = 0;
stage.renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    if (!director.multiplayer) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 450 || Math.abs(e.deltaY) < 4) return;
    wheelAt = now;
    if (e.deltaY > 0) return director.showTable();
    const hit = input.tablePoint(e.clientX, e.clientY);
    const pid = hit ? table.playerAt(hit) : null;
    if (pid != null) director.focusPlayer(pid);
  },
  { passive: false },
);

bridge.connect();
showMenu();

// dev-only hook so the headless driver (scratch tooling) can read state and act like a player
if (import.meta.env.DEV) (window as unknown as { __debug: unknown }).__debug = { table, bridge, input, stage, sfx, director, queue: () => ({ pending: queue.length, draining }), autoPayArmed: () => performance.now() < autoPayUntil };
