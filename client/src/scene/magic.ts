import * as THREE from 'three';
import gsap from 'gsap';
import type { Stage } from './stage';
import { particleAllowed } from '../settings';

/**
 * Coloured magic. Each colour of mana has its own look, drawn with textured sprites (a procedural atlas):
 * green sheds leaves, black seeps a miasma, red burns, white falls as blessed light, blue splashes.
 * Plus wounds: crimson shards that spatter onto the table, slash marks, and table stains.
 */

export type Hue = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

export function huesOf(colors: string | undefined): Hue[] {
  const c = [...new Set((colors ?? '').replace(/[^WUBRG]/g, '').split(''))].filter(Boolean) as Hue[];
  return c.length ? c : ['C'];
}

// ---- sprite atlas -------------------------------------------------------------------------------

const CELL = 128;
const GRID = 4;
export const enum Frame {
  Leaf = 0,
  Smoke = 1,
  Flame = 2,
  Star = 3,
  Drop = 4,
  Shard = 5,
  Streak = 6,
  Dot = 7,
  Leaf2 = 8,
  Wisp = 9,
  Splat = 10,
}

function buildAtlas(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = CELL * GRID;
  const g = cv.getContext('2d')!;
  const cell = (i: number, draw: () => void) => {
    g.save();
    g.translate((i % GRID) * CELL + CELL / 2, Math.floor(i / GRID) * CELL + CELL / 2);
    draw();
    g.restore();
  };
  const leaf = (wide: number, lobes: boolean) => () => {
    g.rotate(-0.5);
    const grd = g.createLinearGradient(-40, 0, 40, 0);
    grd.addColorStop(0, '#dcdcdc');
    grd.addColorStop(0.5, '#ffffff');
    grd.addColorStop(1, '#bdbdbd');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -54);
    if (lobes) {
      for (let k = 0; k < 4; k++) g.quadraticCurveTo(wide + 10, -42 + k * 22, wide * 0.4, -30 + k * 22);
      g.quadraticCurveTo(10, 40, 0, 52);
      for (let k = 3; k >= 0; k--) g.quadraticCurveTo(-wide - 10, -20 + k * 22, -wide * 0.4, -30 + k * 22);
    } else {
      g.bezierCurveTo(wide, -30, wide, 26, 0, 52);
      g.bezierCurveTo(-wide, 26, -wide, -30, 0, -54);
    }
    g.fill();
    // midrib and veins
    g.strokeStyle = 'rgba(90,90,90,0.55)';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(0, -48);
    g.lineTo(0, 60);
    for (let k = -3; k <= 2; k++) {
      g.moveTo(0, k * 13);
      g.lineTo(wide * 0.6, k * 13 - 12);
      g.moveTo(0, k * 13);
      g.lineTo(-wide * 0.6, k * 13 - 12);
    }
    g.stroke();
  };
  cell(Frame.Leaf, leaf(30, false));
  cell(Frame.Leaf2, leaf(26, true));
  cell(Frame.Smoke, () => {
    for (let k = 0; k < 9; k++) {
      const x = (Math.random() - 0.5) * 50;
      const y = (Math.random() - 0.5) * 50;
      const r = 26 + Math.random() * 22;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.42)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  });
  cell(Frame.Wisp, () => {
    g.strokeStyle = 'rgba(255,255,255,0.0)';
    for (let k = 0; k < 3; k++) {
      const grd = g.createLinearGradient(0, -60, 0, 60);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.strokeStyle = grd;
      g.lineWidth = 9 - k * 2.5;
      g.beginPath();
      g.moveTo(-10 + k * 8, 60);
      g.bezierCurveTo(30, 20, -40, -10, 10 - k * 6, -60);
      g.stroke();
    }
  });
  cell(Frame.Flame, () => {
    const grd = g.createRadialGradient(0, 18, 2, 0, 8, 54);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -60);
    g.bezierCurveTo(22, -24, 40, 10, 30, 32);
    g.bezierCurveTo(20, 56, -20, 56, -30, 32);
    g.bezierCurveTo(-40, 10, -22, -24, 0, -60);
    g.fill();
  });
  cell(Frame.Star, () => {
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, 40);
    glow.addColorStop(0, 'rgba(255,255,255,0.9)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glow;
    g.fillRect(-64, -64, 128, 128);
    g.fillStyle = '#fff';
    for (const [w, l] of [[5, 60], [3, 34]] as const) {
      for (let k = 0; k < (l === 60 ? 2 : 2); k++) {
        g.save();
        g.rotate((k * Math.PI) / 2 + (l === 60 ? 0 : Math.PI / 4));
        g.beginPath();
        g.moveTo(0, -l);
        g.lineTo(w, 0);
        g.lineTo(0, l);
        g.lineTo(-w, 0);
        g.fill();
        g.restore();
      }
    }
  });
  cell(Frame.Drop, () => {
    const grd = g.createRadialGradient(-8, -6, 2, 0, 0, 40);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    grd.addColorStop(0.9, 'rgba(255,255,255,0.75)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(0, 0, 40, 0, Math.PI * 2);
    g.fill();
  });
  cell(Frame.Shard, () => {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(-6, -52);
    g.lineTo(24, -10);
    g.lineTo(10, 48);
    g.lineTo(-22, 20);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.moveTo(-6, -52);
    g.lineTo(10, 48);
    g.lineTo(-22, 20);
    g.closePath();
    g.fill();
  });
  cell(Frame.Streak, () => {
    const grd = g.createLinearGradient(0, -62, 0, 62);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(-4, -62, 8, 124);
  });
  cell(Frame.Dot, () => {
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 60);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(-64, -64, 128, 128);
  });
  cell(Frame.Splat, () => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, 0, 30, 0, Math.PI * 2);
    g.fill();
    for (let k = 0; k < 11; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = 30 + Math.random() * 26;
      g.beginPath();
      g.arc(Math.cos(a) * d, Math.sin(a) * d, 3 + Math.random() * 7, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(Math.cos(a - 0.15) * 26, Math.sin(a - 0.15) * 26);
      g.lineTo(Math.cos(a) * d, Math.sin(a) * d);
      g.lineTo(Math.cos(a + 0.15) * 26, Math.sin(a + 0.15) * 26);
      g.fill();
    }
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  // rows are addressed top-down, like gl_PointCoord
  tex.flipY = false;
  return tex;
}

// ---- sprite particles ---------------------------------------------------------------------------

export interface SpriteOpts {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  frame: Frame;
  color: THREE.ColorRepresentation;
  /** colour it shifts to by the end of its life */
  colorEnd?: THREE.ColorRepresentation;
  size: number;
  life: number;
  alpha?: number;
  rot?: number;
  spin?: number;
  drag?: number;
  gravity?: number;
  /** size multiplier reached at the end of life (smoke billows: >1) */
  grow?: number;
  /** side-to-side flutter amplitude (leaves) */
  sway?: number;
  /** share of life spent fading in */
  fadeIn?: number;
  /** settles onto the table instead of falling through it, and lingers there */
  floor?: boolean;
}

interface Sprite extends Required<Omit<SpriteOpts, 'pos' | 'vel' | 'color' | 'colorEnd'>> {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  c0: THREE.Color;
  c1: THREE.Color;
  maxLife: number;
  phase: number;
  landed: boolean;
}

class SpriteParticles {
  private readonly items: Sprite[] = [];
  private readonly geo = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly rot: Float32Array;
  private readonly frame: Float32Array;
  private cursor = 0;
  private t = 0;
  /** sprites alive; with none, and the buffers already cleared, a frame does no work */
  private live = 0;
  private cleared = true;

  constructor(stage: Stage, atlas: THREE.Texture, private readonly max: number, additive: boolean) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.frame = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      this.items.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), c0: new THREE.Color(), c1: new THREE.Color(), frame: 0, size: 1, life: 0, maxLife: 1,
        alpha: 1, rot: 0, spin: 0, drag: 0, gravity: 0, grow: 1, sway: 0, fadeIn: 0, floor: false, phase: 0, landed: false,
      });
    }
    const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', attr(this.pos, 3));
    this.geo.setAttribute('color', attr(this.col, 3));
    this.geo.setAttribute('size', attr(this.size, 1));
    this.geo.setAttribute('alpha', attr(this.alpha, 1));
    this.geo.setAttribute('rot', attr(this.rot, 1));
    this.geo.setAttribute('frame', attr(this.frame, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uAtlas: { value: atlas }, uBoost: { value: additive ? 1.8 : 1.0 }, uScale: { value: 800 } },
      vertexShader: /* glsl */ `
        uniform float uScale;
        attribute float size; attribute float alpha; attribute float rot; attribute float frame; attribute vec3 color;
        varying vec3 vColor; varying float vAlpha; varying float vRot; varying float vFrame;
        void main() {
          vColor = color; vAlpha = alpha; vRot = rot; vFrame = frame;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // size is a diameter in table units
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas; uniform float uBoost;
        varying vec3 vColor; varying float vAlpha; varying float vRot; varying float vFrame;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float c = cos(vRot), s = sin(vRot);
          p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
          if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) discard;
          vec2 cell = vec2(mod(vFrame, ${GRID}.0), floor(vFrame / ${GRID}.0));
          vec4 t = texture2D(uAtlas, (cell + vec2(p.x, p.y)) / ${GRID}.0);
          float a = t.a * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(t.rgb * vColor * uBoost, a);
        }`,
    });
    const pts = new THREE.Points(this.geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = additive ? 12 : 11;
    stage.scene.add(pts);
    const buf = new THREE.Vector2();
    stage.onTick((dt) => {
      stage.renderer.getDrawingBufferSize(buf);
      mat.uniforms.uScale.value = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2)));
      this.tick(dt);
    });
    stage.onBusy(() => this.live > 0);
  }

  emit(o: SpriteOpts): void {
    if (!particleAllowed()) return;
    const p = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    if (!p.alive) this.live++;
    this.cleared = false;
    p.alive = true;
    p.landed = false;
    p.pos.copy(o.pos);
    p.vel.copy(o.vel);
    p.c0.set(o.color);
    p.c1.set(o.colorEnd ?? o.color);
    p.frame = o.frame;
    p.size = o.size;
    p.life = p.maxLife = o.life;
    p.alpha = o.alpha ?? 1;
    p.rot = o.rot ?? Math.random() * Math.PI * 2;
    p.spin = o.spin ?? 0;
    p.drag = o.drag ?? 1.2;
    p.gravity = o.gravity ?? 0;
    p.grow = o.grow ?? 1;
    p.sway = o.sway ?? 0;
    p.fadeIn = o.fadeIn ?? 0.08;
    p.floor = o.floor ?? false;
    p.phase = Math.random() * 10;
  }

  private tick(dt: number): void {
    this.t += dt;
    if (this.cleared) return;
    const tmp = new THREE.Color();
    for (let i = 0; i < this.max; i++) {
      const p = this.items[i];
      if (!p.alive) {
        this.alpha[i] = 0;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.live--;
        this.alpha[i] = 0;
        continue;
      }
      if (!p.landed) {
        p.vel.multiplyScalar(Math.exp(-p.drag * dt));
        p.vel.y -= p.gravity * dt;
        p.pos.addScaledVector(p.vel, dt);
        if (p.sway) {
          // a falling leaf rocks side to side as it drifts
          p.pos.x += Math.sin(this.t * 3.1 + p.phase) * p.sway * dt;
          p.pos.z += Math.cos(this.t * 2.3 + p.phase) * p.sway * 0.6 * dt;
          p.rot += Math.sin(this.t * 3.1 + p.phase) * 1.6 * dt;
        }
        p.rot += p.spin * dt;
        if (p.floor && p.pos.y < 0.06 && p.vel.y < 0) {
          p.pos.y = 0.06;
          p.landed = true;
          p.life = Math.max(p.life, 1.2 + Math.random() * 0.8);
          p.maxLife = Math.max(p.maxLife, p.life);
        }
      }
      const k = p.life / p.maxLife; // 1 → 0
      const age = 1 - k;
      this.pos[i * 3] = p.pos.x;
      this.pos[i * 3 + 1] = p.pos.y;
      this.pos[i * 3 + 2] = p.pos.z;
      tmp.copy(p.c0).lerp(p.c1, age);
      this.col[i * 3] = tmp.r;
      this.col[i * 3 + 1] = tmp.g;
      this.col[i * 3 + 2] = tmp.b;
      this.size[i] = p.size * (1 + (p.grow - 1) * age) * (p.landed ? 1.25 : 1);
      this.rot[i] = p.rot;
      this.frame[i] = p.frame;
      const fadeIn = p.fadeIn > 0 ? Math.min(1, age / p.fadeIn) : 1;
      this.alpha[i] = p.alpha * fadeIn * Math.min(1, k * 2.5);
    }
    for (const n of ['position', 'color', 'size', 'alpha', 'rot', 'frame']) (this.geo.attributes[n] as THREE.BufferAttribute).needsUpdate = true;
    if (this.live === 0) this.cleared = true;
  }
}

// ---- colour signatures --------------------------------------------------------------------------

const r = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const LEAF_GREENS = ['#58b85a', '#7fcf4e', '#2f8f3a', '#a6d955', '#3e9e4a', '#c9d65a'];
const MIASMA = ['#2a1238', '#3b1650', '#1c0c26', '#4a1e5e'];
const MIASMA_GLOW = ['#9b4dff', '#c06bff', '#5dff9a'];
const FIRE_HOT = ['#fff2b0', '#ffd36a', '#ffb347'];
const HOLY = ['#fff6d6', '#ffe9a8', '#ffffff', '#ffd98a'];
const WATER = ['#7fd0ff', '#4aa8ff', '#bfe9ff'];

export class Magic {
  readonly add: SpriteParticles;
  readonly norm: SpriteParticles;
  private readonly slashTex: THREE.Texture;

  constructor(private readonly stage: Stage) {
    const atlas = buildAtlas();
    this.add = new SpriteParticles(stage, atlas, 3500, true);
    this.norm = new SpriteParticles(stage, atlas, 2500, false);
    this.slashTex = buildSlash();
  }

  /**
   * A burst in the card's colours: a spell resolving, a permanent arriving, an ability firing.
   * strength ~0.4 (ability) … 1 (spell) … 1.6 (big creature)
   */
  burst(pos: THREE.Vector3, colors: string | undefined, strength = 1): void {
    const hues = huesOf(colors);
    const share = strength / Math.sqrt(hues.length);
    for (const h of hues) this.burstHue(h, pos, share);
  }

  /** Called every frame while a card or bolt flies: what it sheds along the way. */
  trail(pos: THREE.Vector3, colors: string | undefined, rate = 1): void {
    for (const h of huesOf(colors)) {
      if (Math.random() > rate * 0.9) continue;
      const jitter = v3(r(-0.25, 0.25), r(-0.25, 0.25), r(-0.25, 0.25));
      const at = pos.clone().add(jitter);
      switch (h) {
        case 'G':
          if (Math.random() < 0.45) this.leaf(at, v3(r(-1, 1), r(-0.5, 1), r(-1, 1)), 0.45);
          break;
        case 'B':
          this.norm.emit({ pos: at, vel: v3(r(-0.4, 0.4), r(0.2, 0.8), r(-0.4, 0.4)), frame: Frame.Smoke, color: pick(MIASMA), size: r(0.9, 1.5), life: r(0.6, 1.1), alpha: 0.75, grow: 2.2, spin: r(-1, 1) });
          if (Math.random() < 0.3) this.add.emit({ pos: at, vel: v3(r(-0.5, 0.5), r(0, 0.8), r(-0.5, 0.5)), frame: Frame.Dot, color: pick(MIASMA_GLOW), size: r(0.2, 0.35), life: r(0.4, 0.8) });
          break;
        case 'R':
          this.add.emit({ pos: at, vel: v3(r(-0.4, 0.4), r(0.6, 1.6), r(-0.4, 0.4)), frame: Frame.Flame, color: pick(FIRE_HOT), colorEnd: '#ff2a00', size: r(0.6, 1.0), life: r(0.25, 0.45), rot: r(-0.3, 0.3), grow: 0.4 });
          if (Math.random() < 0.4) this.add.emit({ pos: at, vel: v3(r(-1.5, 1.5), r(0.5, 2.5), r(-1.5, 1.5)), frame: Frame.Dot, color: '#ffb347', colorEnd: '#ff3a10', size: r(0.12, 0.22), life: r(0.4, 0.9), gravity: -1 });
          break;
        case 'W':
          this.add.emit({ pos: at, vel: v3(r(-0.3, 0.3), r(0.1, 0.6), r(-0.3, 0.3)), frame: Frame.Star, color: pick(HOLY), size: r(0.35, 0.6), life: r(0.4, 0.8), spin: r(-2, 2) });
          break;
        case 'U':
          this.add.emit({ pos: at, vel: v3(r(-0.5, 0.5), r(-0.2, 0.4), r(-0.5, 0.5)), frame: Frame.Drop, color: pick(WATER), size: r(0.25, 0.45), life: r(0.4, 0.8), gravity: 2 });
          break;
        case 'C':
          this.add.emit({ pos: at, vel: v3(r(-0.3, 0.3), r(0, 0.4), r(-0.3, 0.3)), frame: Frame.Dot, color: '#dcdcec', size: r(0.2, 0.3), life: r(0.3, 0.6) });
          break;
      }
    }
  }

  /** A themed projectile from a spell (or source) to its target. Resolves on contact. */
  bolt(from: THREE.Vector3, to: THREE.Vector3, colors: string | undefined, duration = 0.5, strength = 1): Promise<void> {
    const mid = from.clone().lerp(to, 0.5).add(v3(0, 3 + from.distanceTo(to) * 0.12, 0));
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const st = { t: 0 };
    const hues = huesOf(colors);
    return new Promise((resolve) => {
      gsap.to(st, {
        t: 1,
        duration,
        ease: 'power1.in',
        onUpdate: () => {
          const p = curve.getPoint(st.t);
          // a bright head in the lead colour, and the colours' trails behind it
          this.add.emit({ pos: p, vel: v3(0, 0, 0), frame: Frame.Dot, color: hueColor(hues[0]), size: 1.1 * strength, life: 0.12 });
          for (let k = 0; k < 2; k++) this.trail(p, colors, 1);
        },
        onComplete: () => {
          this.burst(to, colors, 0.8 * strength);
          resolve();
        },
      });
    });
  }

  private leaf(at: THREE.Vector3, vel: THREE.Vector3, size = 0.6): void {
    this.norm.emit({
      pos: at, vel, frame: Math.random() < 0.6 ? Frame.Leaf : Frame.Leaf2, color: pick(LEAF_GREENS), size: r(size * 0.8, size * 1.3),
      life: r(1.4, 2.4), drag: 2.2, gravity: 1.1, sway: r(1.5, 3), spin: r(-2, 2), floor: true, fadeIn: 0.04,
    });
  }

  private burstHue(h: Hue, pos: THREE.Vector3, s: number): void {
    const n = (k: number) => Math.round(k * s);
    switch (h) {
      case 'G': {
        // a whirl of leaves thrown up and out, drifting down and settling on the table
        for (let i = 0; i < n(44); i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = r(3, 7) * Math.min(1.4, s);
          this.leaf(pos.clone().add(v3(Math.cos(a) * 0.6, r(0.2, 1), Math.sin(a) * 0.6)), v3(Math.cos(a) * sp, r(3, 7), Math.sin(a) * sp), 0.95);
        }
        for (let i = 0; i < n(26); i++) {
          this.add.emit({ pos: pos.clone().add(v3(r(-1.5, 1.5), r(0, 1), r(-1.5, 1.5))), vel: v3(r(-0.6, 0.6), r(0.6, 2), r(-0.6, 0.6)), frame: Frame.Dot, color: pick(['#d8ff8a', '#a8f070', '#fff7a0']), size: r(0.15, 0.3), life: r(0.8, 1.6), sway: 1 });
        }
        this.ring(pos, '#7fe07a', 0.9 * s);
        break;
      }
      case 'B': {
        // a miasma: dark smoke welling up and creeping low across the table, a sickly glow inside it,
        // curls of vapour rising, motes drifting
        for (let i = 0; i < n(30); i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = r(1.2, 4.2) * Math.min(1.3, s);
          this.norm.emit({ pos: pos.clone().add(v3(r(-0.6, 0.6), r(0.1, 0.5), r(-0.6, 0.6))), vel: v3(Math.cos(a) * sp, r(0.1, 0.7), Math.sin(a) * sp), frame: Frame.Smoke, color: pick(MIASMA), colorEnd: '#07030b', size: r(1.4, 2.4) * Math.min(1.3, s), life: r(1.6, 2.8), alpha: r(0.45, 0.75), grow: 3.2, spin: r(-0.5, 0.5), drag: 1.1, fadeIn: 0.12 });
        }
        for (let i = 0; i < n(12); i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = r(0.6, 2.2);
          this.add.emit({ pos: pos.clone().add(v3(r(-0.8, 0.8), r(0.1, 0.4), r(-0.8, 0.8))), vel: v3(Math.cos(a) * sp, r(0.05, 0.4), Math.sin(a) * sp), frame: Frame.Smoke, color: pick(['#3a0f5c', '#24401a', '#2e0d48']), size: r(1.4, 2.2), life: r(1.2, 2), alpha: 0.22, grow: 2.4, fadeIn: 0.25 });
        }
        for (let i = 0; i < n(12); i++) {
          this.norm.emit({ pos: pos.clone().add(v3(r(-1.4, 1.4), r(0.3, 1.2), r(-1.4, 1.4))), vel: v3(r(-0.4, 0.4), r(0.8, 1.8), r(-0.4, 0.4)), frame: Frame.Wisp, color: pick(['#2a0f3a', '#3e1858']), size: r(1.6, 2.6), life: r(1.2, 2), alpha: 0.65, spin: r(-0.8, 0.8), fadeIn: 0.25, grow: 1.4 });
        }
        for (let i = 0; i < n(34); i++) {
          this.add.emit({ pos: pos.clone().add(v3(r(-2, 2), r(0.1, 1.2), r(-2, 2))), vel: v3(r(-0.6, 0.6), r(0.2, 1), r(-0.6, 0.6)), frame: Frame.Dot, color: pick(MIASMA_GLOW), size: r(0.14, 0.3), life: r(1, 2.2), fadeIn: 0.3, sway: 0.8 });
        }
        this.ring(pos, '#8a3cff', 0.8 * s);
        break;
      }
      case 'R': {
        // fire that burns for a moment: waves of flame, embers thrown high, smoke rolling off the top
        const wave = (k: number) => {
          for (let i = 0; i < n(26 - k * 5); i++) {
            const a = Math.random() * Math.PI * 2;
            const d = r(0, 1.4);
            this.add.emit({ pos: pos.clone().add(v3(Math.cos(a) * d, r(0, 0.4), Math.sin(a) * d)), vel: v3(Math.cos(a) * r(0.4, 2.2), r(2.5, 6.5) * Math.min(1.3, s), Math.sin(a) * r(0.4, 2.2)), frame: Frame.Flame, color: pick(FIRE_HOT), colorEnd: pick(['#e0300a', '#b81800']), size: r(1.1, 2.0) * Math.min(1.3, s), life: r(0.5, 0.95), rot: r(-0.35, 0.35), grow: 0.4, drag: 2, fadeIn: 0.05 });
          }
        };
        for (let k = 0; k < 4; k++) gsap.delayedCall(k * 0.11, () => wave(k));
        for (let i = 0; i < n(46); i++) {
          this.add.emit({ pos: pos.clone().add(v3(r(-0.8, 0.8), r(0.2, 1), r(-0.8, 0.8))), vel: v3(r(-4, 4), r(3, 10), r(-4, 4)), frame: Frame.Dot, color: '#ffc061', colorEnd: '#ff2a00', size: r(0.12, 0.26), life: r(0.9, 1.8), drag: 1.4, gravity: 3.5, sway: 1.2 });
        }
        for (let i = 0; i < n(10); i++) {
          this.norm.emit({ pos: pos.clone().add(v3(r(-0.6, 0.6), r(1.5, 2.5), r(-0.6, 0.6))), vel: v3(r(-0.4, 0.4), r(1, 2.2), r(-0.4, 0.4)), frame: Frame.Smoke, color: '#2a1d18', size: r(1.6, 2.4), life: r(1.2, 1.9), alpha: 0.5, grow: 2.4, fadeIn: 0.35 });
        }
        this.light(pos, '#ff7a2a', 70 * s, 0.9);
        this.ring(pos, '#ff8a3a', 1.1 * s);
        break;
      }
      case 'W': {
        // blessed light: a beam from above, a halo on the table, motes of light rising
        this.beam(pos, s);
        for (let i = 0; i < n(36); i++) {
          const a = Math.random() * Math.PI * 2;
          const d = r(0.2, 1.8);
          this.add.emit({ pos: pos.clone().add(v3(Math.cos(a) * d, r(0, 2.5), Math.sin(a) * d)), vel: v3(Math.cos(a) * 0.3, r(0.4, 1.6), Math.sin(a) * 0.3), frame: Frame.Star, color: pick(HOLY), size: r(0.35, 0.8), life: r(0.9, 1.7), spin: r(-1.5, 1.5), fadeIn: 0.25 });
        }
        for (let i = 0; i < n(18); i++) {
          this.add.emit({ pos: pos.clone().add(v3(r(-1.2, 1.2), r(4, 8), r(-1.2, 1.2))), vel: v3(0, r(-9, -5), 0), frame: Frame.Streak, color: '#fff3c8', size: r(0.8, 1.4), life: r(0.35, 0.6), rot: 0, drag: 0 });
        }
        this.ring(pos, '#ffe9a0', 1.2 * s);
        this.light(pos, '#fff0c0', 50 * s, 0.9);
        break;
      }
      case 'U': {
        for (let i = 0; i < n(36); i++) {
          const a = Math.random() * Math.PI * 2;
          this.add.emit({ pos: pos.clone().add(v3(r(-0.5, 0.5), r(0.2, 0.8), r(-0.5, 0.5))), vel: v3(Math.cos(a) * r(2, 5), r(3, 7), Math.sin(a) * r(2, 5)), frame: Frame.Drop, color: pick(WATER), size: r(0.25, 0.5), life: r(0.6, 1.1), gravity: 12, drag: 0.6, floor: true });
        }
        for (let i = 0; i < n(10); i++) {
          this.norm.emit({ pos: pos.clone().add(v3(r(-1, 1), r(0.2, 1), r(-1, 1))), vel: v3(r(-0.6, 0.6), r(0.2, 0.7), r(-0.6, 0.6)), frame: Frame.Smoke, color: '#bfe4ff', size: r(1.2, 2), life: r(0.9, 1.5), alpha: 0.35, grow: 2 });
        }
        this.ring(pos, '#6ec4ff', 0.8 * s);
        this.ring(pos, '#6ec4ff', 0.5 * s, 0.18);
        break;
      }
      case 'C': {
        for (let i = 0; i < n(26); i++) {
          const a = Math.random() * Math.PI * 2;
          this.add.emit({ pos: pos.clone().add(v3(0, r(0.2, 1), 0)), vel: v3(Math.cos(a) * r(2, 5), r(0.5, 3), Math.sin(a) * r(2, 5)), frame: Math.random() < 0.3 ? Frame.Star : Frame.Dot, color: '#e2e2f2', size: r(0.2, 0.45), life: r(0.4, 0.8), drag: 3, spin: 2 });
        }
        this.ring(pos, '#d8d8ec', 0.7 * s);
        break;
      }
    }
  }

  // ---- wounds -----------------------------------------------------------------------------------

  /**
   * Damage that lands: crimson shards spray away from the blow (from = where it came from) and spatter
   * onto the table; heavier blows leave a stain that fades.
   */
  wound(at: THREE.Vector3, amount: number, from: THREE.Vector3 | null, onPlayer: boolean): void {
    const power = Math.min(1.6, 0.35 + amount * 0.12);
    const away = from ? at.clone().sub(from).setY(0).normalize() : new THREE.Vector3();
    const n = Math.round(26 + amount * 7);
    for (let i = 0; i < n; i++) {
      const dir = v3(r(-1, 1), r(0.3, 1.3), r(-1, 1)).normalize().addScaledVector(away, 0.9).normalize();
      this.norm.emit({
        pos: at.clone().add(v3(r(-0.3, 0.3), r(0.3, 0.8), r(-0.3, 0.3))), vel: dir.multiplyScalar(r(4, 11) * power), frame: Math.random() < 0.55 ? Frame.Shard : Frame.Drop,
        color: pick(['#b3121b', '#8c0a12', '#d42a2a', '#6e070d']), colorEnd: '#3a0306', size: r(0.18, 0.42), life: r(0.7, 1.2), gravity: 16, drag: 0.8, spin: r(-12, 12), floor: true, fadeIn: 0,
      });
    }
    // hot sparks on contact
    for (let i = 0; i < Math.round(14 + amount * 3); i++) {
      const dir = v3(r(-1, 1), r(0.2, 1), r(-1, 1)).normalize().addScaledVector(away, 0.6);
      this.add.emit({ pos: at.clone().add(v3(0, 0.5, 0)), vel: dir.multiplyScalar(r(8, 16)), frame: Frame.Streak, color: '#ffd0a0', colorEnd: '#ff3020', size: r(0.3, 0.6), life: r(0.15, 0.3), drag: 4, rot: Math.atan2(dir.x, dir.z) });
    }
    if (onPlayer || amount >= 3) this.stain(at, power * (onPlayer ? 1.3 : 0.9), away);
  }

  /** Three claw-like slashes across a card that's been struck. */
  slash(at: THREE.Vector3, size: number, angle: number): void {
    const mat = new THREE.MeshBasicMaterial({ map: this.slashTex, color: new THREE.Color('#ff5a40').multiplyScalar(2.4), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.rotation.set(-Math.PI / 2, 0, angle, 'YXZ');
    m.position.copy(at).setY(at.y + 0.4);
    m.scale.set(size * 0.2, size, 1);
    m.renderOrder = 15;
    this.stage.scene.add(m);
    gsap.to(m.scale, { x: size, duration: 0.09, ease: 'power3.out' });
    gsap.to(mat, { opacity: 0, duration: 0.55, delay: 0.12, ease: 'power1.in', onComplete: () => { m.removeFromParent(); m.geometry.dispose(); mat.dispose(); } });
  }

  private stain(at: THREE.Vector3, size: number, away: THREE.Vector3): void {
    const c = at.clone().addScaledVector(away, 0.6 * size).setY(0.03);
    this.norm.emit({ pos: c, vel: v3(0, 0, 0), frame: Frame.Splat, color: '#7a0a10', colorEnd: '#2a0205', size: 2.6 * size, life: 2.8, alpha: 0.75, rot: Math.random() * 6.28, fadeIn: 0.03, grow: 1.12 });
  }

  // ---- shared pieces ----------------------------------------------------------------------------

  private ring(pos: THREE.Vector3, color: string, size: number, delay = 0): void {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 56), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.07, pos.z);
    ring.scale.setScalar(0.4);
    this.stage.scene.add(ring);
    const end = 2 + size * 2.6;
    gsap.timeline({ delay, onComplete: () => { ring.removeFromParent(); ring.geometry.dispose(); mat.dispose(); } })
      .set(mat, { opacity: 0.85 })
      .to(ring.scale, { x: end, y: end, z: end, duration: 0.7, ease: 'power2.out' }, 0)
      .to(mat, { opacity: 0, duration: 0.7, ease: 'power1.in' }, 0);
  }

  private light(pos: THREE.Vector3, color: string, intensity: number, duration: number): void {
    const l = new THREE.PointLight(color, intensity, 16, 2);
    l.position.copy(pos).add(v3(0, 1.6, 0));
    this.stage.scene.add(l);
    gsap.to(l, { intensity: 0, duration, ease: 'power2.out', onComplete: () => { l.removeFromParent(); } });
  }

  /** A soft shaft of light from above (it turns to face the camera) and a warm pool where it lands. */
  private beam(pos: THREE.Vector3, s: number): void {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uA: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uA; uniform float uTime; varying vec2 vUv;
        void main() {
          float x = abs(vUv.x - 0.5) * 2.0;
          float core = exp(-x * x * 9.0) * 0.8 + exp(-x * x * 2.5) * 0.35;
          float fall = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.35, vUv.y);
          float rays = 0.8 + 0.2 * sin(vUv.x * 31.0 + uTime * 2.0) * sin(vUv.x * 13.0 - uTime * 1.3 + vUv.y * 4.0);
          gl_FragColor = vec4(vec3(1.0, 0.92, 0.7) * 1.5, core * fall * rays * uA * 0.6);
        }`,
    });
    const h = 13;
    const geo = new THREE.PlaneGeometry(3.4 * s + 1.4, h);
    geo.translate(0, h / 2, 0);
    const shaft = new THREE.Mesh(geo, mat);
    shaft.position.set(pos.x, 0, pos.z);
    shaft.rotation.y = this.stage.view.yaw;
    shaft.renderOrder = 13;
    // the pool: a soft disc on the table
    const poolMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uA: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uA; varying vec2 vUv;
        void main() { float d = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(vec3(1.0, 0.9, 0.65) * 1.4, exp(-d * d * 3.5) * (1.0 - smoothstep(0.85, 1.0, d)) * uA * 0.7); }`,
    });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(pos.x, 0.06, pos.z);
    pool.scale.setScalar(5 * s + 2);
    pool.renderOrder = 12;
    this.stage.scene.add(shaft, pool);
    const st = { a: 0, t: 0 };
    const set = () => {
      mat.uniforms.uA.value = st.a;
      poolMat.uniforms.uA.value = st.a;
      mat.uniforms.uTime.value = st.t;
    };
    gsap.timeline({ onComplete: () => { shaft.removeFromParent(); pool.removeFromParent(); geo.dispose(); mat.dispose(); pool.geometry.dispose(); poolMat.dispose(); } })
      .to(st, { a: 1, duration: 0.2, ease: 'power2.out', onUpdate: set })
      .to(st, { a: 0, duration: 1.0, ease: 'power1.in', onUpdate: set }, 0.4)
      .to(st, { t: 2, duration: 1.4, ease: 'none', onUpdate: set }, 0);
    gsap.fromTo(shaft.scale, { x: 0.25 }, { x: 1, duration: 0.3, ease: 'power2.out' });
  }
}

export function hueColor(h: Hue): string {
  return { W: '#fff2c8', U: '#6ec4ff', B: '#a65cff', R: '#ff7a2a', G: '#7fe07a', C: '#dcdcec' }[h];
}

function buildSlash(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 256;
  const g = cv.getContext('2d')!;
  for (let k = -1; k <= 1; k++) {
    const x = 64 + k * 30;
    const grd = g.createLinearGradient(0, 10, 0, 246);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.45, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(x - 2 + k * 10, 10);
    g.quadraticCurveTo(x + 8, 128, x + 2 - k * 10, 246);
    g.quadraticCurveTo(x - 4, 128, x - 2 + k * 10, 10);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
