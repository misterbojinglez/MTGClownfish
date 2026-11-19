import * as THREE from 'three';
import gsap from 'gsap';
import type { Stage } from './stage';
import { settings } from '../settings';

/**
 * The commander spotlight: a waterfall of light pouring down behind a commander as it's cast, held at the
 * middle of the screen, while the screen's fringes sink into a tinted dark (Stage.setSpotlight).
 *
 * The waterfall is one additive ShaderMaterial plane in the camera rig, drawn in the main pass so bloom
 * picks up its bright core; the card itself is on the overlay layer, drawn after post-processing, so it
 * stays in front, unvignetted, in its true colours. Hidden (and skipped) when no spotlight is playing.
 */

/** Where the held card sits in the camera rig, and how big: about half the screen's height. */
export const SPOT_POS = new THREE.Vector3(0, 0.3, -22);
export const SPOT_SCALE = 2.1;

const MANA: Record<string, string> = { W: '#fff1c4', U: '#7cc6ff', B: '#c58cff', R: '#ff8a4a', G: '#8cf08a' };

/** The light's colour for a card's colours: its colour, gold for several, a pale silver for colourless. */
export function spotColor(colors: string | undefined): THREE.Color {
  const c = (colors ?? '').replace(/[^WUBRG]/g, '');
  if (c.length > 1) return new THREE.Color('#ffd36a');
  return new THREE.Color(MANA[c] ?? '#dfe6ff');
}

export class Spotlight {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private live = false;
  private t0 = 0;

  constructor(private readonly stage: Stage) {
    // wide enough to frame the card, tall enough to fall from above the top of the screen to below the card
    const geo = new THREE.PlaneGeometry(13, 17);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPour: { value: 0 },
        uAlpha: { value: 0 },
        uColor: { value: new THREE.Color('#ffd36a') },
      },
      defines: { LOW_DETAIL: 0 },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uPour;   // 0..1: how far down the light has poured (it falls in, then holds)
        uniform float uAlpha;  // 0..1: the whole effect fading in and out
        uniform vec3 uColor;
        varying vec2 vUv;

        float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

        void main() {
          float x = vUv.x - 0.5;           // -0.5..0.5 across
          float fall = 1.0 - vUv.y;        // 0 at the top, 1 at the bottom
          // the light has poured this far down: a soft leading edge
          float front = smoothstep(uPour * 1.15, uPour * 1.15 - 0.12, fall);

          // the core: a narrow column, showing above the card (the card covers it below); the sheet: the
          // fall of light the streaks run down, about as wide as the card
          float core = exp(-x * x * 60.0) * smoothstep(0.62, 0.3, fall);
          float sheet = exp(-x * x * 12.0);

          float streams = 0.0;
        #if LOW_DETAIL == 0
          // falling streaks: narrow columns, each with its own speed and phase, drawn as dashes running down
          float cols = 46.0;
          float ci = floor(vUv.x * cols);
          float cx = fract(vUv.x * cols) - 0.5;
          float speed = 0.9 + hash(ci) * 1.4;
          float phase = hash(ci + 17.0);
          float dash = fract(fall * (2.0 + hash(ci + 5.0) * 3.0) - uTime * speed + phase);
          float streak = smoothstep(0.0, 0.08, dash) * smoothstep(0.75, 0.15, dash);
          float thin = smoothstep(0.5, 0.0, abs(cx)) * (0.35 + 0.65 * hash(ci + 3.0));
          streams = streak * thin * sheet;
        #endif

          // a shimmering ripple down the sheet, and the top fading in from above the screen
          float ripple = 0.75 + 0.25 * sin(fall * 22.0 - uTime * 7.0 + x * 9.0);
          float topFade = smoothstep(0.0, 0.12, fall);
          float bottomFade = smoothstep(1.0, 0.72, fall);

          // a soft halo where it meets the card (the card sits a little below the middle of the plane)
          vec2 h = vec2(x * 1.6, (fall - 0.62) * 1.4);
          float halo = exp(-dot(h, h) * 14.0);

          // only the streaks' peaks pass the bloom threshold; the sheet and halo stay a gentle glow
          float light = (core * 0.7 + sheet * 0.12 * ripple + streams * 1.35) * topFade * bottomFade * front + halo * 0.3 * uPour;
          vec3 col = mix(uColor, vec3(1.0), core * 0.4) * light;
          gl_FragColor = vec4(col * uAlpha, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    // behind the held card, centred on it, the top above the screen's top edge
    this.mesh.position.set(SPOT_POS.x, SPOT_POS.y + 2.6, SPOT_POS.z - 1.5);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    stage.cameraRig.add(this.mesh);

    stage.onTick((_dt, t) => {
      if (!this.live) return;
      // time since the pour began (the stage clock runs all session; small values keep the shader precise)
      if (this.t0 < 0) this.t0 = t;
      this.material.uniforms.uTime.value = t - this.t0;
    });
    stage.onBusy(() => this.live);
  }

  /**
   * Pours the light in, holds it for `hold` seconds, and fades it with the vignette. Resolves when the hold
   * ends (the card can move on while the light fades).
   */
  play(colors: string | undefined, hold: number): Promise<void> {
    const u = this.material.uniforms;
    const color = spotColor(colors);
    u.uColor.value.copy(color);
    const low = settings.floorDetail === 'low' ? 1 : 0;
    if (this.material.defines.LOW_DETAIL !== low) {
      this.material.defines.LOW_DETAIL = low;
      this.material.needsUpdate = true;
    }
    this.live = true;
    this.t0 = -1;
    this.mesh.visible = true;
    gsap.killTweensOf(u.uPour);
    gsap.killTweensOf(u.uAlpha);
    u.uPour.value = 0;
    u.uAlpha.value = 0;
    // the vignette's tint: the light's colour, deepened
    const tint = color.clone().multiplyScalar(0.6);
    const vig = { v: 0 };
    gsap.to(vig, { v: 1, duration: 0.35, ease: 'power2.out', onUpdate: () => this.stage.setSpotlight(vig.v, tint) });
    gsap.to(u.uAlpha, { value: 1, duration: 0.25, ease: 'power1.out' });
    gsap.to(u.uPour, { value: 1, duration: 0.55, ease: 'power2.in' });
    return new Promise((resolve) => {
      gsap.delayedCall(hold, () => {
        gsap.to(vig, { v: 0, duration: 0.45, ease: 'power2.in', onUpdate: () => this.stage.setSpotlight(vig.v) });
        gsap.to(u.uAlpha, {
          value: 0, duration: 0.45, ease: 'power2.in',
          onComplete: () => {
            this.live = false;
            this.mesh.visible = false;
            this.stage.setSpotlight(0);
          },
        });
        resolve();
      });
    });
  }

  /** A point in the falling light (world space), for glints that drift down it. */
  randomPointInLight(target: THREE.Vector3): THREE.Vector3 {
    const x = (Math.random() - 0.5) * 3.2;
    const y = 6.5 - Math.random() * 7;
    target.set(SPOT_POS.x + x, SPOT_POS.y + y, SPOT_POS.z - 1);
    this.stage.cameraRig.updateWorldMatrix(true, false);
    return target.applyMatrix4(this.stage.cameraRig.matrixWorld);
  }
}
