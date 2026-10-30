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
  baseY: -7.15,
  radius: 45,
  fitAngle: 30,
  maxDelta: 3.6,
  scale: 0.98,
  overlapTilt: -7,
  hoverScale: 1.5,
  /** half the visible height at the hand's distance (34° FOV): the popped card stops just inside the screen */
  screenHalfH: Math.tan(THREE.MathUtils.degToRad(17)) * 26,
};

/** How far a hovered hand card rises: enough to show the whole card, no further. */
const HOVER_LIFT = -HAND.screenHalfH + (CARD_H * HAND.hoverScale) / 2 + 0.3 - HAND.baseY;

const OPP_HAND = { distance: 30, baseY: 9.9, radius: 40, fitAngle: 22, maxDelta: 3.0, scale: 0.6 };
const STACK_ANCHOR = new THREE.Vector3(10.2, 2.4, -24);
/** Your commander gets its own screen slot left of the hand, like Arena's Brawl command zone. */
const COMMAND_ANCHOR = new THREE.Vector3(-12.6, -3.5, -26);

export interface Seat {
  player: PlayerState;
  regions: Regions;
  piles: typeof LOCAL_PILES;
  /** rotation (around the table centre) and uniform shrink for 3–4 player tables */
  rotY: number;
  shrink: number;
  local: boolean;
}

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
      shrink: 1,
      local: i === 0,
    }));
  }
  // Multiplayer: everyone gets the local layout, shrunk and turned to face their side of the table.
  // Seats run clockwise from the local player: left, across, right.
  const angles = rotated.length === 3 ? [0, -Math.PI / 2, Math.PI / 2] : [0, -Math.PI / 2, Math.PI, Math.PI / 2];
  return rotated.map((p, i) => ({
    player: p,
    regions: LOCAL_REGIONS,
    piles: LOCAL_PILES,
    rotY: angles[i],
    shrink: i === 0 ? 0.62 : 0.5,
    local: i === 0,
  }));
}

/** Seat-local table point → world. Multiplayer seats are pulled toward their edge before turning. */
function seatToWorld(seat: Seat, v: THREE.Vector3): THREE.Vector3 {
  if (seat.rotY === 0 && seat.shrink === 1) return v.clone();
  const p = v.clone().multiplyScalar(seat.shrink);
  // keep each seat's battlefield between the centre and its edge
  const edgeOffset = seat.local ? 5.2 : Math.abs(Math.sin(seat.rotY)) > 0.5 ? 10.5 : 6.2;
  p.z += edgeOffset;
  p.applyAxisAngle(new THREE.Vector3(0, 1, 0), seat.rotY);
  if (Math.abs(Math.sin(seat.rotY)) > 0.5) p.z -= 1.2;
  return p;
}

function categorize(c: CardState): 'creatures' | 'lands' | 'other' {
  if (c.creature || c.planeswalker) return 'creatures';
  if (c.land) return 'lands';
  return 'other';
}

/** Cards that look the same collapse into one stack, like Arena's land and token piles. */
function stackKey(c: CardState, attachedCount: number): string | null {
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
  opts: { hoveredHand: number | null; handOrder: number[] },
): Map<number, Placement> {
  const out = new Map<number, Placement>();
  const cards = state.cards;
  const seats = seatsFor(state, localId);
  const flat = new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ');

  for (const seat of seats) {
    const p = seat.player;
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
      const region = seat.regions[cat];
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
          const attackPush = c.attacking ? (seat.local ? -1.4 : 1.4) : 0;
          const local = new THREE.Vector3(x + (col.width * scale * squeeze) / 2 + off, 0.02 + i * 0.012, zMid + attackPush - off * 0.35);
          const world = seatToWorld(seat, local);
          const rot = flat.clone();
          rot.y = seat.rotY + (c.tapped ? -Math.PI / 2 : 0);
          out.set(id, { space: 'table', pos: world, rot, scale: scale * seat.shrink, faceUp: c.visible, order: i });

          // attachments tuck under their host, peeking out above it
          (attachments.get(id) ?? []).forEach((aid, ai) => {
            const a = new THREE.Vector3(local.x, 0.01 - (ai + 1) * 0.006, local.z - 0.55 * (ai + 1) * scale);
            const aRot = flat.clone();
            aRot.y = seat.rotY + (cards[aid]?.tapped ? -Math.PI / 2 : 0);
            out.set(aid, { space: 'table', pos: seatToWorld(seat, a), rot: aRot, scale: scale * seat.shrink, faceUp: true, order: -1 - ai });
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
        out.set(id, { space: 'table', pos: seatToWorld(seat, v), rot, scale: scale * seat.shrink, faceUp, order: i });
      });
    };
    const pileScale = seat.local ? 0.7 : 0.55;
    pile(p.zones.Graveyard, seat.piles.graveyard, pileScale, true);
    pile(p.zones.Exile, seat.piles.exile, pileScale, true);
    if (seat.local) {
      p.zones.Command.forEach((id, i) => {
        out.set(id, {
          space: 'rig',
          pos: COMMAND_ANCHOR.clone().add(new THREE.Vector3(i * 1.4, i * 0.25, i * 0.05)),
          rot: new THREE.Euler(0, 0.12, 0.04, 'YXZ'),
          scale: 0.95,
          faceUp: true,
          order: i,
        });
      });
    } else {
      pile(p.zones.Command, seat.piles.command, 0.7, true, 0.9);
    }

    // ---- hands ----
    if (seat.local) {
      const order = opts.handOrder.filter((id) => p.zones.Hand.includes(id));
      for (const id of p.zones.Hand) if (!order.includes(id)) order.push(id);
      layoutLocalHand(order, opts.hoveredHand, out);
    } else if (seats.length === 2) {
      layoutOpponentHand(p.zones.Hand, out);
    } else {
      // multiplayer opponents: hand shown as a small fan by their library
      p.zones.Hand.forEach((id, i) => {
        const n = p.zones.Hand.length;
        const v = seat.piles.library.clone().add(new THREE.Vector3(-4 - (n - 1 - i) * 0.5, 0.05 + i * 0.01, 1.5));
        const rot = flat.clone();
        rot.y = seat.rotY;
        out.set(id, { space: 'table', pos: seatToWorld(seat, v), rot, scale: 0.55 * seat.shrink, faceUp: false, order: i });
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

  return out;
}

function layoutLocalHand(ids: number[], hovered: number | null, out: Map<number, Placement>): void {
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
    const x = Math.sin(a) * HAND.radius;
    const y = HAND.baseY + (Math.cos(a) - 1) * HAND.radius + (isHover ? HOVER_LIFT : 0);
    const z = -HAND.distance + i * 0.02 + (isHover ? 0.6 : 0);
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

export function seatRotation(state: GameState, localId: number, playerId: number): { rotY: number; shrink: number; local: boolean } | null {
  const seat = seatsFor(state, localId).find((s) => s.player.id === playerId);
  return seat ? { rotY: seat.rotY, shrink: seat.shrink, local: seat.local } : null;
}

/** Screen-space anchor for each player's avatar plate, as a point on the table. */
export function avatarAnchor(state: GameState, localId: number, playerId: number): THREE.Vector3 | null {
  const seat = seatsFor(state, localId).find((s) => s.player.id === playerId);
  if (!seat) return null;
  if (seatsFor(state, localId).length === 2) {
    return seat.local ? new THREE.Vector3(-17.5, 0, 12.2) : new THREE.Vector3(-17, 0, -14.4);
  }
  return seatToWorld(seat, new THREE.Vector3(0, 0, 12.6));
}
