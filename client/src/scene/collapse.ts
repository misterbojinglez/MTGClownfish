import * as THREE from 'three';
import gsap from 'gsap';
import { FLOOR_RING_V, type Stage } from './stage';
import { Frame, type Magic } from './magic';
import { sfx } from '../audio';
import { settings } from '../settings';

/**
 * A lost player's mat collapses (about four seconds): the ground trembles and cracks into plates whose seams
 * glow, the plates drop away one after another into the earth, magma wells up and floods the pit, and it
 * cools over into a scar: the battlefield's own painted ground, charred and resealed, crossed by a few molten
 * fissures like the mats' borders. The scar stays for the rest of the game.
 *
 * One finely divided plane per pit, drawn with the floor's painting so it starts out as the floor. The vertex
 * shader drops and tilts each vertex's Voronoi plate; where neighbouring plates part, the stretched triangles
 * between them become the pit's walls. Everything that shows (seams, walls, the magma's shoreline, the scar)
 * is worked out again per pixel in the fragment shader from the same functions, so no edge follows the mesh's
 * triangles. The floor cuts a hole where the pit is (Stage.setFloorHoles), or its plane would hide the pit.
 */

/** How far around the mat the ground gives way (world units): the crater's rim. */
const RIM = 2.0;
/** Total length of the collapse, seconds. */
export const COLLAPSE_SECONDS = 4;

/** Shared by both stages: the crater's shape, the plates and how far each has fallen. */
const common = /* glsl */ `
  uniform float uSink;    // 0..1: the plates falling (each starts at its own moment)
  uniform float uMagma;   // 0..1: the magma rising
  uniform float uTremor;  // 0..1: the ground shuddering before and as it goes
  uniform float uTime;
  uniform vec4 uHole;     // the pit's world box (minX, minZ, maxX, maxZ)

  vec2 h2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
  // gradient noise, -1..1: smooth, with none of value noise's grid
  float gnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 a = h2(i) * 2.0 - 1.0, b = h2(i + vec2(1, 0)) * 2.0 - 1.0;
    vec2 c = h2(i + vec2(0, 1)) * 2.0 - 1.0, d = h2(i + vec2(1, 1)) * 2.0 - 1.0;
    return mix(mix(dot(a, f), dot(b, f - vec2(1, 0)), u.x), mix(dot(c, f - vec2(0, 1)), dot(d, f - vec2(1, 1)), u.x), u.y) * 1.4;
  }
  float sdBox(vec2 p, vec4 b) {
    vec2 q = abs(p - (b.xy + b.zw) * 0.5) - (b.zw - b.xy) * 0.5;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }
  // 0 at the crater's (wandering) edge, 1 from a little inside the mat's edge
  float crater(vec2 p) {
    float m = clamp((-sdBox(p, uHole) - 0.25 + gnoise(p * 0.45) * 0.65) / ${(RIM - 0.5).toFixed(2)}, 0.0, 1.0);
    return m * m * (3.0 - 2.0 * m);
  }
  // which plate p is on (the nearest of a jittered grid of points, plates about three units across), the
  // way to its centre (in cell units), and how far p is from the nearest seam
  void plate(vec2 p, out vec2 cid, out vec2 toCentre, out float edge) {
    vec2 g = p * 0.32;
    vec2 gi = floor(g), gf = fract(g);
    float f1 = 8.0, f2 = 8.0;
    vec2 r1 = vec2(0.0);
    cid = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 r = o + 0.1 + h2(gi + o) * 0.8 - gf;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; cid = gi + o; r1 = r; }
        else if (d < f2) { f2 = d; }
      }
    }
    toCentre = r1;
    edge = sqrt(f2) - sqrt(f1);
  }
  // how far the plate has fallen (0..1): each lets go at its own moment, then falls faster and faster
  float dropOf(vec2 cid) {
    float k = clamp((uSink - h2(cid + 7.3).x * 0.45) / 0.55, 0.0, 1.0);
    return k * k;
  }
  // the plate's surface height at p (tipping as it falls), held to the floor toward the rim
  float plateY(vec2 cid, vec2 toCentre, float m) {
    float k = dropOf(cid);
    float depth = 1.6 + h2(cid + 7.3).y * 2.4;
    vec2 tilt = (h2(cid + 3.1) - 0.5) * 0.5;
    return (-depth * k + dot(toCentre / 0.32, tilt) * k) * m;
  }
  // the magma's surface: it rises to just below the floor, flooding what has fallen; the rim stands clear
  float magmaY() { return mix(-4.6, -0.3, uMagma); }
`;

const vertexShader = /* glsl */ `
  ${common}
  varying vec3 vW;

  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vec2 p = w.xz;
    vec2 cid, toCentre;
    float edge;
    plate(p, cid, toCentre, edge);
    float m = crater(p);
    float y = plateY(cid, toCentre, m);
    y += sin(uTime * 47.0 + h2(cid + 7.3).x * 30.0) * 0.045 * uTremor * (1.0 - dropOf(cid)) * m;
    w.y += max(y, magmaY());
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragmentShader = /* glsl */ `
  ${common}
  uniform sampler2D uFloor;
  uniform vec4 uFloorRect;
  uniform float uHasFloor;
  uniform float uCrack;   // 0..1: the seams opening and glowing
  uniform float uCool;    // 0..1: the magma sealing over
  uniform vec4 uMat;      // the mat's world box (its lava border shows until the ground goes)
  varying vec3 vW;

  // the floor's lava palette (its molten mat borders)
  const vec3 TINT = vec3(1.0, 0.3, 0.04);
  const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * gnoise(p); p = ROT * p * 2.03; a *= 0.5; }
    return v * 0.5 + 0.5;
  }
  // molten rock, as the floor's borders flow: slow drifting heat with faster ripples, crust drifting over it
  vec3 lava(vec2 p, float hotter) {
    float t = uTime;
    float heat = fbm(p * 0.6 + vec2(t * 0.22, -t * 0.15)) * 1.15 + gnoise(p * 2.0 - vec2(t * 0.5, t * 0.35)) * 0.18 - 0.2 + hotter;
    heat = clamp(heat, 0.0, 1.0);
    vec3 c = mix(TINT * 0.3, TINT * 1.2, smoothstep(0.2, 0.62, heat));
    c = mix(c, mix(TINT * 1.2, vec3(1.6, 1.5, 1.3), 0.4), smoothstep(0.7, 0.95, heat));
    float crust = smoothstep(0.52, 0.72, fbm(p * 0.4 + vec2(-t * 0.05, t * 0.04) + 40.0));
    return mix(c, TINT * 0.1 + 0.015, crust * 0.8);
  }
  // the painted floor at p, exactly as the floor draws it (dark stone beyond the painting)
  vec3 floorAt(vec2 p) {
    vec3 stone = vec3(0.05, 0.048, 0.06) * (0.75 + 0.5 * fbm(p * 0.3));
    if (uHasFloor < 0.5) return stone;
    vec2 fuv = vec2(0.5 + (p.x - uFloorRect.x) / uFloorRect.z, ${FLOOR_RING_V.toFixed(3)} - (p.y - uFloorRect.y) / uFloorRect.w);
    float inside = smoothstep(0.0, 0.06, fuv.x) * smoothstep(1.0, 0.94, fuv.x) * smoothstep(0.0, 0.08, fuv.y) * smoothstep(1.0, 0.92, fuv.y);
    return mix(stone * 0.35, texture2D(uFloor, clamp(fuv, 0.0, 1.0)).rgb * 0.92, inside);
  }
  // distance (world units) to the zero line of gradient noise at scale f: its value over its slope, so a line
  // keeps an even width where the noise is flat instead of smearing into a band
  float lineDist(vec2 q, float f) {
    vec2 x = q * f;
    float n = gnoise(x);
    vec2 g = vec2(gnoise(x + vec2(0.02, 0.0)) - n, gnoise(x + vec2(0.0, 0.02)) - n) / 0.02;
    return abs(n) / max(length(g), 0.35) / f;
  }
  // the resealed ground: the painting itself, a shade darker and scorched, the old plate seams left as fine
  // dark cracks in it, and a few thin molten fissures meandering through like the floor's own lava cracks
  vec3 scar(vec2 p, vec3 ground, float m, float edge, float aa) {
    vec2 pw = p + vec2(fbm(p * 0.18 + 3.0), fbm(p * 0.18 + 9.0)) * 4.0;
    // fissures: long meandering lines, only some stretches of them open, an even hand's width wide
    float d = lineDist(pw, 0.13);
    float open = smoothstep(0.42, 0.62, fbm(p * 0.11 + 21.0)) * m;
    float w = 0.05 + 0.07 * fbm(p * 0.4);
    float fissure = smoothstep(w + aa, w - aa, d) * open;
    float near = exp(-d * 2.2) * open;
    // hairline offshoots, dark with a faint ember line
    float d2 = lineDist(pw + 17.0, 0.42);
    float offshoot = smoothstep(0.03 + aa, 0.03 - aa, d2) * smoothstep(0.55, 0.75, fbm(p * 0.5 + 11.0)) * m;

    vec3 c = ground * mix(1.0, 0.8, m);
    // scorched and warmed along the fissures
    c *= 1.0 - near * 0.45;
    c += TINT * 0.22 * near * near * (0.7 + 0.3 * sin(uTime * 1.1 + p.x * 0.3));
    // where the plates were: fine dark cracks in the painted stone
    float seamLine = smoothstep(0.03 + aa * 0.3, 0.012, edge) * m;
    c *= 1.0 - seamLine * 0.5;
    vec3 hot = lava(p, -0.05) * 0.75;
    c = mix(c, mix(vec3(0.02, 0.012, 0.01), hot * 0.5, 0.4), offshoot);
    c = mix(c, hot, fissure);
    // a thin bright core, like the painted floor's own glowing cracks
    float core = smoothstep(w * 0.35 + aa * 0.6, w * 0.35 - aa * 0.6, d) * open;
    return mix(c, mix(TINT * 1.3, vec3(1.5, 1.2, 0.7), 0.35), core * 0.85);
  }

  void main() {
    vec2 p = vW.xz;
    float aa = max(fwidth(p.x), fwidth(p.y));
    float m = crater(p);
    vec2 cid, toCentre;
    float edge;
    plate(p, cid, toCentre, edge);
    float drop = dropOf(cid) * m;
    float yPlate = plateY(cid, toCentre, m);
    float yHere = vW.y + 0.02;
    float level = magmaY();

    vec3 ground = floorAt(p);
    float sm = sdBox(p, uMat);
    ground *= mix(1.0, 0.91, smoothstep(aa, -aa, sm));

    // the mat's molten border, as the floor drew it, until the ground gives way
    vec2 pw = p + vec2(gnoise(p * 0.33 + 11.0), gnoise(p * 0.33 + 27.0)) * 0.55;
    float bw = 0.09;
    float border = smoothstep(bw + aa, bw - aa, abs(sdBox(pw, uMat))) * (1.0 - smoothstep(0.0, 0.5, uSink));
    vec3 col = mix(ground, lava(p, 0.25), border);

    // falling plates sink into shadow
    float depthN = clamp(-yPlate / 3.2, 0.0, 1.0);
    col *= 1.0 - depthN * 0.8;

    // seams: hairline cracks glowing as the ground splits, widening as the plates part
    float sw = 0.03 + 0.15 * drop;
    float seam = smoothstep(sw + aa * 0.32, sw - aa * 0.32, edge) * m * uCrack;
    vec3 hot = lava(p, 0.1);
    col = mix(col, hot * (1.1 + 0.25 * sin(uTime * 9.0 + p.x)), seam);
    // gaps between plates: wherever the surface here lies below its own plate, it's a wall lit from below
    float wall = smoothstep(0.03, 0.2, yPlate - yHere) * m;
    col = mix(col, hot * (0.25 + 0.75 * depthN), wall);

    // below the magma's surface: molten, then sealing over from scattered patches into the scar
    float sub = smoothstep(0.0, 0.06, level - min(yPlate, yHere)) * step(0.001, uMagma) * smoothstep(0.0, 0.08, m);
    float skin = smoothstep(uCool * 1.35 - 0.3, uCool * 1.35, fbm(p * 0.3 + 5.0));
    float sealed = (1.0 - skin) * smoothstep(0.0, 0.12, uCool);
    // the flood: molten rock with dark rafts of crust drifting on it
    vec3 flood = lava(p, -0.12) * 0.8;
    float raft = smoothstep(0.5, 0.66, fbm(p * 0.22 + vec2(uTime * 0.04, -uTime * 0.03) + 50.0));
    flood = mix(flood, TINT * 0.06 + 0.012, raft * 0.85);
    vec3 surf = mix(flood, scar(p, ground, m, edge, aa), sealed);
    col = mix(col, surf, sub);

    // the crater's lip: scorched where the heat came up to it, nothing beyond (the floor carries on unchanged)
    float lip = smoothstep(0.0, 0.12, m) * (1.0 - smoothstep(0.12, 0.45, m)) * uMagma;
    col *= 1.0 - lip * 0.45;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

interface Pit {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  hole: THREE.Vector4;
}

export class Collapse {
  private readonly pits: Pit[] = [];
  private live = 0;

  constructor(private readonly stage: Stage, private readonly magic: Magic) {
    stage.onTick((_dt, t) => {
      for (const pit of this.pits) pit.material.uniforms.uTime.value = t;
    });
    stage.onBusy(() => this.live > 0);
  }

  /** A pit for a mat's world box (minX, minZ, maxX, maxZ), flat and whole: the floor as it was. */
  private open(mat: THREE.Vector4): Pit {
    const hole = new THREE.Vector4(mat.x - RIM, mat.y - RIM, mat.z + RIM, mat.w + RIM);
    const w = hole.z - hole.x;
    const d = hole.w - hole.y;
    // about four vertices a unit, so the seams between plates stay narrow (fewer on Low detail)
    const per = settings.floorDetail === 'low' ? 2.5 : 4;
    const geo = new THREE.PlaneGeometry(w, d, Math.ceil(w * per), Math.ceil(d * per));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...this.stage.floorUniforms(),
        uSink: { value: 0 },
        uMagma: { value: 0 },
        uTremor: { value: 0 },
        uCrack: { value: 0 },
        uCool: { value: 0 },
        uTime: { value: 0 },
        uHole: { value: hole.clone() },
        uMat: { value: mat.clone() },
      },
      vertexShader,
      fragmentShader,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((hole.x + hole.z) / 2, -0.02, (hole.y + hole.w) / 2);
    mesh.frustumCulled = false;
    this.stage.scene.add(mesh);
    const pit = { mesh, material, hole };
    this.pits.push(pit);
    this.stage.setFloorHoles(this.pits.map((x) => x.hole));
    return pit;
  }

  /** A scar from a collapse that happened before this view joined (a reload mid-game): no animation. */
  scar(mat: THREE.Vector4): void {
    const u = this.open(mat).material.uniforms;
    u.uSink.value = 1;
    u.uMagma.value = 1;
    u.uCrack.value = 1;
    u.uCool.value = 1;
  }

  /**
   * The mat at `mat` collapses into magma and cools to a scar (COLLAPSE_SECONDS). `at` is its centre on the
   * table, for the sound's pan, the screen pulse and the particles. Resolves once it has cooled.
   */
  play(mat: THREE.Vector4): Promise<void> {
    const pit = this.open(mat);
    const u = pit.material.uniforms;
    const centre = new THREE.Vector3((mat.x + mat.z) / 2, 0, (mat.y + mat.w) / 2);
    const pan = Math.max(-1, Math.min(1, centre.x / 30));
    this.live++;

    const tl = gsap.timeline();
    // the ground shudders and splits
    tl.to(u.uTremor, { value: 1, duration: 0.3, ease: 'power1.in' }, 0);
    tl.to(u.uCrack, { value: 1, duration: 0.55, ease: 'power2.in' }, 0.15);
    // the plates fall away, one after another
    tl.to(u.uSink, { value: 1, duration: 1.5, ease: 'none' }, 0.5);
    tl.to(u.uTremor, { value: 0, duration: 0.6 }, 1.4);
    // magma wells up and floods the pit
    tl.to(u.uMagma, { value: 1, duration: 1.2, ease: 'power2.out' }, 1.3);
    // and crusts over into a scar
    tl.to(u.uCool, { value: 1, duration: 1.5, ease: 'power1.inOut' }, 2.5);

    // the earth answering: a long rumble, jolts as the plates go, a hiss as it cools
    sfx.rumble(pan);
    tl.call(() => this.stage.addShake(0.22), [], 0.1);
    tl.call(() => this.stage.addShake(0.3), [], 0.6);
    tl.call(() => {
      sfx.collapse(pan);
      this.stage.addShake(0.5);
      this.stage.hitPulse(0.45, this.screenPoint(centre));
    }, [], 1.0);
    tl.call(() => this.stage.addShake(0.3), [], 1.45);
    tl.call(() => sfx.sizzle(pan), [], 2.5);

    // dust as it splits, embers and flames while it's molten, steam as it cools
    const start = performance.now();
    const at = new THREE.Vector3();
    const stopParticles = this.stage.onTick((dt) => {
      const t = (performance.now() - start) / 1000;
      const point = () => at.set(mat.x + Math.random() * (mat.z - mat.x), 0, mat.y + Math.random() * (mat.w - mat.y));
      const rate = (n: number) => Math.floor(n * dt + Math.random());
      if (t > 0.2 && t < 1.8) for (let i = rate(26); i > 0; i--) {
        this.magic.norm.emit({ pos: point().setY(0.2), vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.8 + Math.random(), (Math.random() - 0.5) * 0.6), frame: Frame.Smoke, color: '#3a2e28', size: 1.4 + Math.random(), life: 1.4, alpha: 0.5, grow: 2.4, spin: Math.random() - 0.5 });
      }
      if (t > 0.8 && t < 2.8) for (let i = rate(70); i > 0; i--) {
        this.magic.add.emit({ pos: point().setY(-0.2), vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 2 + Math.random() * 3.5, (Math.random() - 0.5) * 1.5), frame: Frame.Dot, color: '#ffd36a', colorEnd: '#ff3a10', size: 0.15 + Math.random() * 0.15, life: 0.8 + Math.random() * 0.8, gravity: -1.5 });
        if (Math.random() < 0.15) this.magic.add.emit({ pos: point().setY(-0.1), vel: new THREE.Vector3(0, 1.4 + Math.random(), 0), frame: Frame.Flame, color: '#ffb347', colorEnd: '#ff2a00', size: 1 + Math.random() * 0.8, life: 0.45, grow: 0.5 });
      }
      if (t > 2.5 && t < 4) for (let i = rate(22); i > 0; i--) {
        this.magic.norm.emit({ pos: point().setY(0.1), vel: new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4), frame: Frame.Smoke, color: '#8d8a90', size: 1.2 + Math.random(), life: 1.8, alpha: 0.35, grow: 3, fadeIn: 0.2, spin: Math.random() - 0.5 });
      }
    });

    return new Promise((resolve) => {
      tl.call(() => {
        stopParticles();
        this.live--;
        resolve();
      }, [], COLLAPSE_SECONDS);
    });
  }

  /** Every pit filled in again (a new game). */
  clear(): void {
    for (const pit of this.pits) {
      pit.mesh.removeFromParent();
      pit.mesh.geometry.dispose();
      pit.material.dispose();
    }
    this.pits.length = 0;
    this.stage.setFloorHoles([]);
  }

  private screenPoint(world: THREE.Vector3): { x: number; y: number } {
    const v = world.clone().project(this.stage.camera);
    return { x: (v.x + 1) / 2, y: (v.y + 1) / 2 };
  }
}
