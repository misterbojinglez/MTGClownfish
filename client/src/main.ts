import './style.css';
import './theme.css';
import * as THREE from 'three';
import gsap from 'gsap';
import { Bridge } from './net';
import type { CardState, GameState, RequestMsg, ServerMsg, UpdateMsg } from './protocol';
import { stackKey } from './scene/layout';
import { Stage } from './scene/stage';
import { Table } from './game/table';
import { Input, type AimTarget } from './game/input';
import { CameraDirector } from './game/camera';
import { Hud } from './ui/hud';
import { sfx } from './audio';
import { claudeKey, DeckSetup, type GameSetup } from './ui/decks';
import { askName, joinScreen, LobbyView, onlineChooser } from './ui/lobby';

const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement);
const table = new Table(stage);
const hud = new Hud();
const director = new CameraDirector(stage);
table.onOpponentCast = (card, who) => hud.revealCast(card, `${who} casts ${card.name}`, 2200);
table.onPlayerHit = (pid, amount) => hud.hitPlate(pid, amount);
// ?bridge=7778 points the client at another bridge instance (used for automated testing)
const bridgePort = new URLSearchParams(location.search).get('bridge') ?? '7777';
/**
 * Served by the relay (a friend opened an invite): there's no rules engine on this computer, so the page joins
 * the host's game through the relay. Anywhere else (the dev server, the bridge's own server) it's the full app.
 */
const onRelay = new URLSearchParams(location.search).has("relay") || !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
const relaySocket = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const bridge = new Bridge(`ws://127.0.0.1:${bridgePort}`);
/** the relay's web address (from the bridge's welcome), for "Join a friend's game" */
let relayHttp: string | null = onRelay ? `${location.protocol}//${location.host}` : null;

let lastSetup: GameSetup = { format: 'constructed', players: 2, decks: [], names: [] };
let gameOverShown = false;

/** seconds each phase stays lit before the next is shown (shorter while catching up) */
const PHASE_DWELL = 0.32;

// Every server message runs in arrival order; updates await their animations so the
// player always sees what the AI did before being asked to respond.
const queue: ServerMsg[] = [];
let draining = false;

/** queued updates (back to back, no decision between) at which the client stops animating each one */
const CATCHUP_AT = 24;
/** the newest updates still played out when catching up */
const KEEP_ANIMATED = 6;
/** seconds the outcome of combat damage holds on screen */
const COMBAT_RESULT_HOLD = 1.0;

/** events the player should see happen: updates carrying them are never folded into a catch-up */
const SHOWN_EVENTS = new Set(['PlayerDamaged', 'CardDamaged', 'PlayerLivesChanged', 'SpellAbilityCast', 'TurnBegan']);

/** Whether an update shows something happening, rather than routine bookkeeping. */
function worthSeeing(m: UpdateMsg): boolean {
  for (const e of m.events) {
    if (SHOWN_EVENTS.has(e.event)) return true;
    if (e.event === 'CardChangeZone') {
      const from = (e.from as { zone?: string } | null)?.zone;
      const to = (e.to as { zone?: string } | null)?.zone;
      if (from === 'Battlefield' || to === 'Battlefield' || to === 'Stack') return true;
    }
  }
  // attackers or blockers being declared show up as cards newly attacking or blocking
  for (const c of Object.values(m.state.cards)) {
    const was = table.state?.cards[c.id];
    if ((c.attacking && !was?.attacking) || (c.blocking && !was?.blocking)) return true;
  }
  return false;
}

/**
 * Several updates as one: card changes merged in order (each update carries only what changed), everything
 * else from the newest. Only the newest one's events are kept, plus the last turn start so the camera
 * still knows whose turn it is.
 */
function mergeUpdates(msgs: UpdateMsg[]): UpdateMsg {
  const last = msgs[msgs.length - 1];
  const cards: UpdateMsg['state']['cards'] = {};
  for (const m of msgs) Object.assign(cards, m.state.cards);
  const events = [...last.events];
  const turnBegan = msgs.flatMap((m) => m.events).filter((e) => e.event === 'TurnBegan').pop();
  if (turnBegan && !events.includes(turnBegan)) events.unshift(turnBegan);
  return { ...last, events, state: { ...last.state, cards } };
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length) {
    let msg = queue.shift()!;
    // far behind (a big board's turns produce updates faster than they can be shown): jump ahead to the
    // newest few, applying everything in between at once, instead of falling further behind all game
    // Only routine updates are folded (phase steps, priority passes, bookkeeping); anything worth seeing
    // (combat, damage, life, casts, creatures arriving or dying) always plays out.
    if (msg.type === 'update' && !worthSeeing(msg)) {
      let run = 0;
      while (run < queue.length && queue[run].type === 'update') run++;
      if (run >= CATCHUP_AT) {
        let quiet = 0;
        while (quiet < run - KEEP_ANIMATED && !worthSeeing(queue[quiet] as UpdateMsg)) quiet++;
        if (quiet > 0) msg = mergeUpdates([msg, ...(queue.splice(0, quiet) as UpdateMsg[])]);
      }
    }
    const backlog = queue.filter((m) => m.type === 'update').length;
    // play at normal speed unless well behind, never rush past what is happening, and combat damage always
    // at full length: it's what the player most needs to take in
    const combatHit = msg.type === 'update' && msg.events.some((e) => table.isCombatDamage(e));
    table.timeScale = combatHit ? 1 : Math.min(1.75, 1 + Math.max(0, backlog - 8) / 30);
    const phaseBefore = table.state ? `${table.state.turn}|${table.state.phase}` : '';
    const started = performance.now();
    try {
      await handle(msg);
    } catch (err) {
      console.error('failed handling', msg, err);
    }
    // every step of the turn gets a beat on screen, even when nothing happens in it (end of combat, end
    // step, the next player's untap and upkeep), so the turn visibly passes instead of jumping
    // the result of combat damage stays up for a moment (life totals, deaths) before the game moves on
    if (combatHit) await new Promise((r) => setTimeout(r, COMBAT_RESULT_HOLD * 1000));
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
  askLifeIfNoMana();
  hud.setPhase(table.state, table.localId);
  hud.setStack(table.state, table.localId);
  refreshBrowser();
}

/**
 * Paying a cost whose only unpaid symbols life can pay (Phyrexian mana, K'rrik's {B}), and Forge's Auto
 * can't pay them with mana: there's no mana left that could, so ask whether to pay it all with life.
 * Checked again after a beat, so a passing in-between update (buttons reset mid-refresh) doesn't ask.
 */
let lifeAsked = '';
let lifeTimer = 0;
function askLifeIfNoMana(): void {
  const p = table.prompt;
  const lp = p.lifePay;
  if (!lp) hud.dismissLifePayment();
  const due = () => {
    const q = table.prompt;
    const l = q.lifePay;
    if (!l || !l.onlyLife || q.ok?.enabled || (draining && queue.length > 0)) return null;
    const total = l.shards * l.each;
    if (l.life - l.committed < total) return null;
    return { key: `${q.inputId}|${l.shards}`, total, l, inputId: q.inputId };
  };
  const first = due();
  if (!first || first.key === lifeAsked) return;
  clearTimeout(lifeTimer);
  lifeTimer = window.setTimeout(() => {
    const now = due();
    if (!now || now.key !== first.key || now.key === lifeAsked) return;
    lifeAsked = now.key;
    hud.confirmLifePayment(now.total, now.l.life - now.l.committed, () => {
      for (let i = 0; i < now.l.shards; i++) bridge.act({ action: 'player', id: now.l.player }, now.inputId);
    });
  }, 300);
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
      inGame = true;
      // the game HUD (phase tracker, buttons, stack) only shows during a game
      document.body.classList.add('in-game');
      table.reset();
      director.reset();
      hud.setStack(null, -1);
      hud.resetPlayers();
      table.localId = msg.you[0];
      gameOverShown = false;
      hud.closeOverlay();
      break;
    case 'update':
      if (!inGame) break;
      await applyUpdate(msg);
      break;
    case 'request':
      if (!inGame) break;
      await answer(msg);
      break;
    case 'welcome':
      if (msg.relay !== undefined) relayHttp = msg.relay ?? null;
      break;
    case 'lobby':
      // drawn now unless a game is on screen (then when the player leaves it)
      if (!inGame) {
        hud.closeOverlay();
        document.querySelectorAll('.modal:not(.deck-modal)').forEach((m) => m.remove());
      }
      lobby.update(msg, !inGame);
      break;
    case 'lobbyClosed':
      lobby.clear();
      if (inGame) leaveTable();
      if (onRelay) showJoin(msg.reason);
      else {
        hud.toast(msg.reason, 'error');
        showMenu();
      }
      break;
    case 'notice':
      if (msg.kind === 'message' || msg.kind === 'error') hud.toast(msg.text ?? '', msg.kind);
      // the host ended an online game: back to the lobby
      if (msg.kind === 'gameAbandoned') {
        hud.toast(msg.text ?? 'The game was ended.', 'message');
        leaveTable();
        backToLobbyOrMenu();
      }
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
    // Phyrexian mana: mana or life is the player's choice (Auto, or the Pay 2 life button)
    if (p.lifePay) return;
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
  // a box-selected group lasts only while declaring (the table's refresh below redraws without it)
  if (msg.prompt.input !== 'InputAttack' && msg.prompt.input !== 'InputBlock') table.group.clear();
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
  // the API key goes along only when an opponent has a gameplan (one the setup screen didn't get to translate)
  const planned = setup.decks.some((d, i) => i > 0 && d?.gameplan);
  bridge.start(setup.format, setup.players, undefined, setup.decks, setup.names, planned ? claudeKey() || undefined : undefined);
}

const deckSetup = new DeckSetup(document.getElementById('hud')!, bridge);

/** Whether a game is on: once you've left one, its last updates are ignored until the next game starts. */
let inGame = false;

/** Leave the game: stop it on the bridge, clear the table, and go back to the main menu. */
function exitToMenu(): void {
  bridge.endGame();
  leaveTable();
  backToLobbyOrMenu();
}

/** Clear the table and the game HUD (the game is over, abandoned, or left). */
function leaveTable(): void {
  inGame = false;
  document.body.classList.remove('in-game');
  queue.length = 0;
  table.reset();
  director.reset();
  hud.resetPlayers();
  hud.setStack(null, -1);
  hud.closeOverlay();
  document.querySelectorAll('.modal').forEach((m) => m.remove());
}

/** After a game: an online table goes back to its lobby; otherwise the main menu. */
function backToLobbyOrMenu(): void {
  if (lobby.current) lobby.show();
  else showMenu();
}

function showMenu(): void {
  if (onRelay) return showJoin(null);
  hud.menu(
    async (format, players, title) => {
      const setup = await deckSetup.open(format, players, title);
      if (setup) startGame(setup);
      else showMenu();
    },
    () => onlineChooser(document.getElementById('hud')!, relayHttp, (format, players) => void hostOnline(format, players)),
  );
}

/** Host an online game: your name, then the bridge opens a lobby on the relay and the code comes back. */
async function hostOnline(format: 'constructed' | 'commander', players: number): Promise<void> {
  const name = await askName(document.getElementById('hud')!, 'Your name at the table', 'Open lobby');
  if (!name) return;
  hud.closeOverlay();
  hud.loading('Opening the lobby…');
  bridge.hostLobby(format, players, name);
}

/** The relay's page: join a friend's game by code (?join=CODE fills it in). */
function showJoin(message: string | null): void {
  const prefill = new URLSearchParams(location.search).get('join') ?? '';
  joinScreen(document.getElementById('hud')!, prefill, message, (code) => {
    hud.loading('Joining…');
    bridge.setUrl(`${relaySocket}/join/${code}`);
  });
}

const lobby = new LobbyView(document.getElementById('hud')!, bridge, deckSetup, (text, kind) => hud.toast(text, kind));
lobby.onLeave = () => {
  if (onRelay) showJoin(null);
  else showMenu();
};
// a friend's game that's gone for good (no such code, the host left): back to the join screen
bridge.onClosed((reason) => {
  lobby.clear();
  if (inGame) leaveTable();
  showJoin(reason);
});

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

/**
 * Whether one of your creatures can be dragged into combat right now, and how. strict (for a selection box):
 * also leave out creatures that plainly can't, so a sweep across the board picks only the ones that will go.
 */
function declarable(id: number, strict: boolean): 'attack' | 'block' | null {
  const c = table.state?.cards[id];
  if (!c || c.zone !== 'Battlefield' || !c.creature || c.controller !== table.localId) return null;
  if (table.isDeclaringAttack()) {
    if (c.attacking) return 'attack';
    if (c.tapped) return null;
    if (strict && (c.sick || c.keywords?.includes('Defender'))) return null;
    return 'attack';
  }
  if (table.isDeclaringBlock() && !c.tapped && !c.attacking && !c.cantBlock) return 'block';
  return null;
}

/** Card names for a message, with repeats counted: "Soldier Token ×5, Elspeth's Knight". */
function nameList(ids: number[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const name = table.state?.cards[id]?.name || 'a creature';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', ');
}

/**
 * Forge turns down an illegal declaration without a word: once the table has caught up with Forge (so a
 * declaration still animating in isn't mistaken for one refused), name the creatures that didn't make it.
 */
function reportRefused(ids: number[], stillDeclaring: () => boolean, made: (s: GameState, id: number) => boolean, say: (names: string) => string): void {
  let tries = 0;
  const check = () => {
    if ((draining || queue.length > 0) && ++tries < 10) {
      setTimeout(check, 300);
      return;
    }
    const now = table.state;
    if (!now || !stillDeclaring()) return;
    const refused = ids.filter((id) => now.cards[id] && !made(now, id));
    if (refused.length) hud.toast(say(nameList(refused)), 'message');
  };
  setTimeout(check, 700);
}

/** Send creatures (one, or a box-selected group) to attack a player, planeswalker or battle. */
function attackWith(ids: number[], target: AimTarget): void {
  const s = table.state;
  if (!s) return;
  const aimedThere = (st: GameState, id: number) => {
    const engaged = st.combat?.find((a) => a.attacker === id);
    return !!engaged && ('player' in target ? engaged.defender?.player === target.player : engaged.defender?.card === target.card);
  };
  const go = ids.filter((id) => !aimedThere(s, id));
  if (!go.length) return;
  // Forge attacks the "current defender": take creatures out that are attacking elsewhere, pick the
  // defender, then send them all in
  for (const id of go) if (s.cards[id]?.attacking) bridge.act({ action: 'card', id });
  bridge.act('player' in target ? { action: 'player', id: target.player } : { action: 'card', id: target.card });
  for (const id of go) bridge.act({ action: 'card', id });
  attackGroup = [];
  sfx.click();
  reportRefused(go, () => table.isDeclaringAttack(), aimedThere, (names) => `Couldn't attack with ${names}`);
}

/** Send creatures (one, or a box-selected group) to block an attacker. */
function blockWith(ids: number[], attackerId: number): void {
  const s = table.state;
  if (!s) return;
  const attacker = s.cards[attackerId];
  const blocks = (st: GameState, id: number) => !!st.combat?.find((a) => a.attacker === attackerId)?.blockers.includes(id);
  let go = ids.filter((id) => !blocks(s, id));
  // only flyers and reach can block a flyer: say so rather than sending blocks Forge will refuse
  if (attacker?.flying) {
    const grounded = go.filter((id) => !s.cards[id]?.flying && !s.cards[id]?.keywords?.includes('Reach'));
    if (grounded.length) {
      hud.toast(`${nameList(grounded)} can't block ${attacker.name}: it has flying, so only creatures with flying or reach can`, 'message');
      go = go.filter((id) => !grounded.includes(id));
    }
  }
  if (!go.length) return;
  // a creature already blocking another attacker moves over to this one (right-click takes it out of combat)
  for (const id of go) if (s.cards[id]?.blocking) bridge.act({ action: 'card', id, button: 3 });
  // Forge blocks the "current attacker": pick the attacker, then the blockers
  bridge.act({ action: 'card', id: attackerId });
  for (const id of go) bridge.act({ action: 'card', id });
  sfx.click();
  reportRefused(go, () => table.isDeclaringBlock(), blocks, (names) => `${names} can't block ${attacker?.name ?? 'that attacker'}`);
}

hud.bind({
  ok: () => bridge.act({ action: 'ok' }),
  cancel: () => bridge.act({ action: 'cancel' }),
  // a plate click picks that player when the engine is asking for one; otherwise the camera goes to
  // their side (clicking the player already shown goes back to the whole table)
  player: (id) => {
    // a box-selected group of attackers goes at the opponent whose portrait was clicked
    if (table.group.size) {
      const ids = [...table.group];
      table.clearGroup();
      if (table.isDeclaringAttack() && id !== table.localId) return attackWith(ids, { player: id });
    }
    if (!director.multiplayer || table.targetablePlayers().has(id)) return pickPlayer(id);
    if (director.isShowing(id)) director.showTable();
    else director.focusPlayer(id);
  },
  passTurn: () => bridge.act({ action: 'passUntilEndOfTurn', turn: table.state?.turn }),
  concede: () => bridge.act({ action: 'concede' }),
  undo: () => bridge.act({ action: 'undo' }),
  payLife: () => {
    const lp = table.prompt.lifePay;
    if (lp) bridge.act({ action: 'player', id: lp.player });
  },
  exitToMenu: () => exitToMenu(),
});

const input = new Input(stage, table, {
  clickCard: (id, button) => {
    // a box-selected group: a click on something it can go at sends it there (an attacker to block, an
    // opponent's card or planeswalker to attack); any other click lets go of the group
    if (table.group.size && button === 1) {
      const ids = [...table.group];
      const member = table.group.has(id);
      table.clearGroup();
      const c = table.state?.cards[id];
      if (!member && c && table.isDeclaringBlock() && c.attacking) return blockWith(ids, id);
      if (!member && c && table.isDeclaringAttack() && c.zone === 'Battlefield' && c.controller != null && c.controller !== table.localId) {
        return attackWith(ids, /Planeswalker|Battle/.test(c.typeLine ?? '') ? { card: id } : { player: c.controller });
      }
      if (member) return;
    } else if (table.group.size) table.clearGroup();
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
    if (c && !paying && button === 1 && !c.land && (table.isLocalHand(id) || c.zone === 'Battlefield' || c.zone === 'Command' || c.zone === 'Library')) {
      armAutoPay();
    }
    bridge.act({ action: 'card', id, button });
  },
  clickTable: (pid) => {
    if (table.targetablePlayers().has(pid)) pickPlayer(pid);
  },
  // clicking an opponent's side sends a box-selected group of attackers at them; anywhere else lets go of it
  clickEmpty: (pid) => {
    if (!table.group.size) return false;
    const ids = [...table.group];
    table.clearGroup();
    const opponent = pid != null && pid !== table.localId && !table.state?.players.find((p) => p.id === pid)?.lost;
    if (!opponent || !table.isDeclaringAttack()) return true;
    attackWith(ids, { player: pid! });
    return true;
  },
  // ---- box-selecting creatures to attack or block with together ----
  canBoxSelect: () => table.isDeclaringAttack() || table.isDeclaringBlock(),
  boxSelect: (rect, additive) => {
    const inBox = table.creaturesInRect(rect);
    const ids = inBox.filter((id) => declarable(id, true) != null);
    // say why creatures inside the box were left out, when that's all there was
    if (!ids.length && inBox.length) {
      const why = inBox.map((id) => table.state!.cards[id]).find((c) => c && (table.isDeclaringBlock() ? c.cantBlock : c.sick));
      hud.toast(why ? `${why.name} can't ${table.isDeclaringBlock() ? 'block' : 'attack this turn'}` : 'None of those creatures can be declared right now', 'message');
    }
    if (ids.length || !additive) table.setGroup(ids, additive);
    if (ids.length) sfx.click();
  },
  // ---- dragging attackers onto players/planeswalkers and blockers onto attackers (Arena style) ----
  aimKind: (id) => {
    const kind = declarable(id, false);
    // Starscape Cleric and friends: say why instead of starting a drag Forge will refuse
    const c = table.state?.cards[id];
    if (!kind && c && table.isDeclaringBlock() && c.controller === table.localId && c.creature && c.zone === 'Battlefield' && c.cantBlock) {
      hud.toast(`${c.name} can't block`, 'message');
    }
    return kind;
  },
  aimTarget: (kind, _from, cardId, plate, point) => {
    const s = table.state;
    if (!s) return null;
    const opponent = (pid: number | null | undefined) => pid != null && pid !== table.localId && !s.players.find((p) => p.id === pid)?.lost;
    if (kind === 'block') {
      // blockers go onto attacking creatures
      const c = cardId != null ? s.cards[cardId] : undefined;
      return c?.attacking ? { card: cardId! } : null;
    }
    if (plate != null) return opponent(plate) ? { player: plate } : null;
    if (cardId != null) {
      const c = s.cards[cardId];
      if (c && c.zone === 'Battlefield' && opponent(c.controller)) {
        // a planeswalker or battle is attacked itself; any other card of theirs means them
        return /Planeswalker|Battle/.test(c.typeLine ?? '') ? { card: cardId } : { player: c.controller! };
      }
    }
    const side = point ? table.playerAt(point) : null;
    return opponent(side) ? { player: side! } : null;
  },
  aimMove: (kind, from, target, point) => {
    if (!point && !target) {
      table.showAim(null, null, kind, null);
      hud.aimPlate(null);
      return;
    }
    const to = target && 'player' in target ? table.playerWorld(target.player) : target && 'card' in target ? table.cardWorld(target.card) : point;
    // dragging one of a box-selected group drags them all
    table.showAim(table.group.has(from) ? [...table.group] : from, to, kind, target && 'card' in target ? target.card : null);
    hud.aimPlate(target && 'player' in target ? target.player : null);
  },
  aimDrop: (kind, from, target) => {
    const ids = table.group.has(from) ? [...table.group] : [from];
    table.clearGroup();
    if (kind === 'attack') attackWith(ids, target);
    else if ('card' in target) blockWith(ids, target.card);
  },
  hover: (id) => {
    const inHand = id != null && table.isLocalHand(id);
    if (inHand && id !== table.hoveredHand) sfx.hover();
    table.hoveredHand = inHand ? id : null;
    table.relayout(0.16);
    const card = id != null ? table.cards.get(id)?.state ?? null : null;
    hud.showZoom(inHand ? null : card, 'left', card ? stackNotes(card) : []);
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

/**
 * How many cards a hovered battlefield stack holds ("5 in this stack"), and for lands how many of that land
 * the player has in all, since tapped and untapped ones sit in separate stacks ("7 Swamps, 5 untapped").
 */
function stackNotes(card: CardState): string[] {
  const s = table.state;
  if (!s || card.zone !== 'Battlefield') return [];
  if (card.preparedSpell) return [`Prepared: ${card.preparedSpell} (click to cast)`];
  const attached = (id: number) => Object.values(s.cards).filter((c) => c.attachedTo === id && c.zone === 'Battlefield').length;
  const key = stackKey(card, attached(card.id));
  if (key == null) return [];
  const mine = (s.players.find((p) => p.id === card.controller)?.zones.Battlefield ?? []).map((id) => s.cards[id]).filter((c): c is CardState => !!c);
  const inStack = mine.filter((c) => stackKey(c, attached(c.id)) === key).length;
  const notes: string[] = [];
  if (inStack > 1) notes.push(`${inStack} in this stack`);
  if (card.land) {
    const same = mine.filter((c) => c.name === card.name);
    const untapped = same.filter((c) => !c.tapped).length;
    if (same.length > inStack) notes.push(`${same.length} ${card.name}${same.length > 1 && !/s$/.test(card.name ?? '') ? 's' : ''}, ${untapped} untapped`);
  }
  return notes;
}

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
  // Escape lets go of a box-selected group
  if (e.key === 'Escape' && table.group.size && !document.querySelector('.modal')) {
    table.clearGroup();
    return;
  }
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

// the full app talks to the rules engine on this computer; the relay's page connects once a code is entered
if (!onRelay) bridge.connect();
showMenu();

// dev-only hook so the headless driver (scratch tooling) can read state and act like a player
if (import.meta.env.DEV) (window as unknown as { __debug: unknown }).__debug = { table, bridge, input, stage, sfx, director, gsap, queue: () => ({ pending: queue.length, draining }), autoPayArmed: () => performance.now() < autoPayUntil };
