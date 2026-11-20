import * as THREE from 'three';
import gsap from 'gsap';
import type { Stage } from './stage';
import { CARD_H, CARD_W } from './cardMesh';
import { settings } from '../settings';

/**
 * Your commander in its slot by the hand gets a frame and an aura: a slate border with a gilt line around
 * the card, and a gas in the commander's colours rising up and off it.
 *
 * One ShaderMaterial plane per commander, a child of the card's root so it follows the card's tilt and its
 * hover growth. It stays on the main layer, drawn before the card (which is on the overlay layer, drawn
 * after post-processing), so the card covers its middle and bloom picks up the gas's brightest wisps.
 * Worked out per pixel in the card's own units, from a rounded-rectangle distance to the card's edge.
 */

const MANA: Record<string, string> = { W: '#fff1c4', U: '#5fb4ff', B: '#b07aff', R: '#ff6a2e', G: '#5fe07a' };
const COLOURLESS = '#cfd8ee';

/** how far the plane reaches past the card: a little at the sides and below, a lot above (the gas rises) */
const PAD_X = 1.5;
const PAD_DOWN = 0.7;
const PAD_UP = 4.2;

const GEO = (() => {
  const w = CARD_W + PAD_X * 2;
  const h = CARD_H + PAD_DOWN + PAD_UP;
  const g = new THREE.PlaneGeometry(w, h);
  // centred on the card, not on the plane
  g.translate(0, (PAD_UP - PAD_DOWN) / 2, 0);
  return g;
})();

const VERTEX = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy; // card units, the card's centre at 0
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform float uGas;      // 0 with effects off: the frame alone
  uniform vec3 uC0;
  uniform vec3 uC1;
  uniform vec3 uC2;
  uniform float uCount;    // how many colours (1..3)
  uniform vec2 uHalf;      // the card's half size
  uniform vec2 uReach;     // the plane's reach above the card's top and below its bottom
  uniform float uSideReach;
  varying vec2 vP;

  // gradient noise (smooth up close, unlike value noise)
  vec2 grad(vec2 i) {
    float h = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453) * 6.2831853;
    return vec2(cos(h), sin(h));
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(grad(i), f);
    float b = dot(grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float c = dot(grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float d = dot(grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.5 + 0.5;
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < OCTAVES; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(17.3, 9.1);
      a *= 0.5;
    }
    return v;
  }

  // distance outside a rounded rectangle (negative inside)
  float roundRect(vec2 p, vec2 hs, float r) {
    vec2 q = abs(p) - hs + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  vec3 palette(float k) {
    if (uCount < 1.5) return uC0;
    if (uCount < 2.5) return mix(uC0, uC1, smoothstep(0.3, 0.7, k));
    return k < 0.5 ? mix(uC0, uC1, smoothstep(0.1, 0.45, k)) : mix(uC1, uC2, smoothstep(0.55, 0.9, k));
  }

  void main() {
    float d = roundRect(vP, uHalf, 0.13);
    float aa = fwidth(d);

    // ---- the frame: a slate band hugging the card, a gilt line along its outer edge, a soft dark shadow
    float band = 0.11;
    float frameBody = 1.0 - smoothstep(band - aa, band + aa, d);
    float gilt = smoothstep(band - 0.035 - aa, band - 0.035 + aa, d) * frameBody;
    float innerLine = smoothstep(0.012 + aa, 0.012 - aa, abs(d - 0.02)); // a fine gilt line against the card
    vec3 slate = mix(vec3(0.07, 0.08, 0.11), vec3(0.14, 0.16, 0.21), smoothstep(-uHalf.y, uHalf.y, vP.y));
    vec3 gold = vec3(0.85, 0.66, 0.3) * (0.85 + 0.3 * smoothstep(-uHalf.y, uHalf.y, vP.y + vP.x * 0.4));
    vec3 frameCol = mix(slate, gold, max(gilt, innerLine));
    float shadow = (1.0 - smoothstep(band, band + 0.35, d)) * 0.55;

    // ---- the gas: noise drifting upward, warped, thinning with distance from the card and leaning upward
    float up = max(vP.y - uHalf.y, 0.0);                  // height above the card's top
    float t = uTime;
    vec2 q = vec2(vP.x * 0.9, vP.y * 0.55 - t * 0.55);
    vec2 warp = vec2(fbm(q * 1.3 + vec2(0.0, t * 0.15)), fbm(q * 1.3 + vec2(5.2, 1.3 - t * 0.1)));
    float n = fbm(q * 1.6 + (warp - 0.5) * 1.8);
    float wisps = smoothstep(0.38, 0.72, n);
    // the plume: close to the card all round, reaching far up, narrowing and swaying as it rises
    float sway = (fbm(vec2(vP.y * 0.35 - t * 0.3, 2.0)) - 0.5) * 0.9 * smoothstep(0.0, 2.5, up);
    float width = uHalf.x + 0.25 - up * 0.12;
    float side = max(abs(vP.x - sway) - width, 0.0);
    float below = max(-uHalf.y - vP.y, 0.0);
    float reach = exp(-side * 3.2) * exp(-below * 4.0) * exp(-up * 0.55) * smoothstep(0.0, 0.25, d);
    float gas = reach * (0.45 + 1.1 * wisps) * uGas;
    // fade at the plane's edges so nothing shows a seam
    gas *= smoothstep(uReach.x, uReach.x - 1.2, up) * smoothstep(uSideReach, uSideReach - 0.6, abs(vP.x));
    // which colour: fbm clusters around 0.5, so stretch it to reach every colour, drifting with height so
    // several colours band through the plume as it rises
    float k = clamp((fbm(q * 0.8 + vec2(3.1, t * 0.05)) - 0.5) * 3.2 + 0.5 + sin(vP.y * 0.8 - t * 0.6 + vP.x) * 0.25, 0.0, 1.0);
    vec3 gasCol = palette(k);
    // hottest wisps run toward white and just past the bloom threshold; the rest stays a coloured haze
    gasCol = mix(gasCol, vec3(1.0), wisps * reach * 0.3) * (0.85 + 0.9 * wisps * reach);

    // ---- together: the frame over the gas, the shadow under both
    float frameA = frameBody;
    vec3 col = gasCol * gas;
    float a = clamp(gas, 0.0, 1.0);
    a = max(a, shadow * (1.0 - frameA));
    col = mix(col, frameCol, frameA);
    a = mix(a, 1.0, frameA);
    gl_FragColor = vec4(col, a * uAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class CommandAura {
  private readonly auras = new Map<number, { mesh: THREE.Mesh; material: THREE.ShaderMaterial; key: string }>();
  private time = 0;

  constructor(stage: Stage) {
    stage.onTick((dt) => {
      if (!this.auras.size) return;
      this.time += dt;
      // keep the stage clock's value small in the shader, so the noise stays precise
      if (this.time > 600) this.time -= 600;
      for (const a of this.auras.values()) a.material.uniforms.uTime.value = this.time;
    });
  }

  /**
   * Show the aura on exactly these cards (your commanders in their slot): each given as its root and its
   * colours (WUBRG letters). Any other card's aura fades away.
   */
  sync(cards: { id: number; root: THREE.Object3D; colors: string }[]): void {
    const keep = new Set(cards.map((c) => c.id));
    for (const [id, a] of this.auras) if (!keep.has(id)) this.drop(id, a);
    const low = settings.floorDetail === 'low' ? 3 : 5;
    const gasOn = settings.particles === 'off' ? 0 : 1;
    for (const c of cards) {
      const key = c.colors;
      let a = this.auras.get(c.id);
      if (!a) {
        const material = new THREE.ShaderMaterial({
          uniforms: {
            uTime: { value: this.time },
            uAlpha: { value: 0 },
            uGas: { value: gasOn },
            uC0: { value: new THREE.Color() },
            uC1: { value: new THREE.Color() },
            uC2: { value: new THREE.Color() },
            uCount: { value: 1 },
            uHalf: { value: new THREE.Vector2(CARD_W / 2, CARD_H / 2) },
            uReach: { value: new THREE.Vector2(PAD_UP, PAD_DOWN) },
            uSideReach: { value: CARD_W / 2 + PAD_X },
          },
          defines: { OCTAVES: low },
          transparent: true,
          depthTest: false,
          depthWrite: false,
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
        });
        const mesh = new THREE.Mesh(GEO, material);
        // just behind the card face, drawn before the other rig objects' transparent layers
        mesh.position.z = -0.02;
        mesh.renderOrder = 4;
        mesh.frustumCulled = false;
        a = { mesh, material, key: '' };
        this.auras.set(c.id, a);
        gsap.to(material.uniforms.uAlpha, { value: 1, duration: 0.6, ease: 'power1.out' });
      }
      if (a.mesh.parent !== c.root) c.root.add(a.mesh);
      const u = a.material.uniforms;
      u.uGas.value = gasOn;
      if (a.material.defines.OCTAVES !== low) {
        a.material.defines.OCTAVES = low;
        a.material.needsUpdate = true;
      }
      if (a.key !== key) {
        a.key = key;
        const letters = key.replace(/[^WUBRG]/g, '').split('');
        const cols = letters.length ? letters.map((l) => MANA[l]) : [COLOURLESS];
        u.uC0.value.set(cols[0]);
        u.uC1.value.set(cols[1] ?? cols[0]);
        u.uC2.value.set(cols[2] ?? cols[1] ?? cols[0]);
        // four or five colours: three of them carry it (it reads as a rainbow either way)
        u.uCount.value = Math.min(3, cols.length);
      }
    }
  }

  clear(): void {
    for (const [id, a] of this.auras) this.drop(id, a, true);
  }

  private drop(id: number, a: { mesh: THREE.Mesh; material: THREE.ShaderMaterial }, now = false): void {
    this.auras.delete(id);
    const done = () => {
      a.mesh.removeFromParent();
      a.material.dispose();
    };
    if (now) return done();
    gsap.killTweensOf(a.material.uniforms.uAlpha);
    gsap.to(a.material.uniforms.uAlpha, { value: 0, duration: 0.3, ease: 'power1.in', onComplete: done });
  }
}
