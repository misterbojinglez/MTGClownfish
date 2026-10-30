import * as THREE from 'three';
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
const GLOW_GEO = new THREE.PlaneGeometry(CARD_W * 1.42, CARD_H * 1.32);

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 340;
  const g = c.getContext('2d')!;
  g.filter = 'blur(14px)';
  g.strokeStyle = '#fff';
  g.lineWidth = 22;
  roundRect(g, 44, 44, 168, 252, 18);
  g.stroke();
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

export type Highlight = 'none' | 'playable' | 'autoPay' | 'selectable' | 'chosen' | 'attacking' | 'blocking' | 'target';

const HIGHLIGHT_COLORS: Record<Highlight, THREE.Color> = {
  none: new THREE.Color(0, 0, 0),
  playable: new THREE.Color('#3aa6ff').multiplyScalar(2.2),
  autoPay: new THREE.Color('#7fd0ff').multiplyScalar(2.6),
  selectable: new THREE.Color('#ffd34a').multiplyScalar(2.0),
  chosen: new THREE.Color('#ff9a2e').multiplyScalar(2.6),
  attacking: new THREE.Color('#ff4a3a').multiplyScalar(2.2),
  blocking: new THREE.Color('#d9d9ff').multiplyScalar(1.8),
  target: new THREE.Color('#ff5a5a').multiplyScalar(2.4),
};

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

  constructor(state: CardState) {
    this.id = state.id;
    this.state = state;

    this.frontMat = new THREE.MeshStandardMaterial({ map: cardBackTexture(), roughness: 0.48, metalness: 0.05 });
    this.backMat = new THREE.MeshStandardMaterial({ map: cardBackTexture(), roughness: 0.55, metalness: 0.05 });
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

    this.body.add(this.glow, this.edge, this.front, this.back, this.badge);
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
        this.frontMat.needsUpdate = true;
      } else {
        const want = key;
        cardFaceTexture(state).then((tex) => {
          if (this.faceKey !== want) return;
          this.frontMat.map = tex;
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
    const pt = s.creature && s.power !== undefined ? `${s.power}/${(s.toughness ?? 0) - (s.damage ?? 0)}` : '';
    const loyalty = s.planeswalker ? String(s.loyalty ?? '') : '';
    const key = `${onField}|${pt}|${loyalty}|${s.damage}|${counters.map(([k, n]) => k + n).join(',')}`;
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    this.badge.visible = onField && (pt !== '' || loyalty !== '' || counters.length > 0);
    if (!this.badge.visible) return;

    const g = this.badgeCanvas.getContext('2d')!;
    g.clearRect(0, 0, 256, 96);
    if (counters.length) {
      const label = counters.map(([k, n]) => (n > 1 ? `${n}× ${prettyCounter(k)}` : prettyCounter(k))).join('  ');
      g.font = '600 26px Inter, sans-serif';
      const w = Math.min(150, g.measureText(label).width + 22);
      g.fillStyle = 'rgba(20,16,30,0.86)';
      roundRect(g, 4, 30, w, 50, 14);
      g.fill();
      g.fillStyle = '#e8dcff';
      g.fillText(label, 15, 64, 130);
    }
    const value = pt || loyalty;
    if (value) {
      const damaged = (s.damage ?? 0) > 0;
      g.fillStyle = s.planeswalker ? 'rgba(30,24,16,0.92)' : 'rgba(245,238,220,0.96)';
      roundRect(g, 160, 18, 92, 66, 16);
      g.fill();
      g.strokeStyle = s.planeswalker ? '#d6b25e' : '#2a2117';
      g.lineWidth = 4;
      g.stroke();
      g.fillStyle = s.planeswalker ? '#f2e3b8' : damaged ? '#c0281c' : '#15110c';
      g.font = '800 40px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText(value, 206, 66, 84);
      g.textAlign = 'left';
    }
    this.badgeTex.needsUpdate = true;
  }

  setShadow(on: boolean): void {
    for (const m of [this.front, this.back, this.edge]) m.castShadow = on;
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

  tick(dt: number): void {
    this.time += dt;
    const target = this.highlight === 'none' && !this.hovered ? 0 : 1;
    this.glowStrength += (target - this.glowStrength) * Math.min(1, dt * 10);
    const color = this.highlight === 'none' ? HIGHLIGHT_COLORS.playable.clone().multiplyScalar(0.55) : HIGHLIGHT_COLORS[this.highlight];
    const pulse = 0.78 + 0.22 * Math.sin(this.time * 4.2);
    this.glowMat.color.copy(color).multiplyScalar(this.glowStrength * pulse);
    this.glow.visible = this.glowStrength > 0.01;
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

function prettyCounter(k: string): string {
  if (k === 'P1P1') return '+1/+1';
  if (k === 'M1M1') return '−1/−1';
  if (k === 'LOYALTY') return 'Loyalty';
  return k.charAt(0) + k.slice(1).toLowerCase();
}
