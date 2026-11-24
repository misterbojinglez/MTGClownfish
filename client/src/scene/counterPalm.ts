import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * The counterspell effect: a huge phantasmal palm in blues slams up in the middle of the screen, and a
 * refractive ripple runs out from it across the whole picture, bending and colour-splitting the table as it
 * passes (the "Matrix" bullet-time warp), then the hand dissolves into wisps.
 *
 * It's one full-screen pass in the composer (after bloom, before OutputPass, so it works in linear colour):
 * the hand is a signed-distance shape worked out per pixel (palm, four fingers, thumb, smooth-blended and
 * frayed with noise), so it's crisp at any resolution and needs no textures or geometry. The pass is enabled
 * only while the effect runs (about 1.6 s).
 */

/** seconds from the start to the moment the palm lands (the ripple and the jolt start there) */
export const PALM_IMPACT = 0.16;
/** the whole effect, seconds */
export const PALM_DURATION = 1.65;

export function createPalmPass(): ShaderPass {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uT: { value: 0 },
      uAspect: { value: 1 },
      uImpact: { value: PALM_IMPACT },
      uDur: { value: PALM_DURATION },
      /** where the palm sits (0–1 screen, y up) */
      uCenter: { value: new THREE.Vector2(0.5, 0.53) },
      /** fbm octaves for the hand's fraying and wisps (fewer on Low detail) */
      uOctaves: { value: 4 },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uT;
      uniform float uAspect;
      uniform float uImpact;
      uniform float uDur;
      uniform vec2 uCenter;
      uniform int uOctaves;
      varying vec2 vUv;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 5; i++) {
          if (i >= uOctaves) break;
          s += a * vnoise(p);
          p = p * 2.03 + vec2(1.7, 9.2);
          a *= 0.5;
        }
        return s;
      }

      float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
        vec2 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h) - r;
      }
      float sdRoundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }
      float smin(float a, float b, float k) {
        float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
        return mix(b, a, h) - k * h * (1.0 - h);
      }

      /** An open hand, palm toward you, fingers up, thumb out to the left; about 0.5 units tall. */
      float sdHand(vec2 q) {
        float d = sdRoundBox(q - vec2(0.0, -0.07), vec2(0.118, 0.125), 0.07);
        float k = 0.035;
        d = smin(d, sdCapsule(q, vec2(-0.078, 0.04), vec2(-0.1, 0.255), 0.031), k);  // index
        d = smin(d, sdCapsule(q, vec2(-0.026, 0.05), vec2(-0.032, 0.29), 0.033), k); // middle
        d = smin(d, sdCapsule(q, vec2(0.026, 0.045), vec2(0.04, 0.27), 0.031), k);   // ring
        d = smin(d, sdCapsule(q, vec2(0.074, 0.03), vec2(0.108, 0.205), 0.026), k);  // little
        d = smin(d, sdCapsule(q, vec2(-0.09, -0.11), vec2(-0.2, 0.015), 0.036), 0.05); // thumb
        // the wrist trails off below the palm
        d = smin(d, sdRoundBox(q - vec2(0.0, -0.25), vec2(0.075, 0.07), 0.05), 0.06);
        return d;
      }

      void main() {
        float t = uT;
        float since = t - uImpact;
        vec2 toP = vec2(uAspect, 1.0);
        vec2 p = (vUv - uCenter) * toP;

        // ---- envelope: rushes in (big and faint), lands, holds with a slow push, then dissolves ----
        float inK = clamp(t / uImpact, 0.0, 1.0);
        float appear = inK * inK;
        float fadeK = clamp((t - uDur * 0.55) / (uDur * 0.45), 0.0, 1.0);
        // accelerating in, so it lands with a hit rather than easing to a stop
        float scale = t < uImpact ? mix(1.85, 1.0, inK * inK) : 1.0 + 0.05 * since;
        float flash = since > 0.0 ? exp(-since * 9.0) : 0.0;

        // ---- the refractive ripple: a lens-shaped ring running outward from the palm ----
        vec2 disp = vec2(0.0);
        float ringGlow = 0.0;
        if (since > 0.0) {
          float r = length(p);
          vec2 dir = r > 1e-4 ? p / r : vec2(0.0);
          for (int i = 0; i < 2; i++) {
            float s = since - float(i) * 0.11;
            if (s <= 0.0) continue;
            float R = 0.08 + s * (1.45 - float(i) * 0.3);
            float w = 0.03 + s * 0.035;
            float x = (r - R) / w;
            float prof = exp(-x * x);
            float amp = (i == 0 ? 0.06 : 0.03) * pow(max(0.0, 1.0 - s / 0.95), 1.6);
            // derivative of a bump: pulls in ahead of the ring, pushes out behind it, like a lens of glass
            disp += dir * amp * x * prof * 1.6;
            ringGlow += prof * amp * 2.5;
          }
        }

        // ---- the hand ----
        // as it fades it lifts and swells a little, like smoke rising off the table
        vec2 q = (p - vec2(0.0, -0.02 + fadeK * 0.07)) / (scale * (1.12 + fadeK * 0.1));
        q.y += 0.03;
        float wob = fbm(q * 7.0 + vec2(0.0, -t * 0.9));
        float d = sdHand(q) + (wob - 0.5) * 0.022 * (0.7 + fadeK);
        // dissolving: noise eats the hand away in patches, from nothing to all of it
        float eat = fbm(q * 6.5 + vec2(3.1, -t * 0.7));
        float cut = mix(-0.1, 0.9, fadeK);
        float alive = smoothstep(cut - 0.14, cut + 0.04, eat);
        float inside = smoothstep(0.006, -0.006, d);
        float rim = exp(-abs(d) * 120.0);
        // light gathers just inside the edge, so the hand reads as a volume of mist rather than a flat shape
        float inner = exp(-max(-d, 0.0) * 28.0) * inside;
        float halo = exp(-max(d, 0.0) * 16.0);
        float wisps = fbm(q * 5.5 + vec2(0.0, -t * 1.6));
        float glyph = exp(-abs(length(q - vec2(0.0, -0.06)) - 0.062) * 220.0) + exp(-abs(length(q - vec2(0.0, -0.06)) - 0.04) * 320.0) * 0.6;
        // the edge being eaten glows, so the hand comes apart into light rather than holes
        float burnEdge = smoothstep(cut + 0.1, cut, eat) * smoothstep(cut - 0.14, cut - 0.02, eat) * step(0.001, fadeK);

        // the palm bends what's behind it a touch (it's made of something like glass and smoke)
        disp += (vec2(wisps, fbm(q * 5.5 + 7.0)) - 0.5) * 0.012 * inside * appear * alive;

        vec2 duv = disp / toP;
        vec3 col;
        col.r = texture2D(tDiffuse, vUv - duv * 1.6).r;
        col.g = texture2D(tDiffuse, vUv - duv).g;
        col.b = texture2D(tDiffuse, vUv - duv * 0.45).b;

        float env = appear * (1.0 - fadeK * fadeK);
        // the table dims and cools around the palm while it's up, so it reads
        float r0 = length(p);
        col = mix(col, col * vec3(0.55, 0.62, 0.85), env * 0.45 * smoothstep(0.05, 0.8, r0));

        // kept well under 1.0: OutputPass tone-maps the frame, and anything brighter bleaches toward white
        vec3 deep = vec3(0.01, 0.06, 0.45);
        vec3 core = vec3(0.04, 0.24, 0.85);
        vec3 rimC = vec3(0.2, 0.62, 1.0);
        vec3 hot = vec3(0.6, 0.85, 1.0);
        float mist = smoothstep(0.25, 0.85, wisps);
        vec3 hand = deep * inside * 0.35
          + core * inside * (0.03 + 0.6 * mist * mist) * 0.6
          + core * inner * 0.4
          + rimC * rim * 0.75
          + core * halo * 0.12
          + hot * glyph * inside * 0.3
          ;
        hand *= alive * appear;
        hand += mix(rimC, hot, 0.3) * burnEdge * (inside + halo * 0.4) * 0.8 * appear;
        hand += mix(core, hot, 0.4) * flash * (inside * 0.4 + halo * 0.3) * alive;
        col += hand * (t < uImpact ? 0.65 : 1.0);
        col += rimC * ringGlow * (1.0 - fadeK);
        // a cold flash across the whole frame on the impact
        col += vec3(0.03, 0.08, 0.22) * flash * 0.5;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  pass.enabled = false;
  return pass;
}
