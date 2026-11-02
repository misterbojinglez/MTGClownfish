import * as THREE from 'three';
import { OVERLAY_LAYER } from './stage';
import type { CardState } from '../protocol';
import { cardBackTexture, cardFaceTexture, roundRect } from './textures';

/** Card size at scale 1 in table units (Arena's creature row of 47 fits ~13 cards at 1.2×). */
export const CARD_W = 2.5;
export const CARD_H = 3.5;
const RADIUS = 0.13;

function cardShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function shapeGeometry(w: number, h: number, r: number): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(cardShape(w, h, r), 6);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / w + 0.5;
    uv[i * 2 + 1] = pos.getY(i) / h + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const FACE_GEO = shapeGeometry(CARD_W, CARD_H, RADIUS);
const EDGE_GEO = new THREE.ExtrudeGeometry(cardShape(CARD_W, CARD_H, RADIUS), { depth: 0.01, bevelEnabled: false, curveSegments: 6 });
EDGE_GEO.translate(0, 0, -0.005);
const GLOW_GEO = new THREE.PlaneGeometry(CARD_W * 1.3, CARD_H * 1.21);

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 340;
  const g = c.getContext('2d')!;
  g.filter = 'blur(7px)';
  g.strokeStyle = '#fff';
  g.lineWidth = 12;
  roundRect(g, 30, 30, 196, 280, 14);
  g.stroke();
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

export type Highlight = 'none' | 'playable' | 'autoPay' | 'selectable' | 'chosen' | 'attacking' | 'blocking' | 'target';

/**
 * The design's frame language: playable green, picks in arcane blue (brighter once picked), attackers
 * red ("aggressive"), blockers silver-blue, targets fiery orange, the auto-pay plan violet ("passive").
 */
const HIGHLIGHT_COLORS: Record<Highlight, THREE.Color> = {
  none: new THREE.Color(0, 0, 0),
  playable: new THREE.Color('#4fe07a').multiplyScalar(1.5),
  autoPay: new THREE.Color('#a565ff').multiplyScalar(1.7),
  selectable: new THREE.Color('#4c9dff').multiplyScalar(1.6),
  chosen: new THREE.Color('#9fd8ff').multiplyScalar(1.9),
  attacking: new THREE.Color('#ff4a32').multiplyScalar(1.6),
  blocking: new THREE.Color('#b9c8ff').multiplyScalar(1.6),
  target: new THREE.Color('#ff7a26').multiplyScalar(1.9),
};

/** Plain hover (nothing to do with the card) is a soft neutral rim, so green always means playable. */
const HOVER_COLOR = new THREE.Color('#fff4dc').multiplyScalar(0.7);

/** Shared GLSL that eats the card away along noise with a glowing rim (death, exile). */
function addDissolve(mat: THREE.MeshStandardMaterial, uniforms: { uDissolve: { value: number }; uEdge: { value: THREE.Color } }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDissolve = uniforms.uDissolve;
    shader.uniforms.uEdge = uniforms.uEdge;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uDissolve; uniform vec3 uEdge; varying vec2 vDUv;
         float dHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
         float dNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
           return mix(mix(dHash(i), dHash(i+vec2(1,0)), u.x), mix(dHash(i+vec2(0,1)), dHash(i+vec2(1,1)), u.x), u.y); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float dn = dNoise(vDUv * 7.0) * 0.6 + dNoise(vDUv * 23.0) * 0.4;
         float edge = dn - uDissolve * 1.15;
         if (uDissolve > 0.0 && edge < 0.0) discard;
         totalEmissiveRadiance += uEdge * smoothstep(0.08, 0.0, edge) * step(0.001, uDissolve) * 4.0;`,
      );
  };
}

export class CardObject {
  readonly root = new THREE.Group();
  /** Local wobble/lift layer so animations don't fight the layout transform on root. */
  readonly body = new THREE.Group();
  /** Idle hover for flyers, under body so it never fights the strike and wobble tweens. */
  private readonly lift = new THREE.Group();
  private hoverH = 0;
  onTable = false;
  readonly id: number;
  state: CardState;
  highlight: Highlight = 'none';
  hovered = false;

  private readonly front: THREE.Mesh;
  private readonly back: THREE.Mesh;
  private readonly edge: THREE.Mesh;
  private readonly glow: THREE.Mesh;
  private readonly frontMat: THREE.MeshStandardMaterial;
  private readonly backMat: THREE.MeshStandardMaterial;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly badge: THREE.Mesh;
  private readonly badgeCanvas = document.createElement('canvas');
  private readonly badgeTex: THREE.CanvasTexture;
  private readonly dissolve = { uDissolve: { value: 0 }, uEdge: { value: new THREE.Color('#ff7a2a') } };
  private faceKey = '';
  private badgeKey = '';
  private glowStrength = 0;
  private time = Math.random() * 10;
  private hurtT = 0;

  constructor(state: CardState) {
    this.id = state.id;
    this.state = state;

    this.frontMat = new THREE.MeshStandardMaterial({ map: cardBackTexture(), emissiveMap: cardBackTexture(), emissive: 0xffffff, roughness: 0.6, metalness: 0 });
    this.backMat = new THREE.MeshStandardMaterial({ map: cardBackTexture(), emissiveMap: cardBackTexture(), emissive: 0xffffff, roughness: 0.6, metalness: 0 });
    addDissolve(this.frontMat, this.dissolve);
    addDissolve(this.backMat, this.dissolve);

    this.front = new THREE.Mesh(FACE_GEO, this.frontMat);
    this.front.position.z = 0.011;
    this.back = new THREE.Mesh(FACE_GEO, this.backMat);
    this.back.rotation.y = Math.PI;
    this.back.position.z = -0.011;
    this.edge = new THREE.Mesh(EDGE_GEO, new THREE.MeshStandardMaterial({ color: '#0d0d10', roughness: 0.8 }));
    for (const m of [this.front, this.back, this.edge]) {
      m.castShadow = true;
      m.userData.cardId = state.id;
    }

    this.glowMat = new THREE.MeshBasicMaterial({
      map: glowTexture(),
      color: 0x000000,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.glow = new THREE.Mesh(GLOW_GEO, this.glowMat);
    this.glow.position.z = -0.02;
    this.glow.renderOrder = -1;

    this.badgeCanvas.width = 256;
    this.badgeCanvas.height = 96;
    this.badgeTex = new THREE.CanvasTexture(this.badgeCanvas);
    this.badgeTex.colorSpace = THREE.SRGBColorSpace;
    this.badge = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 0.92, CARD_W * 0.92 * (96 / 256)),
      new THREE.MeshBasicMaterial({ map: this.badgeTex, transparent: true, depthWrite: false }),
    );
    this.badge.position.set(0, -CARD_H / 2 + 0.25, 0.02);
    this.badge.visible = false;

    this.lift.add(this.glow, this.edge, this.front, this.back, this.badge);
    this.body.add(this.lift);
    this.root.add(this.body);
    this.root.rotation.order = 'YXZ';
    this.root.userData.cardId = state.id;
    this.update(state);
  }

  update(state: CardState): void {
    this.state = state;
    const key = state.visible && !state.faceDown ? `${state.name}|${state.set}|${state.cn}|${state.state}` : 'back';
    if (key !== this.faceKey) {
      this.faceKey = key;
      if (key === 'back') {
        this.frontMat.map = cardBackTexture();
        this.frontMat.emissiveMap = cardBackTexture();
        this.frontMat.needsUpdate = true;
      } else {
        const want = key;
        cardFaceTexture(state).then((tex) => {
          if (this.faceKey !== want) return;
          this.frontMat.map = tex;
          this.frontMat.emissiveMap = tex;
          this.frontMat.needsUpdate = true;
        });
      }
    }
    this.drawBadge();
  }

  /** P/T, loyalty, damage and counters, drawn along the bottom of battlefield cards. */
  private drawBadge(): void {
    const s = this.state;
    const onField = s.zone === 'Battlefield' && s.visible;
    const counters = Object.entries(s.counters ?? {}).filter(([, n]) => n > 0);
    const showPT = s.creature && s.power !== undefined;
    const pt = showPT ? `${s.power}/${(s.toughness ?? 0) - (s.damage ?? 0)}` : '';
    // which way each stat moved from its base: counters, anthems, pumps, -X/-X effects
    const dp = showPT && s.basePower !== undefined ? s.power! - s.basePower : 0;
    const dt = showPT && s.baseToughness !== undefined ? (s.toughness ?? 0) - s.baseToughness : 0;
    const loyalty = s.planeswalker ? String(s.loyalty ?? '') : '';
    const icons = onField ? keywordIcons(s) : [];
    const key = `${onField}|${pt}|${dp},${dt}|${loyalty}|${s.damage}|${counters.map(([k, n]) => k + n).join(',')}|${icons.map((i) => i.glyph).join('')}`;
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    this.badge.visible = onField && (pt !== '' || loyalty !== '' || counters.length > 0 || icons.length > 0);
    if (!this.badge.visible) return;

    const g = this.badgeCanvas.getContext('2d')!;
    g.clearRect(0, 0, 256, 96);
    // keyword icons sit just left of the P/T box, newest-relevant first
    let left = 156;
    for (const icon of icons.slice(0, 4)) {
      left -= 38;
      g.beginPath();
      g.arc(left + 17, 51, 17, 0, Math.PI * 2);
      g.fillStyle = icon.bg;
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.stroke();
      g.fillStyle = icon.fg;
      g.font = `800 ${icon.glyph.length > 1 ? 15 : 21}px Inter, sans-serif`;
      g.textAlign = 'center';
      g.fillText(icon.glyph, left + 17, 58);
      g.textAlign = 'left';
    }
    if (counters.length) {
      const label = counters.map(([k, n]) => (n > 1 ? `${prettyCounter(k)} ×${n}` : prettyCounter(k))).join('  ');
      g.font = '700 26px Inter, sans-serif';
      const w = Math.min(Math.max(40, left - 8), g.measureText(label).width + 22);
      // P/T counters take the colour of the way they push the creature
      const tone = counterTone(counters);
      // saturated: the table's lighting greys out dark tints
      g.fillStyle = tone === 'up' ? '#1e9a46' : tone === 'down' ? '#c42a1e' : 'rgba(20,16,30,0.86)';
      roundRect(g, 4, 30, w, 50, 14);
      g.fill();
      g.fillStyle = tone ? '#ffffff' : '#e8dcff';
      g.fillText(label, 15, 64, w - 22);
    }
    if (pt) {
      const damaged = (s.damage ?? 0) > 0;
      const shade = (d: number, hurt = false) => (hurt || d < 0 ? '#c0281c' : d > 0 ? '#16803a' : '#15110c');
      const up = dp > 0 || dt > 0;
      const down = dp < 0 || dt < 0 || damaged;
      g.fillStyle = up && !down ? 'rgba(228,248,232,0.97)' : down && !up ? 'rgba(252,232,228,0.97)' : 'rgba(245,238,220,0.96)';
      roundRect(g, 160, 18, 92, 66, 16);
      g.fill();
      g.strokeStyle = up && !down ? '#1f9a48' : down && !up ? '#c0281c' : '#2a2117';
      g.lineWidth = up !== down ? 6 : 4;
      g.stroke();
      // power and toughness coloured separately: a +2/-1 shows green over red
      const [pw, tg] = pt.split('/');
      g.font = '800 40px Inter, sans-serif';
      const sw = g.measureText('/').width;
      const pwW = g.measureText(pw).width;
      const total = pwW + sw + g.measureText(tg).width;
      const scale = Math.min(1, 80 / total);
      g.save();
      g.translate(206 - (total * scale) / 2, 66);
      g.scale(scale, 1);
      g.fillStyle = shade(dp);
      g.fillText(pw, 0, 0);
      g.fillStyle = '#15110c';
      g.fillText('/', pwW, 0);
      g.fillStyle = shade(dt, damaged);
      g.fillText(tg, pwW + sw, 0);
      g.restore();
    } else if (loyalty) {
      g.fillStyle = 'rgba(30,24,16,0.92)';
      roundRect(g, 160, 18, 92, 66, 16);
      g.fill();
      g.strokeStyle = '#d6b25e';
      g.lineWidth = 4;
      g.stroke();
      g.fillStyle = '#f2e3b8';
      g.font = '800 40px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText(loyalty, 206, 66, 84);
      g.textAlign = 'left';
    }
    this.badgeTex.needsUpdate = true;
  }

  /**
   * Table cards take the scene's light and shadow; hand and stack cards (screen space) show the
   * printed card at its true colours, untouched by lighting or tone mapping.
   */
  setSpace(onTable: boolean): void {
    this.onTable = onTable;
    for (const m of [this.front, this.back, this.edge]) m.castShadow = onTable;
    // screen-space cards draw in the overlay pass, after bloom/tone mapping, so their art keeps its true colour
    for (const m of [this.front, this.back, this.edge, this.badge]) m.layers.set(onTable ? 0 : OVERLAY_LAYER);
    for (const mat of [this.frontMat, this.backMat]) {
      mat.color.setScalar(onTable ? 0.62 : 0);
      mat.emissiveIntensity = onTable ? 0.42 : 1;
      if (mat.toneMapped === onTable) continue;
      mat.toneMapped = onTable;
      mat.needsUpdate = true;
    }
  }

  setHighlight(h: Highlight): void {
    this.highlight = h;
  }

  /** 0 → intact, 1 → gone. */
  setDissolve(v: number, edge?: THREE.ColorRepresentation): void {
    this.dissolve.uDissolve.value = v;
    if (edge) this.dissolve.uEdge.value.set(edge);
    this.badge.visible = v === 0 && this.badge.visible;
  }

  /** Flush the card red for a moment (it was just dealt damage). */
  hurt(): void {
    this.hurtT = 1;
  }

  tick(dt: number): void {
    this.time += dt;
    if (this.hurtT > 0) {
      this.hurtT = Math.max(0, this.hurtT - dt * 1.6);
      const k = this.hurtT * this.hurtT;
      this.frontMat.emissive.setRGB(1 + k * 1.6, 1 - k * 0.6, 1 - k * 0.65);
    }
    const target = this.highlight === 'none' && !this.hovered ? 0 : 1;
    this.glowStrength += (target - this.glowStrength) * Math.min(1, dt * 10);
    const color = this.highlight === 'none' ? HOVER_COLOR : HIGHLIGHT_COLORS[this.highlight];
    // targets flicker like the design's fire frame; everything else breathes
    const pulse = this.highlight === 'target'
      ? 0.8 + 0.12 * Math.sin(this.time * 13.0) + 0.08 * Math.sin(this.time * 31.0 + 1.3)
      : 0.78 + 0.22 * Math.sin(this.time * 4.2);
    this.glowMat.color.copy(color).multiplyScalar(this.glowStrength * pulse);
    this.glow.visible = this.glowStrength > 0.01;

    // flyers float above the battlefield with a slow bob and sway (lower while tapped)
    const s = this.state;
    const flying = !!s.flying && s.zone === 'Battlefield' && s.visible && this.onTable;
    const want = flying ? (s.tapped ? 1.0 : 2.2) : 0;
    this.hoverH += (want - this.hoverH) * Math.min(1, dt * 3);
    if (this.hoverH > 0.002) {
      const k = this.hoverH;
      this.lift.position.z = k + Math.sin(this.time * 1.7) * 0.11 * k;
      this.lift.rotation.x = Math.sin(this.time * 1.1 + 0.6) * 0.045 * k;
      this.lift.rotation.y = Math.cos(this.time * 0.9) * 0.05 * k;
    } else if (this.lift.position.z !== 0) {
      this.lift.position.set(0, 0, 0);
      this.lift.rotation.set(0, 0, 0);
    }
  }

  get meshes(): THREE.Object3D[] {
    return [this.front, this.back, this.edge];
  }

  dispose(): void {
    this.root.removeFromParent();
    this.frontMat.dispose();
    this.backMat.dispose();
    this.glowMat.dispose();
    this.badgeTex.dispose();
  }
}

/**
 * A P/T counter's two numbers, signed. The bridge sends Forge's counter names ("+1/+1", "-0/-1");
 * enum-style keys ("P1P1", "M1M1") are understood too.
 */
function ptCounter(k: string): [number, number] | null {
  let m = /^([+\-−])(\d+)\/([+\-−])(\d+)$/.exec(k);
  if (!m) {
    const e = /^([PM])(\d)([PM])(\d)$/.exec(k);
    if (!e) return null;
    m = [k, e[1] === 'P' ? '+' : '-', e[2], e[3] === 'P' ? '+' : '-', e[4]] as unknown as RegExpExecArray;
  }
  const v = (sign: string, n: string) => (sign === '+' ? 1 : -1) * Number(n);
  return [v(m[1], m[2]), v(m[3], m[4])];
}

/** Whether a card's P/T counters push it up, down, or neither/both. */
function counterTone(counters: [string, number][]): 'up' | 'down' | '' {
  const signs = new Set(counters.map(([k]) => ptCounter(k)).filter((c): c is [number, number] => !!c).map(([p, t]) => Math.sign(p + t)).filter((v) => v !== 0));
  return signs.size !== 1 ? '' : signs.has(1) ? 'up' : 'down';
}

function prettyCounter(k: string): string {
  const pt = ptCounter(k);
  if (pt) return pt.map((n) => (n < 0 ? `−${-n}` : `+${n}`)).join('/');
  if (k.toUpperCase() === 'LOYALTY') return 'Loyalty';
  return k.charAt(0) + k.slice(1).toLowerCase();
}

interface KeywordIcon {
  glyph: string;
  bg: string;
  fg: string;
}

const KEYWORD_ICONS: Record<string, KeywordIcon> = {
  Haste: { glyph: '»', bg: '#e8552e', fg: '#fff' },
  Vigilance: { glyph: '◉', bg: '#f1e6c4', fg: '#3a2c10' },
  Trample: { glyph: '▲', bg: '#5c9c4a', fg: '#fff' },
  Deathtouch: { glyph: '☠', bg: '#3a2a46', fg: '#e8dcff' },
  Lifelink: { glyph: '♥', bg: '#f4f0e4', fg: '#c0281c' },
  'First Strike': { glyph: '1st', bg: '#d8c27a', fg: '#2a1d05' },
  'Double Strike': { glyph: '2×', bg: '#d8c27a', fg: '#2a1d05' },
  Reach: { glyph: '↟', bg: '#3f7d4e', fg: '#fff' },
  Menace: { glyph: '‼', bg: '#7a1d1d', fg: '#fff' },
  Hexproof: { glyph: '◈', bg: '#2f6fb0', fg: '#fff' },
  Indestructible: { glyph: '◆', bg: '#9aa0aa', fg: '#1a1d22' },
  Defender: { glyph: '▣', bg: '#6c6255', fg: '#fff' },
};

/** Small badges for keywords, and a red no-entry mark on a creature that can't block. */
function keywordIcons(s: CardState): KeywordIcon[] {
  const out: KeywordIcon[] = [];
  if (s.cantBlock && !(s.keywords ?? []).includes('Defender')) out.push({ glyph: '⊘', bg: '#c0281c', fg: '#fff' });
  for (const k of s.keywords ?? []) if (KEYWORD_ICONS[k]) out.push(KEYWORD_ICONS[k]);
  return out;
}
