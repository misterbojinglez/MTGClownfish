import * as THREE from 'three';
import type { CardState, GameState, PlayerState } from '../protocol';
import { CARD_H, CARD_W } from './cardMesh';

/**
 * Where every visible card should be. Battlefield geometry follows Arena's BattlefieldCardHolder regions
 * and hand geometry its fan settings (docs/arena-reference.md); everything here is our own implementation.
 */

export type Space = 'table' | 'rig';

export interface Placement {
  space: Space;
  pos: THREE.Vector3;
  rot: THREE.Euler;
  scale: number;
  faceUp: boolean;
  /** draw order hint inside piles and hands */
  order: number;
}

interface Rect {
  x: number;
  z: number;
  w: number;
  h: number;
}

interface RegionSpec {
  rect: Rect;
  scales: number[];
  gutter: number;
}

// Local-seat regions, table units. "z" grows toward the local player.
const LOCAL_REGIONS = {
  creatures: { rect: { x: -21, z: 0, w: 42, h: 5 }, scales: [1.2, 1.1, 1.0, 0.9, 0.8, 0.7], gutter: 0.5 },
  lands: { rect: { x: 1.5, z: 5.5, w: 19.5, h: 4.5 }, scales: [0.9, 0.85, 0.7, 0.6, 0.5], gutter: 0.45 },
  other: { rect: { x: -21, z: 5.5, w: 19.5, h: 4.5 }, scales: [0.9, 0.85, 0.7, 0.6, 0.5], gutter: 0.45 },
} satisfies Record<string, RegionSpec>;

const OPP_REGIONS = {
  creatures: { rect: { x: -21, z: -7.5, w: 42, h: 5 }, scales: [1.2, 1.1, 1.0, 0.9, 0.8, 0.7], gutter: 0.5 },
  lands: { rect: { x: 1.5, z: -12, w: 19.5, h: 4.5 }, scales: [0.9, 0.85, 0.7, 0.6, 0.5], gutter: 0.45 },
  other: { rect: { x: -21, z: -12, w: 19.5, h: 4.5 }, scales: [0.9, 0.85, 0.7, 0.6, 0.5], gutter: 0.45 },
} satisfies Record<string, RegionSpec>;

type Regions = typeof LOCAL_REGIONS;

/**
 * A second, smaller hand just below your mat (between it and your hand): cards you may play from exile, wherever
 * their owner's exile is (Tinybones' stash, impulse draw). Ones you can't play right now are shown dimmed.
 */
const EXILE_STRIP = { x: -19.5, z: 10.9, w: 40.5, h: 5.3, scale: 1.5, gutter: 0.5 };

/** Pile anchors per seat (graveyard, exile, library, command). */
const LOCAL_PILES = {
  library: new THREE.Vector3(23.4, 0, 6.6),
  graveyard: new THREE.Vector3(23.4, 0, 2.4),
  exile: new THREE.Vector3(-23.6, 0, 2.6),
  command: new THREE.Vector3(-23.6, 0, 7.6),
};
const OPP_PILES = {
  library: new THREE.Vector3(22.4, 0, -10.8),
  graveyard: new THREE.Vector3(22.4, 0, -6.9),
  exile: new THREE.Vector3(-22.6, 0, -5.4),
  command: new THREE.Vector3(-22.6, 0, -9.8),
};

// Hand fan (desktop 16:9 expanded layout) in camera space.
export const HAND = {
  distance: 26,
  // cards 15% larger than they were (0.98): the fan widens with them (radius), a full hand spans no wider
  // than before (fitAngle, or it would reach the command slot), and as much more of each card shows (baseY)
  baseY: -7.04,
  radius: 51.75,
  fitAngle: 18.75,
  maxDelta: 3.6,
  scale: 1.13,
  overlapTilt: -7,
  hoverScale: 1.5,
  /** half the visible height at the hand's distance (34° FOV): the popped card stops just inside the screen */
  screenHalfH: Math.tan(THREE.MathUtils.degToRad(17)) * 26,
};

/** How far a hovered hand card rises: enough to show the whole card, no further. */
const HOVER_LIFT = -HAND.screenHalfH + (CARD_H * HAND.hoverScale) / 2 + 0.3 - HAND.baseY;

const OPP_HAND = { distance: 30, baseY: 9.9, radius: 40, fitAngle: 22, maxDelta: 3.0, scale: 0.6 };
const STACK_ANCHOR = new THREE.Vector3(10.2, 2.4, -24);
/**
 * Your commander gets its own screen slot left of the hand, like Arena's Brawl command zone: low in the
 * bottom-left corner (your badge used to sit under it), leaving room above for its rising aura.
 */
const COMMAND_ANCHOR = new THREE.Vector3(-12.6, -5.55, -26);

export interface Seat {
  player: PlayerState;
  regions: Regions;
  piles: typeof LOCAL_PILES;
  /**
   * Turn around the table centre. Opponent seats are laid out the way Arena shows its opponent (cards
   * upright to someone looking across from the centre), so a camera yawed by rotY sees one exactly so.
   */
  rotY: number;
  /** pushes the seat away from the centre (along its own z) before it is turned */
  offsetZ: number;
  local: boolean;
}

/**
 * Multiplayer seat placement. Everyone gets full-size regions; the camera zooms instead.
 * You sit at the bottom, then clockwise: left, across, right (3 players: left and right).
 */
const MP_LOCAL_OFFSET = 6;
const MP_ACROSS_OFFSET = -6;
/** side seats: their creature row's inner edge lands just outside your battlefield's width */
const MP_SIDE_OFFSET = -24;

export function seatsFor(state: GameState, localId: number): Seat[] {
  const order = [...state.players];
  const li = order.findIndex((p) => p.id === localId);
  const rotated = li >= 0 ? [...order.slice(li), ...order.slice(0, li)] : order;
  if (rotated.length <= 2) {
    return rotated.map((p, i) => ({
      player: p,
      regions: i === 0 ? LOCAL_REGIONS : OPP_REGIONS,
      piles: i === 0 ? LOCAL_PILES : OPP_PILES,
      rotY: 0,
      offsetZ: 0,
      local: i === 0,
    }));
  }
  const opp = rotated.length === 3 ? ['left', 'right'] : ['left', 'across', 'right'];
  return rotated.map((p, i) => {
    if (i === 0) return { player: p, regions: LOCAL_REGIONS, piles: LOCAL_PILES, rotY: 0, offsetZ: MP_LOCAL_OFFSET, local: true };
    const where = opp[i - 1];
    const rotY = where === 'left' ? Math.PI / 2 : where === 'right' ? -Math.PI / 2 : 0;
    return { player: p, regions: OPP_REGIONS, piles: OPP_PILES, rotY, offsetZ: where === 'across' ? MP_ACROSS_OFFSET : MP_SIDE_OFFSET, local: false };
  });
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Seat-local table point → world. */
function seatToWorld(seat: Seat, v: THREE.Vector3): THREE.Vector3 {
  const p = v.clone();
  p.z += seat.offsetZ;
  if (seat.rotY !== 0) p.applyAxisAngle(Y_AXIS, seat.rotY);
  return p;
}

/** World → seat-local table point. */
function worldToSeat(seat: Seat, v: THREE.Vector3): THREE.Vector3 {
  const p = v.clone();
  if (seat.rotY !== 0) p.applyAxisAngle(Y_AXIS, -seat.rotY);
  p.z -= seat.offsetZ;
  return p;
}

/** Each seat's whole footprint (battlefield, piles, avatar) in seat-local coordinates. */
function footprint(seat: Seat): Rect {
  return seat.local ? { x: -24.6, z: -0.8, w: 49.2, h: 14 } : { x: -24.6, z: -15.6, w: 49.2, h: 13.8 };
}

/** The inset mat drawn under each battlefield, seat-local. */
function matRect(seat: Seat): Rect {
  return seat.local ? { x: -21.8, z: -0.6, w: 43.6, h: 11.2 } : { x: -21.8, z: -12.6, w: 43.6, h: 10.7 };
}

function rectWorld(seat: Seat, r: Rect): THREE.Vector3[] {
  return [
    [r.x, r.z],
    [r.x + r.w, r.z],
    [r.x + r.w, r.z + r.h],
    [r.x, r.z + r.h],
  ].map(([x, z]) => seatToWorld(seat, new THREE.Vector3(x, 0, z)));
}

export interface SeatFrame {
  playerId: number;
  local: boolean;
  rotY: number;
  /** footprint corners on the table */
  corners: THREE.Vector3[];
  center: THREE.Vector3;
}

/** Where every seat sits, for the camera director. */
export function seatFrames(state: GameState, localId: number): SeatFrame[] {
  return seatsFor(state, localId).map((seat) => {
    const corners = rectWorld(seat, footprint(seat));
    const center = corners.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(1 / corners.length);
    return { playerId: seat.player.id, local: seat.local, rotY: seat.rotY, corners, center };
  });
}

/** Battlefield mats as world-space boxes (minX, minZ, maxX, maxZ) for the table shader. */
export function tableMats(state: GameState, localId: number): THREE.Vector4[] {
  return seatsFor(state, localId).map((seat) => {
    const pts = rectWorld(seat, matRect(seat));
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    return new THREE.Vector4(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs));
  });
}

/** Each mat's commander colour identity, in tableMats order ("" colourless, undefined outside Commander). */
export function matIdentities(state: GameState, localId: number): (string | undefined)[] {
  return seatsFor(state, localId).map((seat) => seat.player.identity);
}

/** Whose side of the table a point belongs to: the seat whose footprint is nearest. */
export function seatAt(state: GameState, localId: number, point: THREE.Vector3): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const seat of seatsFor(state, localId)) {
    const p = worldToSeat(seat, point);
    const r = footprint(seat);
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
    const dz = Math.max(r.z - p.z, 0, p.z - (r.z + r.h));
    const d = Math.hypot(dx, dz);
    if (d < bestD) {
      bestD = d;
      best = seat.player.id;
    }
  }
  return best;
}

function categorize(c: CardState): 'creatures' | 'lands' | 'other' {
  if (c.creature || c.planeswalker) return 'creatures';
  if (c.land) return 'lands';
  return 'other';
}

/** Cards that look the same collapse into one stack, like Arena's land and token piles. */
export function stackKey(c: CardState, attachedCount: number): string | null {
  if (attachedCount > 0 || c.attacking || c.blocking) return null;
  if (Object.values(c.counters ?? {}).some((n) => n > 0)) return null;
  if (!(c.land || c.token)) return null;
  return `${c.name}|${c.tapped}|${c.sick && c.creature}|${c.power}/${c.toughness}`;
}

interface Column {
  ids: number[];
  width: number;
}

export function computeLayout(
  state: GameState,
  localId: number,
  /** liftedHand: hand cards picked in a choice (mulligan bottom, discard), raised out of the fan */
  opts: { hoveredHand: number | null; handOrder: number[]; liftedHand?: Set<number>; hoveredCommand?: number | null },
): Map<number, Placement> {
  const out = new Map<number, Placement>();
  const cards = state.cards;
  const seats = seatsFor(state, localId);
  const flat = new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ');

  const localSeat = seats.find((s) => s.local);
  const strip = localSeat ? (localSeat.player.exilePlayable ?? []).filter((id) => cards[id]?.zone === 'Exile') : [];

  for (const seat of seats) {
    const p = seat.player;
    const regions: Regions = seat.regions;
    // ---- battlefield ----
    const attachments = new Map<number, number[]>();
    for (const id of p.zones.Battlefield) {
      const host = cards[id]?.attachedTo;
      if (host != null && p.zones.Battlefield.includes(host)) {
        attachments.set(host, [...(attachments.get(host) ?? []), id]);
      }
    }
    // permanents controlled by this player but owned elsewhere still show on this side
    const groups: Record<'creatures' | 'lands' | 'other', Column[]> = { creatures: [], lands: [], other: [] };
    const stacks = new Map<string, Column>();
    for (const id of p.zones.Battlefield) {
      const c = cards[id];
      if (!c) continue;
      const host = c.attachedTo;
      if (host != null && attachments.get(host)?.includes(id)) continue;
      const cat = categorize(c);
      const key = stackKey(c, attachments.get(id)?.length ?? 0);
      const w = c.tapped ? CARD_H : CARD_W;
      if (key) {
        const col = stacks.get(cat + key);
        if (col && col.ids.length < 8) {
          col.ids.push(id);
          continue;
        }
        const fresh = { ids: [id], width: w };
        stacks.set(cat + key, fresh);
        groups[cat].push(fresh);
      } else {
        groups[cat].push({ ids: [id], width: w });
      }
    }

    for (const cat of ['creatures', 'lands', 'other'] as const) {
      const region = regions[cat];
      const cols = groups[cat];
      if (cols.length === 0) continue;
      const stackExtra = (col: Column) => Math.min(col.ids.length - 1, 3) * 0.32;
      let scale = region.scales[region.scales.length - 1];
      for (const s of region.scales) {
        const need = cols.reduce((acc, col) => acc + (col.width + stackExtra(col)) * s, 0) + region.gutter * (cols.length - 1);
        if (need <= region.rect.w) {
          scale = s;
          break;
        }
      }
      const natural = cols.reduce((acc, col) => acc + (col.width + stackExtra(col)) * scale, 0) + region.gutter * (cols.length - 1);
      const squeeze = natural > region.rect.w ? region.rect.w / natural : 1;
      let x = region.rect.x + (region.rect.w - natural * squeeze) / 2;
      const zMid = region.rect.z + region.rect.h / 2;
      for (const col of cols) {
        const colW = (col.width + stackExtra(col)) * scale * squeeze;
        col.ids.forEach((id, i) => {
          const c = cards[id];
          const off = Math.min(i, 3) * 0.32 * scale * squeeze;
          // attackers step toward the opponent; blockers step out to meet them
          const attackPush = c.attacking || c.blocking ? (seat.local ? -1.4 : 1.4) : 0;
          const local = new THREE.Vector3(x + (col.width * scale * squeeze) / 2 + off, 0.02 + i * 0.012, zMid + attackPush - off * 0.35);
          const world = seatToWorld(seat, local);
          const rot = flat.clone();
          rot.y = seat.rotY + (c.tapped ? -Math.PI / 2 : 0);
          out.set(id, { space: 'table', pos: world, rot, scale, faceUp: c.visible, order: i });

          // attachments tuck under their host, peeking out above it
          (attachments.get(id) ?? []).forEach((aid, ai) => {
            const a = new THREE.Vector3(local.x, 0.01 - (ai + 1) * 0.006, local.z - 0.55 * (ai + 1) * scale);
            const aRot = flat.clone();
            aRot.y = seat.rotY + (cards[aid]?.tapped ? -Math.PI / 2 : 0);
            out.set(aid, { space: 'table', pos: seatToWorld(seat, a), rot: aRot, scale, faceUp: true, order: -1 - ai });
          });
        });
        x += colW + region.gutter * squeeze;
      }
    }

    // ---- piles ----
    const pile = (ids: number[], anchor: THREE.Vector3, scale: number, faceUp: boolean, spread = 0) => {
      ids.forEach((id, i) => {
        const v = anchor.clone().add(new THREE.Vector3(0, 0.03 + i * 0.006, spread * i));
        const rot = flat.clone();
        rot.y = seat.rotY;
        out.set(id, { space: 'table', pos: seatToWorld(seat, v), rot, scale, faceUp, order: i });
      });
    };
    const pileScale = seat.local ? 0.7 : 0.55;
    // a top of library its owner may look at sits face up on the library pile (same height as the pile mesh)
    if (p.zones.LibraryTop != null) {
      const height = Math.max(0.001, Math.min(1.4, p.zones.LibraryCount * 0.019));
      const rot = flat.clone();
      rot.y = seat.rotY;
      out.set(p.zones.LibraryTop, { space: 'table', pos: seatToWorld(seat, seat.piles.library.clone().setY(height + 0.02)), rot, scale: pileScale, faceUp: true, order: 0 });
    }
    pile(p.zones.Graveyard, seat.piles.graveyard, pileScale, true);
    pile(p.zones.Exile, seat.piles.exile, pileScale, true);
    if (seat.local) {
      p.zones.Command.forEach((id, i) => {
        // hovered, it grows where it is (lifted toward you, nudged in from the screen's edge) instead of
        // opening the zoom beside it
        const hovered = opts.hoveredCommand === id;
        out.set(id, {
          space: 'rig',
          pos: COMMAND_ANCHOR.clone().add(new THREE.Vector3(i * 1.4 + (hovered ? 0.7 : 0), i * 0.25 + (hovered ? 0.9 : 0), i * 0.05 + (hovered ? 0.8 : 0))),
          rot: hovered ? new THREE.Euler(0, 0.05, 0, 'YXZ') : new THREE.Euler(0, 0.12, 0.04, 'YXZ'),
          scale: hovered ? 1.4 : 0.95,
          faceUp: true,
          order: hovered ? 1000 : i,
        });
      });
    } else {
      pile(p.zones.Command, seat.piles.command, 0.7, true, 0.9);
    }

    // ---- hands ----
    if (seat.local) {
      const order = opts.handOrder.filter((id) => p.zones.Hand.includes(id));
      for (const id of p.zones.Hand) if (!order.includes(id)) order.push(id);
      layoutLocalHand(order, opts.hoveredHand, out, opts.liftedHand);
    } else if (seats.length === 2) {
      layoutOpponentHand(p.zones.Hand, out);
    } else {
      // multiplayer opponents: a small face-down fan along the far edge of their side
      const n = p.zones.Hand.length;
      const step = Math.min(1.1, 14 / Math.max(1, n));
      p.zones.Hand.forEach((id, i) => {
        const v = new THREE.Vector3(2 + (i - (n - 1) / 2) * step, 0.05 + i * 0.01, -14.3);
        const rot = flat.clone();
        rot.y = seat.rotY + (i - (n - 1) / 2) * 0.03;
        out.set(id, { space: 'table', pos: seatToWorld(seat, v), rot, scale: 0.5, faceUp: false, order: i });
      });
    }
  }

  // ---- stack: fanned at the right of the screen, newest on top ----
  state.stack.forEach((item, i) => {
    if (item.source == null || item.ability) return;
    const depth = state.stack.length - 1 - i;
    out.set(item.source, {
      space: 'rig',
      pos: STACK_ANCHOR.clone().add(new THREE.Vector3(-depth * 0.85, -depth * 0.7, -depth * 0.35)),
      rot: new THREE.Euler(0, -0.12, 0.02, 'YXZ'),
      scale: 1.15,
      faceUp: true,
      order: 100 - depth,
    });
  });

  // ---- cards you may play from exile, laid out just below your mat (wherever their owner's exile is) ----
  if (localSeat && strip.length) {
    const { start, step } = stripSpacing(strip.length);
    strip.forEach((id, i) => {
      const local = new THREE.Vector3(start + step * i, 0.03 + i * 0.004, EXILE_STRIP.z + EXILE_STRIP.h / 2);
      const rot = flat.clone();
      rot.y = localSeat.rotY;
      out.set(id, { space: 'table', pos: seatToWorld(localSeat, local), rot, scale: EXILE_STRIP.scale, faceUp: true, order: i });
    });
  }

  return out;
}

/** The band's card centres: centred, spaced out, overlapping like a fanned row when there are too many. */
function stripSpacing(n: number): { start: number; step: number } {
  const w = CARD_W * EXILE_STRIP.scale;
  const natural = n * w + (n - 1) * EXILE_STRIP.gutter;
  const step = natural > EXILE_STRIP.w ? (EXILE_STRIP.w - w) / Math.max(1, n - 1) : w + EXILE_STRIP.gutter;
  const start = EXILE_STRIP.x + (EXILE_STRIP.w - (step * (n - 1) + w)) / 2 + w / 2;
  return { start, step };
}

/** Where the "Playable from exile" label sits (just above the band's first card), or null when it's empty. */
export function exileStripAnchor(state: GameState, localId: number): THREE.Vector3 | null {
  const seat = seatsFor(state, localId).find((s) => s.local);
  const n = (seat?.player.exilePlayable ?? []).filter((id) => state.cards[id]?.zone === 'Exile').length;
  if (!seat || n === 0) return null;
  const { start } = stripSpacing(n);
  const halfH = (CARD_H * EXILE_STRIP.scale) / 2;
  return seatToWorld(seat, new THREE.Vector3(start - (CARD_W * EXILE_STRIP.scale) / 2, 0, EXILE_STRIP.z + EXILE_STRIP.h / 2 - halfH - 0.15));
}

/** Which of n fan slots lies nearest a hand card held at rig-space x (for reordering by drag). */
export function nearestHandSlot(n: number, x: number): number {
  const delta = n > 1 ? Math.min(HAND.maxDelta, HAND.fitAngle / (n - 1)) : 0;
  const start = (-delta * (n - 1)) / 2;
  let best = 0;
  for (let i = 1; i < n; i++) {
    const xi = Math.sin(THREE.MathUtils.degToRad(start + delta * i)) * HAND.radius;
    const xb = Math.sin(THREE.MathUtils.degToRad(start + delta * best)) * HAND.radius;
    if (Math.abs(xi - x) < Math.abs(xb - x)) best = i;
  }
  return best;
}

/** How far a picked hand card rises (about a third of a card). */
const PICKED_LIFT = 2.4;

function layoutLocalHand(ids: number[], hovered: number | null, out: Map<number, Placement>, lifted?: Set<number>): void {
  const n = ids.length;
  if (n === 0) return;
  const delta = n > 1 ? Math.min(HAND.maxDelta, HAND.fitAngle / (n - 1)) : 0;
  const start = (-delta * (n - 1)) / 2;
  const hi = hovered == null ? -1 : ids.indexOf(hovered);
  ids.forEach((id, i) => {
    let deg = start + delta * i;
    // neighbours of the hovered card lean away from it
    if (hi >= 0 && i !== hi) deg += Math.sign(i - hi) * Math.max(0, 2.6 - Math.abs(i - hi) * 0.6);
    const a = THREE.MathUtils.degToRad(deg);
    const isHover = i === hi;
    const lift = !isHover && lifted?.has(id) ? PICKED_LIFT : 0;
    const x = Math.sin(a) * HAND.radius;
    const y = HAND.baseY + (Math.cos(a) - 1) * HAND.radius + (isHover ? HOVER_LIFT : lift);
    const z = -HAND.distance + i * 0.02 + (isHover ? 0.6 : lift ? 0.3 : 0);
    out.set(id, {
      space: 'rig',
      pos: new THREE.Vector3(x, y, z),
      rot: new THREE.Euler(0, isHover ? 0 : THREE.MathUtils.degToRad(HAND.overlapTilt) * 0.25, isHover ? 0 : -a, 'YXZ'),
      scale: isHover ? HAND.hoverScale : HAND.scale,
      faceUp: true,
      order: isHover ? 1000 : i,
    });
  });
}

function layoutOpponentHand(ids: number[], out: Map<number, Placement>): void {
  const n = ids.length;
  const delta = n > 1 ? Math.min(OPP_HAND.maxDelta, OPP_HAND.fitAngle / (n - 1)) : 0;
  const start = (-delta * (n - 1)) / 2;
  ids.forEach((id, i) => {
    const a = THREE.MathUtils.degToRad(start + delta * i);
    out.set(id, {
      space: 'rig',
      pos: new THREE.Vector3(Math.sin(a) * OPP_HAND.radius, OPP_HAND.baseY - (Math.cos(a) - 1) * OPP_HAND.radius, -OPP_HAND.distance + i * 0.02),
      rot: new THREE.Euler(0, 0, a, 'YXZ'),
      scale: OPP_HAND.scale,
      faceUp: false,
      order: i,
    });
  });
}

/** Where a player's library sits, for draw / mill animations and the pile mesh. */
export function libraryAnchor(state: GameState, localId: number, playerId: number): THREE.Vector3 | null {
  const seat = seatsFor(state, localId).find((s) => s.player.id === playerId);
  if (!seat) return null;
  return seatToWorld(seat, seat.piles.library);
}

export function seatRotation(state: GameState, localId: number, playerId: number): { rotY: number; local: boolean } | null {
  const seat = seatsFor(state, localId).find((s) => s.player.id === playerId);
  return seat ? { rotY: seat.rotY, local: seat.local } : null;
}

/** Each player's avatar plate, as a point on the table. */
export function avatarAnchor(state: GameState, localId: number, playerId: number): THREE.Vector3 | null {
  const seat = seatsFor(state, localId).find((s) => s.player.id === playerId);
  if (!seat) return null;
  if (seat.local) return seatToWorld(seat, new THREE.Vector3(-17.5, 0, 12.2));
  // the seat on your left has its plate at its far end, clear of your commander in the bottom-left corner
  return seatToWorld(seat, new THREE.Vector3(seat.rotY > 0 ? 17 : -17, 0, -14.4));
}
