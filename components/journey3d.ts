// flight-pass - the WebGL flight. A self-contained, imperative three.js scene
// driven by one normalized design time (0..1 over durationMs). It is
// dynamically imported so three is never in the initial bundle and the boarding
// form never waits on it; if WebGL2 is unavailable or anything here throws,
// FlightExperience falls back to the 2D canvas journey.
//
// The flight, in five beats:
//   1. lift-off off Earth: a gravity turn from the pad into a warp burst
//   2. the Moon slides past, then the asteroid belt
//   3. a sun slingshot: the path bends round the sun, bloom + a warp fling
//   4. Mars grows ahead, the vehicle flips nose-up and burns retro
//   5. a slow, controlled touchdown on the Mars horizon, which cross-fades
//      into the DOM surface + boarding pass
//
// How the motion stays smooth:
// - Every channel (speed, heading, camera offsets, fov) is a monotone cubic
//   (PCHIP) track, so values and their rates are continuous. No kinks at keys.
// - The rocket path is integrated once at start-up from speed + heading, so
//   position, velocity and acceleration are all continuous, and each landmark
//   (moon, sun, Mars) is placed relative to where the rocket actually is at its
//   beat. The landing is a pair of Hermite segments that pick up the exact
//   position and velocity and bring both to zero.
// - The camera rides a critically damped spring (no overshoot, frame-rate
//   independent) on top of those tracks, and the frame clock is clamped so a
//   dropped frame slows the flight a hair instead of teleporting it.
//
// The planet jpgs in /public/fly are photos of a lit disc, not sphere maps, so
// they are drawn as camera-facing impostors that keep the photo's own lighting.
// Only HDR values (sun, engine) cross the bloom threshold, so bloom stays
// selective and everything else stays crisp.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { CustomVehicle, ThesisLine, Vehicle } from "../lib/types";

// Moments FlightExperience can hang sound on, fired once each as the flight
// crosses them.
export type JourneyCue = "fling" | "retro" | "touchdown";

export interface Journey3DOptions {
  canvas: HTMLCanvasElement;
  // Length of the flight.
  durationMs: number;
  // Everything is identical for every vehicle: path, camera, attitude, engine,
  // thesis, landing. Only the model changes.
  vehicle?: Vehicle;
  // The model for vehicle "custom".
  customVehicle?: CustomVehicle;
  onCaption?: (text: string) => void;
  // Big-type thesis lines, keyed to design progress like the captions.
  thesis?: ThesisLine[];
  // add: stack under the line showing rather than replace it
  onThesis?: (text: string, add: boolean) => void;
  onProgress?: (t: number) => void;
  onCue?: (cue: JourneyCue) => void;
  // start() was called and the first frame is on the canvas (shaders were
  // compiled, textures uploaded during prepare). The caller swaps the 2D pad
  // for the canvas here, then the clock starts.
  onReady?: () => void;
  onDone: () => void;
}

export interface Journey3DHandle {
  // Start the clock: fires onReady, then plays. False if the scene can no
  // longer play (the GPU context was lost while it waited); cancel and rebuild.
  start: () => boolean;
  cancel: () => void;
  // QA hook: freeze the flight at t (0..1) and render that exact frame.
  seek: (t: number) => void;
}

/** Cheap capability probe. three r185 needs WebGL2. */
export function webglSupported(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGL2RenderingContext && c.getContext("webgl2"));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Timeline (normalized 0..1)                                          */
/* ------------------------------------------------------------------ */

const BEAT = {
  moon: 0.14,
  // the asteroid belt
  beltIn: 0.185,
  beltOut: 0.575,
  slingIn: 0.585,
  slingMid: 0.665,
  slingOut: 0.75,
  landStart: 0.84,
  hover: 0.915,
  touchdown: 0.96,
};

const CAPTIONS: { at: number; text: string }[] = [
  { at: 0, text: "DEPARTING EARTH" },
  { at: 0.1, text: "PASSING THE MOON" },
  { at: 0.19, text: "THROUGH THE ASTEROID BELT" },
  { at: 0.58, text: "ROUNDING THE SUN" },
  { at: 0.77, text: "APPROACHING MARS" },
];

const CUES: { at: number; cue: JourneyCue }[] = [
  { at: 0.715, cue: "fling" },
  { at: 0.865, cue: "retro" },
  { at: BEAT.touchdown, cue: "touchdown" },
];

// Real time <-> design time. The flight plays at one speed, so this is the
// identity; it stays a seam in case a beat ever needs to play slower.
interface Warp {
  realS: number; // total real duration
  tau: (realS: number) => number; // real seconds -> design seconds
  real: (tauS: number) => number; // design seconds -> real seconds
  rate: (tauS: number) => number; // d(design) / d(real)
}

function buildWarp(designS: number): Warp {
  const clampS = (x: number) => Math.min(designS, Math.max(0, x));
  return { realS: designS, tau: clampS, real: clampS, rate: () => 1 };
}

/* ------------------------------------------------------------------ */
/* Easing + tracks                                                     */
/* ------------------------------------------------------------------ */

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
// C2 smootherstep: zero velocity and acceleration at both ends.
const ease = (a: number, b: number, x: number) => {
  const u = clamp01((x - a) / (b - a));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
// 0 outside [a,b], a smooth hump to 1 in the middle (sin^2, so no kink at the ends).
const bell = (a: number, b: number, x: number) => {
  const s = Math.sin(clamp01((x - a) / (b - a)) * Math.PI);
  return s * s;
};

// Monotone cubic (Fritsch-Carlson / PCHIP) through [t, value] keys. C1, never
// overshoots between keys, and the two ends are flat so every channel eases in
// and out of the flight.
class Track {
  private readonly t: Float64Array;
  private readonly y: Float64Array;
  private readonly m: Float64Array;
  private seg = 0;

  constructor(keys: readonly (readonly number[])[], col = 1) {
    const n = keys.length;
    this.t = new Float64Array(n);
    this.y = new Float64Array(n);
    this.m = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      this.t[k] = keys[k][0];
      this.y[k] = keys[k][col];
    }
    const d = new Float64Array(Math.max(1, n - 1));
    for (let k = 0; k < n - 1; k++) d[k] = (this.y[k + 1] - this.y[k]) / (this.t[k + 1] - this.t[k]);
    for (let k = 1; k < n - 1; k++) {
      if (d[k - 1] * d[k] <= 0) continue; // local extremum: flat tangent
      const h0 = this.t[k] - this.t[k - 1];
      const h1 = this.t[k + 1] - this.t[k];
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      this.m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }

  at(x: number): number {
    const { t, y, m } = this;
    const n = t.length;
    if (x <= t[0]) return y[0];
    if (x >= t[n - 1]) return y[n - 1];
    let i = this.seg;
    if (i > n - 2 || x < t[i] || x > t[i + 1]) {
      i = 0;
      while (i < n - 2 && x > t[i + 1]) i++;
      this.seg = i;
    }
    const h = t[i + 1] - t[i];
    const s = (x - t[i]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * y[i] +
      (s3 - 2 * s2 + s) * h * m[i] +
      (-2 * s3 + 3 * s2) * y[i + 1] +
      (s3 - s2) * h * m[i + 1]
    );
  }
}

// Critically damped spring (Game Programming Gems 4, 1.10). Frame-rate
// independent and never overshoots.
function springStep(cur: number, target: number, vel: Float64Array, vi: number, smoothTime: number, dt: number): number {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel[vi] + omega * change) * dt;
  vel[vi] = (vel[vi] - omega * temp) * k;
  return target + (change + temp) * k;
}

class SpringV3 {
  readonly value = new THREE.Vector3();
  private readonly vel = new Float64Array(3);
  update(target: THREE.Vector3, smoothTime: number, dt: number) {
    const v = this.value;
    v.x = springStep(v.x, target.x, this.vel, 0, smoothTime, dt);
    v.y = springStep(v.y, target.y, this.vel, 1, smoothTime, dt);
    v.z = springStep(v.z, target.z, this.vel, 2, smoothTime, dt);
  }
  snap(target: THREE.Vector3) {
    this.value.copy(target);
    this.vel.fill(0);
  }
}

/* ------------------------------------------------------------------ */
/* The flight path: integrated once from speed + heading               */
/* ------------------------------------------------------------------ */

// Rocket speed in world units per second.
const SPEED = new Track([
  [0, 0],
  [0.02, 2],
  [0.065, 46],
  [0.11, 20],
  [0.16, 14],
  [0.2, 11],
  [0.57, 11],
  [0.63, 16],
  [0.72, 30],
  // the fling: flung off the sun fast, then braking hard as Mars fills the view
  [0.765, 66],
  [0.8, 50],
  [BEAT.landStart, 15],
]);
// Heading, degrees. Yaw 0 flies down -Z; positive yaw turns left.
const YAW = new Track([
  [0, 0],
  [0.14, 0],
  [0.22, -4],
  [0.32, 3],
  [0.44, -3],
  [0.53, 0],
  [BEAT.slingIn, 0],
  [BEAT.slingOut, 85],
  [BEAT.landStart, 90],
]);
// Straight up off the pad, then a gravity turn over into the flight.
const PITCH = new Track([
  [0, 90],
  [0.012, 90],
  [0.085, 9],
  [0.14, 4],
  [0.3, 0],
  [0.5, 2],
  [BEAT.slingIn, 0],
  [BEAT.slingMid, -2],
  [BEAT.slingOut, 0],
  [BEAT.landStart, -8],
]);

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

interface Flight {
  n: number;
  pos: Float32Array; // xyz per sample
  dir: Float32Array; // unit travel direction per sample
  yaw: Float32Array; // camera frame heading (radians)
  speed: Float32Array; // units / s
  turn: Float32Array; // yaw rate, rad / s (drives the bank)
  accel: Float32Array; // units / s^2 (drives camera lag)
  touchdown: THREE.Vector3; // vehicle centre at rest
  landFwd: THREE.Vector3; // horizontal heading at landing
  landRight: THREE.Vector3;
}

const headingDir = (yawDeg: number, pitchDeg: number, out: THREE.Vector3) => {
  const y = yawDeg * DEG;
  const p = pitchDeg * DEG;
  return out.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
};

const hermite = (p0: number, m0: number, p1: number, m1: number, s: number) => {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
};
const hermiteD = (p0: number, m0: number, p1: number, m1: number, s: number) => {
  const s2 = s * s;
  return (6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * m0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * m1;
};

function buildFlight(durS: number): Flight {
  const n = 1600;
  const pos = new Float32Array((n + 1) * 3);
  const dir = new Float32Array((n + 1) * 3);
  const yaw = new Float32Array(n + 1);
  const speed = new Float32Array(n + 1);
  const turn = new Float32Array(n + 1);
  const accel = new Float32Array(n + 1);
  const dtS = durS / n;
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();

  // 1. integrate the powered flight (midpoint rule, fine enough at n=1600)
  const iL = Math.round(BEAT.landStart * n);
  for (let i = 0; i <= iL; i++) {
    const t = i / n;
    if (i > 0) {
      const tm = (i - 0.5) / n;
      headingDir(YAW.at(tm), PITCH.at(tm), d);
      p.addScaledVector(d, SPEED.at(tm) * dtS);
    }
    pos.set([p.x, p.y, p.z], i * 3);
    headingDir(YAW.at(t), PITCH.at(t), d);
    dir.set([d.x, d.y, d.z], i * 3);
    yaw[i] = YAW.at(t) * DEG;
    speed[i] = SPEED.at(t);
    const h = 0.5 / n;
    turn[i] = ((YAW.at(t + h) - YAW.at(t - h)) * DEG) / (2 * h * durS);
    accel[i] = (SPEED.at(t + h) - SPEED.at(t - h)) / (2 * h * durS);
  }

  // 2. the landing: glide down to a hover point, then a slow vertical settle.
  // Both are Hermite segments, so position and velocity carry over exactly.
  const P0 = new THREE.Vector3(pos[iL * 3], pos[iL * 3 + 1], pos[iL * 3 + 2]);
  const V0 = new THREE.Vector3(dir[iL * 3], dir[iL * 3 + 1], dir[iL * 3 + 2]).multiplyScalar(speed[iL]);
  const landYaw = yaw[iL];
  const landFwd = new THREE.Vector3(-Math.sin(landYaw), 0, -Math.cos(landYaw));
  const landRight = new THREE.Vector3().crossVectors(landFwd, UP).normalize();
  const H = P0.clone().addScaledVector(landFwd, 13).add(new THREE.Vector3(0, -1.2, 0));
  const drop = 3.4;
  const T = H.clone().add(new THREE.Vector3(0, -drop, 0));
  const dur1 = (BEAT.hover - BEAT.landStart) * durS;
  const dur2 = (BEAT.touchdown - BEAT.hover) * durS;
  const vs = (1.5 * drop) / dur2; // sink rate at the hover point
  const prev = new THREE.Vector3().copy(d);
  for (let i = iL + 1; i <= n; i++) {
    const t = i / n;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    if (t <= BEAT.hover) {
      const s = (t - BEAT.landStart) / (BEAT.hover - BEAT.landStart);
      p.set(
        hermite(P0.x, V0.x * dur1, H.x, 0, s),
        hermite(P0.y, V0.y * dur1, H.y, -vs * dur1, s),
        hermite(P0.z, V0.z * dur1, H.z, 0, s),
      );
      vx = hermiteD(P0.x, V0.x * dur1, H.x, 0, s) / dur1;
      vy = hermiteD(P0.y, V0.y * dur1, H.y, -vs * dur1, s) / dur1;
      vz = hermiteD(P0.z, V0.z * dur1, H.z, 0, s) / dur1;
    } else if (t <= BEAT.touchdown) {
      const s = (t - BEAT.hover) / (BEAT.touchdown - BEAT.hover);
      p.set(H.x, hermite(H.y, -vs * dur2, T.y, 0, s), H.z);
      vy = hermiteD(H.y, -vs * dur2, T.y, 0, s) / dur2;
    } else {
      p.copy(T);
    }
    pos.set([p.x, p.y, p.z], i * 3);
    const sp = Math.hypot(vx, vy, vz);
    if (sp > 0.25) prev.set(vx / sp, vy / sp, vz / sp);
    dir.set([prev.x, prev.y, prev.z], i * 3);
    yaw[i] = landYaw;
    speed[i] = sp;
    turn[i] = 0;
  }
  for (let i = iL + 1; i <= n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n, i + 1);
    accel[i] = (speed[b] - speed[a]) / ((b - a) * dtS);
  }
  return { n, pos, dir, yaw, speed, turn, accel, touchdown: T, landFwd, landRight };
}

// Linear read of the flight table at t. n=1600 samples is < 9ms apart, finer
// than a frame, so linear interpolation is invisible.
function readVec(f: Flight, arr: Float32Array, t: number, out: THREE.Vector3) {
  const x = clamp01(t) * f.n;
  const i = Math.min(f.n - 1, Math.floor(x));
  const u = x - i;
  const a = i * 3;
  const b = a + 3;
  return out.set(arr[a] + (arr[b] - arr[a]) * u, arr[a + 1] + (arr[b + 1] - arr[a + 1]) * u, arr[a + 2] + (arr[b + 2] - arr[a + 2]) * u);
}
function readNum(f: Flight, arr: Float32Array, t: number) {
  const x = clamp01(t) * f.n;
  const i = Math.min(f.n - 1, Math.floor(x));
  const u = x - i;
  return arr[i] + (arr[i + 1] - arr[i]) * u;
}

/* ------------------------------------------------------------------ */
/* Camera rig keys, in the heading frame (right, up, back)             */
/* ------------------------------------------------------------------ */

// t, right, up, back, lookUp, lookAhead, fov
const CAM_KEYS = [
  [0.0, 0, 0.9, 13, 2.0, 0, 55],
  [0.03, 0, 1.4, 13, 1.9, 3, 57],
  [0.075, 0, 2.4, 11.5, 1.6, 12, 66],
  [0.12, 0.6, 2.6, 11.5, 2.0, 12, 58],
  [0.185, 0.2, 2.9, 12, 3.4, 12, 55],
  [0.565, 0.2, 2.9, 12, 3.4, 12, 55],
  [0.64, 1.4, 1.8, 11, 1.4, 10, 58],
  [0.75, 1.2, 2.2, 11.5, 1.8, 12, 64],
  [0.8, 0.4, 2.4, 12.5, 1.6, 12, 56],
  [BEAT.landStart, 0.4, 2.8, 12.5, -0.8, 12, 55], // tip down: keep Mars in shot
] as const;
const camTrack = (col: number) => new Track(CAM_KEYS, col);

/* ------------------------------------------------------------------ */
/* Small texture helpers                                               */
/* ------------------------------------------------------------------ */

function radialTexture(stops: [number, string][], size = 128): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Streaks: stars and dust as screen-space capsules                    */
/* ------------------------------------------------------------------ */

// Each particle is a quad stretched in screen space from where it is to where
// it was (pos - uTrail), so it is a round dot at rest and a clean motion streak
// at speed. Stars ride with the camera and only streak in warp; dust is fixed
// in the world and streaks with real speed, which is what sells velocity.
function makeStreaks(positions: Float32Array, sizes: Float32Array, tones: Float32Array) {
  const count = sizes.length;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute("aPos", new THREE.InstancedBufferAttribute(positions, 3));
  geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(sizes, 1));
  geo.setAttribute("aTone", new THREE.InstancedBufferAttribute(tones, 1));
  geo.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTrail: { value: new THREE.Vector3() },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uWidth: { value: 1 },
      uGain: { value: 1 },
      uNearFade: { value: 0 },
      uCool: { value: new THREE.Color("#ffffff") },
      uWarm: { value: new THREE.Color("#ffc9b8") },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aPos;
      attribute float aSize;
      attribute float aTone;
      uniform vec3 uTrail;
      uniform vec2 uViewport;
      uniform float uWidth;
      uniform float uNearFade;
      varying float vAlong;
      varying float vSide;
      varying float vLen;
      varying float vW;
      varying float vTone;
      varying float vFade;
      void main() {
        vec4 wp = modelMatrix * vec4(aPos, 1.0);
        vec4 hv = viewMatrix * wp;
        vec4 tv = viewMatrix * vec4(wp.xyz - uTrail, 1.0);
        const float nearZ = -0.3;
        if (hv.z > nearZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        if (tv.z > nearZ) tv = mix(hv, tv, (hv.z - nearZ) / (hv.z - tv.z));
        vec4 hc = projectionMatrix * hv;
        vec4 tc = projectionMatrix * tv;
        vec2 hs = hc.xy / hc.w;
        vec2 ts = tc.xy / tc.w;
        vec2 dpx = (hs - ts) * uViewport * 0.5;
        float L = length(dpx);
        vec2 dir = L > 0.001 ? dpx / L : vec2(0.0, 1.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        float w = uWidth * aSize;
        vec2 sp = mix(ts, hs, position.x);
        vec2 off = nrm * position.y * w + dir * (position.x * 2.0 - 1.0) * w;
        sp += off / (uViewport * 0.5);
        float z = mix(tc.z / tc.w, hc.z / hc.w, position.x);
        gl_Position = vec4(sp, z, 1.0);
        vAlong = position.x * (L + 2.0 * w) - w;
        vSide = position.y * w;
        vLen = L;
        vW = w;
        vTone = aTone;
        vFade = uNearFade > 0.0 ? smoothstep(1.5, 1.5 + uNearFade, -hv.z) : 1.0;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uGain;
      uniform vec3 uCool;
      uniform vec3 uWarm;
      varying float vAlong;
      varying float vSide;
      varying float vLen;
      varying float vW;
      varying float vTone;
      varying float vFade;
      void main() {
        float dx = vAlong - clamp(vAlong, 0.0, vLen);
        float dist = length(vec2(dx, vSide));
        float a = 1.0 - smoothstep(vW * 0.3, vW, dist);
        // head brighter than tail; long streaks spread their light thinner
        float head = vLen > 1.0 ? mix(0.25, 1.0, clamp(vAlong / vLen, 0.0, 1.0)) : 1.0;
        float spread = mix(1.0, 0.6, clamp(vLen / 240.0, 0.0, 1.0));
        vec3 col = mix(uCool, uWarm, step(0.82, fract(vTone * 7.31)));
        float lum = (0.35 + 0.65 * vTone) * uGain * head * spread * vFade;
        gl_FragColor = vec4(col * lum * a, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return { mesh, material };
}

/* ------------------------------------------------------------------ */
/* Planets: impostors of the disc photos                               */
/* ------------------------------------------------------------------ */

interface DiscPhoto {
  map: THREE.Texture;
  // Disc centre + radius inside the photo, in uv units (measured off the jpgs).
  cx: number;
  cy: number;
  r: number;
  // Rotation (radians, CCW) so the best-lit limb faces where we need it.
  rot: number;
}

const PLANET_PAD = 1.14; // quad half-size in disc radii (room for the photo's halo)

function makePlanet(photo: DiscPhoto, radius: number) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // premultiplied: the disc is opaque (it hides the stars behind its night
    // side) and the photo's own atmosphere halo adds light around it
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uMap: { value: photo.map },
      uCenter: { value: new THREE.Vector2(photo.cx, 1 - photo.cy) },
      uRadius: { value: photo.r },
      uRot: { value: photo.rot },
      uBright: { value: 1 },
      uHalo: { value: 1 },
      uAlpha: { value: 1 },
      // the horse flight: glitter over the disc, and a sunset-pink recolour
      uGlitter: { value: 0 },
      uTint: { value: 0 },
      uTime: { value: 0 },
      uSeed: { value: Math.random() * 100 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec2 uCenter;
      uniform float uRadius;
      uniform float uRot;
      uniform float uBright;
      uniform float uHalo;
      uniform float uAlpha;
      uniform float uGlitter;
      uniform float uTint;
      uniform float uTime;
      uniform float uSeed;
      varying vec2 vUv;
      float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      // One layer of glitter: a sparse grid of tiny four-point stars that
      // twinkle on their own clocks. Faded out where its cells get too small
      // on screen to read (so it never turns into noise on a distant disc).
      float sparkle(vec2 q, float density, float px) {
        float cellPx = 1.0 / (density * px);
        float vis = smoothstep(5.0, 11.0, cellPx);
        if (vis <= 0.0) return 0.0;
        vec2 g = q * density;
        vec2 cell = floor(g);
        vec2 f = fract(g) - 0.5;
        float r = hash(cell + uSeed);
        if (r < 0.8) return 0.0;
        vec2 o = vec2(hash(cell + 7.1), hash(cell + 3.7)) - 0.5;
        vec2 dd = (f - o * 0.6);
        float core = smoothstep(0.1, 0.0, length(dd));
        float rays = max(smoothstep(0.025, 0.0, abs(dd.x)) * smoothstep(0.32, 0.0, abs(dd.y)),
                         smoothstep(0.025, 0.0, abs(dd.y)) * smoothstep(0.32, 0.0, abs(dd.x)));
        float tw = pow(0.5 + 0.5 * sin(uTime * (2.5 + 4.0 * r) + r * 60.0), 6.0);
        return (core + rays) * tw * vis;
      }
      void main() {
        vec2 q = (vUv - 0.5) * 2.0 * ${PLANET_PAD.toFixed(2)};
        float d = length(q);
        float c = cos(uRot), s = sin(uRot);
        vec2 rq = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
        vec3 col = texture2D(uMap, uCenter + rq * uRadius).rgb * uBright;
        if (uTint > 0.0) {
          // sunset ramp by brightness: plum shadows, rose mids, peach highlights
          float l = clamp(dot(col, vec3(0.299, 0.587, 0.114)) * 1.6, 0.0, 1.0);
          vec3 plum = vec3(0.12, 0.015, 0.045);
          vec3 rose = vec3(1.0, 0.27, 0.33);
          vec3 peach = vec3(1.0, 0.66, 0.38);
          vec3 ramp = l < 0.45 ? mix(plum, rose, l / 0.45) : mix(rose, peach, (l - 0.45) / 0.55);
          col = mix(col, ramp * 0.85, uTint);
        }
        float aa = fwidth(d) * 1.25;
        float disc = 1.0 - smoothstep(0.995 - aa, 0.995, d);
        float halo = (1.0 - smoothstep(1.0, 1.1, d)) * uHalo;
        col *= max(disc, halo);
        if (uGlitter > 0.0 && disc > 0.0) {
          float px = fwidth(q.x);
          float g = sparkle(q, 26.0, px) + sparkle(q + 3.17, 70.0, px) * 0.8;
          // HDR on purpose: the bloom turns each glint into a soft star
          col += vec3(1.0, 0.86, 0.94) * g * 2.6 * disc * uGlitter;
        }
        gl_FragColor = vec4(col, disc) * uAlpha;
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * PLANET_PAD, 2 * PLANET_PAD), material);
  mesh.scale.setScalar(radius);
  mesh.renderOrder = -5;
  return { mesh, material };
}

/* ------------------------------------------------------------------ */
/* Sun: one HDR billboard (photosphere + corona)                       */
/* ------------------------------------------------------------------ */

const SUN_DISC = 0.34; // photosphere radius as a fraction of the quad half-size

function makeSun(radius: number) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uBoost: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBoost;
      varying vec2 vUv;
      float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        const float rd = ${SUN_DISC.toFixed(2)};
        // photosphere: limb darkening + slow granulation, well above 1.0 so it blooms
        float mu = sqrt(max(0.0, 1.0 - (r * r) / (rd * rd)));
        float g = fbm(p * (10.0 / rd) + vec2(uTime * 0.22, -uTime * 0.17));
        vec3 disc = mix(vec3(1.0, 0.5, 0.2), vec3(1.0, 0.93, 0.8), pow(mu, 0.55)) * (0.8 + 0.3 * g) * (0.5 + 0.5 * mu) * 3.4;
        // corona: soft falloff with slow streamers (angle via cos/sin: no seam)
        vec2 ang = p / max(r, 1e-4);
        float streak = fbm(ang * 2.6 + vec2(r * 1.4 - uTime * 0.12, uTime * 0.05));
        float fall = exp(-max(r - rd, 0.0) * 11.0) * (0.55 + 0.6 * streak);
        fall *= 1.0 - smoothstep(0.72, 1.0, r);
        vec3 corona = vec3(1.0, 0.48, 0.2) * fall * 1.15;
        float inside = 1.0 - smoothstep(rd - 0.006, rd, r);
        gl_FragColor = vec4((disc * inside + corona * (1.0 - inside * 0.6)) * uBoost, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.scale.setScalar(radius / SUN_DISC);
  mesh.renderOrder = -4;
  return { mesh, material };
}

/* ------------------------------------------------------------------ */
/* Engine plume                                                        */
/* ------------------------------------------------------------------ */

function makePlume(core: string, edge: string, radius: number, length: number) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uPower: { value: 1 },
      uTime: { value: 0 },
      uCore: { value: new THREE.Color(core) },
      uEdge: { value: new THREE.Color(edge) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFacing;
      varying float vEndOn;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vec3 view = normalize(-mv.xyz);
        vFacing = abs(dot(n, view));
        // how much we look straight down the exhaust (from behind the ship)
        vEndOn = abs(dot(normalize(normalMatrix * vec3(0.0, -1.0, 0.0)), view));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uPower;
      uniform float uTime;
      uniform vec3 uCore;
      uniform vec3 uEdge;
      varying vec2 vUv;
      varying float vFacing;
      varying float vEndOn;
      void main() {
        // clamp before pow(): a hair below zero at the tip is NaN on GPUs, and
        // bloom smears a single NaN pixel into a black band across the frame
        float along = clamp(vUv.y, 0.0, 1.0);       // 0 at the nozzle, 1 at the tip
        float facing = clamp(vFacing, 0.0, 1.0);
        float body = pow(1.0 - along, 1.7);
        float core = pow(facing, 3.0) * (1.0 - along);
        float flick = 0.86 + 0.14 * sin(uTime * 41.0 + along * 19.0) * sin(uTime * 23.0);
        vec3 col = mix(uEdge, uCore * 1.7, core) * body * facing * uPower * flick;
        col *= 1.0 - 0.8 * vEndOn * vEndOn; // end-on it would read as a white disc
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const geo = new THREE.ConeGeometry(radius, length, 24, 1, true);
  // cone apex is +Y with uv.y = 1 there; flip so the apex trails and the uv
  // runs 0 (nozzle) -> 1 (tip)
  geo.rotateX(Math.PI);
  geo.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  return { mesh, material };
}

/* ------------------------------------------------------------------ */
/* Glitter: a ring buffer of twinkling sparks off the vehicle's tail  */
/* ------------------------------------------------------------------ */

// Sparks are born at a point with a velocity and drift on their own; the GPU
// works out where each one is from its birth time, so per frame the CPU only
// writes the handful of new sparks (no allocations).
// `fire` recolours the sparks for the rocket (vermilion, gold, white);
// the horse keeps pink, gold and white.
// `pink` is the gold gorilla: hot pink, soft pink and white.
function makeGlitter(count: number, fire = false, pink = false) {
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const birth = new Float32Array(count).fill(-1e6);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) seed[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aVel = new THREE.BufferAttribute(vel, 3).setUsage(THREE.DynamicDrawUsage);
  const aBirth = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", aPos);
  geo.setAttribute("aVel", aVel);
  geo.setAttribute("aBirth", aBirth);
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uLife: { value: 2.7 }, uScale: { value: 800 }, uFire: { value: fire ? 1 : 0 }, uPink: { value: pink ? 1 : 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 aVel;
      attribute float aBirth;
      attribute float aSeed;
      uniform float uTime;
      uniform float uLife;
      uniform float uScale;
      varying float vFade;
      varying float vTw;
      varying float vSeed;
      void main() {
        float age = uTime - aBirth;
        if (age < 0.0 || age > uLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        float k = age / uLife;
        // drift, easing off as the spark slows
        vec3 p = position + aVel * (age - 0.35 * age * age / uLife);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.5 + 0.5 * sin(uTime * (8.0 + aSeed * 14.0) + aSeed * 60.0);
        vTw = tw;
        vFade = (1.0 - k) * (1.0 - k);
        vSeed = aSeed;
        gl_PointSize = clamp(uScale * (0.06 + 0.12 * aSeed) * (0.55 + 0.45 * tw) * (1.0 - 0.4 * k) / max(-mv.z, 0.1), 0.0, 48.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vFade;
      varying float vTw;
      varying float vSeed;
      uniform float uFire;
      uniform float uPink;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float core = smoothstep(0.5, 0.0, length(c));
        float rays = max(smoothstep(0.05, 0.0, abs(c.x)) * smoothstep(0.5, 0.0, abs(c.y)),
                         smoothstep(0.05, 0.0, abs(c.y)) * smoothstep(0.5, 0.0, abs(c.x)));
        vec3 hot = mix(vec3(1.0, 0.45, 0.75), vec3(1.0, 0.36, 0.22), uFire);
        vec3 col = vSeed < 0.4 ? hot : vSeed < 0.75 ? vec3(1.0, 0.82, 0.5) : vec3(1.0);
        if (uPink > 0.5) col = vSeed < 0.5 ? vec3(1.0, 0.36, 0.72) : vSeed < 0.82 ? vec3(1.0, 0.72, 0.9) : vec3(1.0);
        float a = (core * core * 0.9 + rays) * vFade * (0.35 + 0.65 * vTw);
        gl_FragColor = vec4(col * a * 2.4, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  let head = 0;
  const emit = (px: number, py: number, pz: number, vx: number, vy: number, vz: number, t: number) => {
    const i = head;
    head = (head + 1) % count;
    pos[i * 3] = px;
    pos[i * 3 + 1] = py;
    pos[i * 3 + 2] = pz;
    vel[i * 3] = vx;
    vel[i * 3 + 1] = vy;
    vel[i * 3 + 2] = vz;
    birth[i] = t;
    aPos.needsUpdate = true;
    aVel.needsUpdate = true;
    aBirth.needsUpdate = true;
  };
  const clear = () => {
    birth.fill(-1e6);
    aBirth.needsUpdate = true;
  };
  return { points, material, emit, clear };
}

/* ------------------------------------------------------------------ */
/* Vehicles. Group +Z is "forward"; the loop orients and banks it.     */
/* ------------------------------------------------------------------ */

interface VehicleRig {
  group: THREE.Group;
  plume: THREE.ShaderMaterial;
  plumeMesh: THREE.Object3D;
  glow: THREE.Sprite;
  light: THREE.PointLight;
  // distance from the group origin down to the ground contact when landed
  footOffset: number;
  // Roll (radians) applied as it points straight up (on the pad, at
  // touchdown). The rocket is round and needs none; the horse turns its profile
  // to the camera (PI/2), the gorilla its face (PI).
  uprightRoll?: number;
  // gait: 1 in flight, 0 once landed. upright: 1 pointing straight up (pad,
  // touchdown), 0 flying level.
  tick?: (dtS: number, gait: number, upright: number) => void;
  dispose?: () => void;
}

const VERMILION = "#DC4A2F";
const BONE = "#F4F1EC";

function engineGlow(color = new THREE.Color(1.5, 0.95, 0.72)): THREE.Sprite {
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: radialTexture([
        [0, "rgba(255,244,236,1)"],
        [0.22, "rgba(255,150,110,0.75)"],
        [1, "rgba(220,74,47,0)"],
      ]),
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  return glow;
}

// The rocket, matched to the 2D ship on the pad: a smooth lathe fuselage that
// runs from bone white to vermilion, three swept fins, a porthole, a nozzle.
function makeRocket(env: THREE.Texture): VehicleRig {
  const group = new THREE.Group();
  const inner = new THREE.Group(); // modelled nose-up (+Y); tilt +Y onto +Z
  inner.rotation.x = Math.PI / 2;
  group.add(inner);

  // fuselage profile (radius, y) from the tail up to the nose tip
  const prof: THREE.Vector2[] = [];
  prof.push(new THREE.Vector2(0.0, -1.42));
  prof.push(new THREE.Vector2(0.33, -1.42));
  for (let i = 0; i <= 6; i++) {
    const u = i / 6; // boattail
    prof.push(new THREE.Vector2(0.34 + 0.16 * Math.sin((u * Math.PI) / 2), -1.4 + 0.5 * u));
  }
  prof.push(new THREE.Vector2(0.5, 0.3));
  for (let i = 1; i <= 18; i++) {
    const u = i / 18; // tangent ogive nose
    prof.push(new THREE.Vector2(Math.max(0.0, 0.5 * Math.pow(1 - u * u, 0.62)), 0.3 + 1.8 * u));
  }
  const bodyGeo = new THREE.LatheGeometry(prof, 48);
  const cols: number[] = [];
  const cBone = new THREE.Color(BONE);
  const cVerm = new THREE.Color(VERMILION);
  const c = new THREE.Color();
  const pa = bodyGeo.getAttribute("position");
  for (let i = 0; i < pa.count; i++) {
    c.copy(cBone).lerp(cVerm, ease(0.25, -1.05, pa.getY(i)));
    cols.push(c.r, c.g, c.b);
  }
  bodyGeo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  const shell = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.3,
    metalness: 0.08,
    clearcoat: 0.5,
    clearcoatRoughness: 0.22,
    envMap: env,
    envMapIntensity: 0.35,
  });
  inner.add(new THREE.Mesh(bodyGeo, shell));

  // porthole on the side that faces the camera on the pad
  const port = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.085, 0.3, 6, 16),
    new THREE.MeshPhysicalMaterial({ color: "#10131c", roughness: 0.08, metalness: 0.2, clearcoat: 1, envMap: env, envMapIntensity: 1.2 }),
  );
  port.position.set(0, 0.55, -0.465);
  port.scale.set(1, 1, 0.45);
  inner.add(port);

  // swept fins: root along the lower body, tip swept out and down past the tail
  const fin = new THREE.Shape();
  fin.moveTo(0, -1.36);
  fin.lineTo(0, -0.2);
  fin.quadraticCurveTo(0.34, -0.62, 0.74, -1.12);
  fin.lineTo(0.82, -1.66);
  fin.quadraticCurveTo(0.42, -1.4, 0, -1.36);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 10 });
  finGeo.translate(0, 0, -0.03);
  const finMat = new THREE.MeshPhysicalMaterial({ color: VERMILION, roughness: 0.34, metalness: 0.1, clearcoat: 0.7, clearcoatRoughness: 0.2, envMap: env, envMapIntensity: 0.45 });
  for (const a of [Math.PI / 2, (7 * Math.PI) / 6, (11 * Math.PI) / 6]) {
    const m = new THREE.Mesh(finGeo, finMat);
    m.rotation.y = -a;
    m.position.set(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4);
    inner.add(m);
  }

  const nozzle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.34, 0.34, 32, 1, true),
    new THREE.MeshStandardMaterial({ color: "#2a2d35", metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide, envMap: env }),
  );
  nozzle.position.y = -1.58;
  inner.add(nozzle);
  const throat = new THREE.Mesh(new THREE.CircleGeometry(0.3, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.9, 0.5) }));
  throat.rotation.x = Math.PI / 2;
  throat.position.y = -1.7;
  inner.add(throat);

  const { mesh: plumeMesh, material: plume } = makePlume("#fff1e0", "#f0633f", 0.3, 2.8);
  plumeMesh.position.y = -1.72;
  inner.add(plumeMesh);

  const glow = engineGlow();
  glow.position.z = -1.9;
  group.add(glow);

  const light = new THREE.PointLight("#ff7a52", 6, 26, 1.6);
  light.position.z = -2.2;
  group.add(light);

  return { group, plume, plumeMesh, glow, light, footOffset: 1.72 };
}

// Two-tone "designer object" finish for the horse: bone on the head, neck and
// back, running to vermilion on the legs, belly and tail. Mixed by height.
function twoToneMaterial(yLo: number, yHi: number, env: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: BONE, roughness: 0.6, metalness: 0.05, envMap: env, envMapIntensity: 0.25 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLo = { value: yLo };
    shader.uniforms.uHi = { value: yHi };
    shader.uniforms.uVerm = { value: new THREE.Color(VERMILION) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vLocalY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocalY = position.y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vLocalY;\nuniform float uLo;\nuniform float uHi;\nuniform vec3 uVerm;")
      .replace("vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vec4( mix(uVerm, diffuse, smoothstep(uLo, uHi, vLocalY)), opacity );");
  };
  return mat;
}

// The horse: the three.js sample horse (MIT, ~180KB, one gallop clip),
// refinished in bone and vermilion, galloping the exact rocket path. Falls back
// to the rocket if the model cannot be fetched so the flight never blocks.
async function makeHorse(env: THREE.Texture): Promise<VehicleRig> {
  const group = new THREE.Group();
  const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) => {
    const timer = window.setTimeout(() => rej(new Error("horse timeout")), 6000);
    new GLTFLoader().load(
      "/flight/horse.glb",
      (g) => {
        window.clearTimeout(timer);
        res(g);
      },
      undefined,
      (e) => {
        window.clearTimeout(timer);
        rej(e);
      },
    );
  });
  const model = gltf.scene;
  // model units are ~cm: 183 tall, 320 long, head toward +Z
  const inner = new THREE.Group();
  inner.add(model);
  // Measure the base mesh by hand: the gallop is morph-target animation, and
  // Box3.setFromObject folds the morph extents in (about 2x too big).
  const box = new THREE.Box3();
  const pt = new THREE.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    const pa = m.isMesh ? m.geometry.getAttribute("position") : null;
    if (!pa) return;
    for (let i = 0; i < pa.count; i++) box.expandByPoint(pt.fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld));
  });
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = 3.6 / Math.max(size.z, 1e-3); // nose to tail, about the rocket's length
  inner.scale.setScalar(s);
  const baseY = -(box.min.y + size.y * 0.5) * s;
  inner.position.y = baseY;
  inner.position.z = -(box.min.z + size.z * 0.5) * s;
  const mat = twoToneMaterial(box.min.y + size.y * 0.3, box.min.y + size.y * 0.68, env);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.material = mat;
      m.frustumCulled = false;
    }
  });
  group.add(inner);

  const mixer = new THREE.AnimationMixer(model);
  const clip = gltf.animations[0];
  if (clip) mixer.clipAction(clip).play();

  // the rocket's engine, firing from behind the horse: pink, and twice as long
  // (the glitter streams off it, see makeGlitter)
  const half = (size.z * s) / 2;
  const { mesh: plumeMesh, material: plume } = makePlume("#ffe8f3", "#ff5c9d", 0.3, 5.2);
  plumeMesh.rotation.x = Math.PI / 2; // trail along -Z
  plumeMesh.position.set(0, 0, -half + 0.05);
  group.add(plumeMesh);

  const glow = engineGlow(new THREE.Color(1.6, 0.7, 1.05));
  glow.position.z = -half - 0.2;
  group.add(glow);

  const light = new THREE.PointLight("#ff6fb0", 6, 26, 1.6);
  light.position.z = -half - 0.5;
  group.add(light);

  let phase = 0;
  const tick = (dtS: number, gait: number) => {
    // a fast canter from the first frame
    mixer.update(dtS * 2.3 * gait);
    phase += dtS * gait * 20;
    inner.position.y = baseY + Math.sin(phase) * 0.08 * gait;
  };
  const dispose = () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
  };
  return { group, plume, plumeMesh, glow, light, footOffset: half, uprightRoll: Math.PI / 2, tick, dispose };
}

// A solid-gold gorilla. The mesh is "Gorilla" by Digga79
// (thingiverse.com/thing:4733596, CC BY 4.0), simplified to 24k triangles and
// shipped as public/flight/gorilla.glb (~430KB). He flies the rocket path mid-stride
// like the horse gallops it, with the rocket's vermilion engine firing behind.
// Falls back to the rocket if the model cannot be fetched.
const GORILLA_HEAD_FLIP = false; // true if the model's head points to -Z
async function makeGoldGorilla(env: THREE.Texture): Promise<VehicleRig> {
  const group = new THREE.Group();
  const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => {
    const timer = window.setTimeout(() => rej(new Error("gorilla timeout")), 6000);
    new GLTFLoader().load(
      "/flight/gorilla.glb",
      (g) => {
        window.clearTimeout(timer);
        res(g);
      },
      undefined,
      (e) => {
        window.clearTimeout(timer);
        rej(e);
      },
    );
  });
  const model = gltf.scene;
  // kept below the bloom threshold: brighter gold blooms into a fireball and
  // loses his shape
  const gold = new THREE.MeshStandardMaterial({
    color: "#d4a03c",
    metalness: 1,
    roughness: 0.36,
    envMap: env,
    envMapIntensity: 0.75,
  });
  // The model is a statue (no skeleton), so it is rigged here, in the vertex
  // shader: each limb is a two-bone chain (shoulder or hip to elbow or knee
  // to hand or foot), traced from the mesh. Every limb is driven to the same
  // symmetric running angles, so the sculpted mid-stride pose does not turn
  // into a limp, and the elbows and knees fold on each forward swing so the
  // hands and feet visibly lift even from the chase camera behind him.
  // Model space: y up (0 = ground, top 0.87), head toward +z, length 1.
  // Limbs: 0 left arm, 1 right arm, 2 left leg, 3 right leg.
  const LIMB_P = [new THREE.Vector3(0.21, 0.52, 0.22), new THREE.Vector3(-0.19, 0.52, 0.22), new THREE.Vector3(0.12, 0.4, -0.26), new THREE.Vector3(-0.16, 0.4, -0.24)];
  const LIMB_F = [new THREE.Vector3(0.22, 0, 0.46), new THREE.Vector3(-0.03, 0, 0.38), new THREE.Vector3(0.17, 0, 0), new THREE.Vector3(-0.23, 0, -0.37)];
  // sculpted swing angle of each limb (forward of straight down, radians)
  const REST = LIMB_P.map((p, i) => Math.atan2(LIMB_F[i].z - p.z, p.y - LIMB_F[i].y));
  // the run: a transverse gallop, hind feet leading (fraction of a stride)
  const BEAT = [0.62, 0.5, 0.12, 0];
  const MID = [0.36, 0.36, 0.13, 0.13];
  const SWING = [0.3, 0.3, 0.42, 0.42];
  const FOLD = [0.75, 0.75, 1.0, 1.0];
  const glsl3 = (v: THREE.Vector3) => `vec3(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
  const run = { uA: { value: [0, 0, 0, 0] }, uB: { value: [0, 0, 0, 0] } };
  gold.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, run);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uA[4];
        uniform float uB[4];
        const vec3 LP[4] = vec3[4](${LIMB_P.map(glsl3).join(", ")});
        const vec3 LF[4] = vec3[4](${LIMB_F.map(glsl3).join(", ")});
        vec3 rotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
        // how much limb i owns this vertex, and where along the limb it is (0 hip, 1 foot)
        float limbW(vec3 p, int i, out float s) {
          vec3 d = LF[i] - LP[i];
          s = dot(p - LP[i], d) / dot(d, d);
          float dist = length(p - (LP[i] + d * clamp(s, 0.0, 1.0)));
          // hands and feet are wider than the limb, so the reach grows toward
          // them and they move as one piece instead of smearing
          float r = mix(0.11, 0.17, smoothstep(0.55, 0.95, s));
          return (1.0 - smoothstep(r, r + 0.05, dist)) * smoothstep(-0.02, 0.22, s);
        }
        vec3 limbPos(vec3 p, int i, float s) {
          vec3 K = mix(LP[i], LF[i], 0.5);
          vec3 q = LP[i] + rotX(p - LP[i], uA[i]);
          vec3 K2 = LP[i] + rotX(K - LP[i], uA[i]);
          return mix(q, K2 + rotX(q - K2, uB[i]), smoothstep(0.4, 0.6, s));
        }`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
        {
          vec3 nAcc = vec3(0.0); float wSum = 0.0; float s;
          for (int i = 0; i < 4; i++) {
            float w = limbW(position, i, s);
            vec3 n2 = mix(rotX(objectNormal, uA[i]), rotX(objectNormal, uA[i] + uB[i]), smoothstep(0.4, 0.6, s));
            wSum += w; nAcc += w * (n2 - objectNormal);
          }
          objectNormal = normalize(objectNormal + nAcc / max(1.0, wSum));
        }`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          vec3 pAcc = vec3(0.0); float wSum = 0.0; float s;
          for (int i = 0; i < 4; i++) {
            float w = limbW(position, i, s);
            wSum += w; pAcc += w * (limbPos(position, i, s) - position);
          }
          transformed += pAcc / max(1.0, wSum);
        }`,
      );
  };
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.material = gold;
      m.frustumCulled = false;
    }
  });
  const inner = new THREE.Group();
  inner.add(model);
  if (GORILLA_HEAD_FLIP) model.rotation.y = Math.PI;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const s = 3.4 / Math.max(size.z, 1e-3); // nose to rump, about the rocket's length
  inner.scale.setScalar(s);
  const baseY = -(box.min.y + size.y * 0.5) * s;
  inner.position.set(-(box.min.x + size.x * 0.5) * s, baseY, -(box.min.z + size.z * 0.5) * s);
  group.add(inner);

  const half = (size.z * s) / 2;
  // the engine fires from just inside his rump
  const { mesh: plumeMesh, material: plume } = makePlume("#fff1e0", "#f0633f", 0.28, 4.2);
  plumeMesh.rotation.x = Math.PI / 2; // trail along -Z
  plumeMesh.position.set(0, 0.15, -half + 0.55);
  group.add(plumeMesh);
  const glow = engineGlow();
  glow.position.set(0, 0.15, -half + 0.3);
  group.add(glow);
  // far enough back that it lights the space round the flame, not the gold
  const light = new THREE.PointLight("#ff7a52", 6, 26, 1.6);
  light.position.set(0, 0.15, -half - 2.2);
  group.add(light);
  // a warm key from above-front so the gold reads against black space
  const key = new THREE.DirectionalLight("#fff1dc", 0.5);
  key.position.set(1.5, 3, 4);
  group.add(key);
  key.target = inner;

  let phase = 0;
  const tick = (dtS: number, gait: number) => {
    // about 1.6 strides a second
    phase += dtS * gait * 10;
    for (let i = 0; i < 4; i++) {
      const c = phase + BEAT[i] * Math.PI * 2;
      // swing to the shared running angle (rotX moves the foot back for +a)
      const target = MID[i] + SWING[i] * Math.sin(c);
      run.uA.value[i] = (REST[i] - target) * gait;
      // fold the elbow or knee while the limb swings forward
      const f = 0.5 + 0.5 * Math.cos(c);
      run.uB.value[i] = FOLD[i] * f * f * gait;
    }
    // the body lifts twice a stride, pitches with the push and sways side to side
    inner.position.y = baseY + Math.abs(Math.sin(phase)) * 0.09 * gait;
    inner.rotation.x = Math.sin(phase + 0.9) * 0.06 * gait;
    inner.rotation.z = Math.sin(phase + 0.3) * 0.05 * gait;
  };
  return { group, plume, plumeMesh, glow, light, footOffset: half, uprightRoll: Math.PI / 2, tick };
}

/* ------------------------------------------------------------------ */
/* Post: vignette + a chromatic pulse only during the sun slingshot    */
/* ------------------------------------------------------------------ */

const FinishShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAmount: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float d = length(dir);
      vec3 col;
      if (uAmount > 0.00005) {
        vec2 off = dir * uAmount * (0.4 + d);
        col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }
      col *= 1.0 - smoothstep(0.42, 0.95, d) * 0.55;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ */
/* Disposal                                                            */
/* ------------------------------------------------------------------ */

function disposeTree(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => materials.add(x));
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) inst.dispose();
  });
  materials.forEach((mat) => {
    for (const v of Object.values(mat)) if (v instanceof THREE.Texture) textures.add(v);
    const u = (mat as THREE.ShaderMaterial).uniforms;
    if (u) for (const k of Object.keys(u)) if (u[k].value instanceof THREE.Texture) textures.add(u[k].value);
    mat.dispose();
  });
  textures.forEach((t) => t.dispose());
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

// Your own model (vehicle "custom" in flight.config.ts): any glTF/GLB that
// faces +Z with +Y up, scaled to the rocket's length and flown on the same
// path. Its own materials are kept; its first animation clip, if any, plays.
// Falls back to the rocket if the model cannot be fetched.
async function makeCustom(env: THREE.Texture, cfg: CustomVehicle): Promise<VehicleRig> {
  const group = new THREE.Group();
  const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) => {
    const timer = window.setTimeout(() => rej(new Error("custom vehicle timeout")), 8000);
    new GLTFLoader().load(
      cfg.model,
      (g) => {
        window.clearTimeout(timer);
        res(g);
      },
      undefined,
      (e) => {
        window.clearTimeout(timer);
        rej(e);
      },
    );
  });
  const model = gltf.scene;
  model.rotation.y = ((cfg.rotationY ?? 0) * Math.PI) / 180;
  const inner = new THREE.Group();
  inner.add(model);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = (cfg.length ?? 3.6) / Math.max(size.z, 1e-3);
  inner.scale.setScalar(s);
  const baseY = -(box.min.y + size.y * 0.5) * s;
  inner.position.y = baseY;
  inner.position.z = -(box.min.z + size.z * 0.5) * s;
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.frustumCulled = false;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const std = mat as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial) {
        std.envMap = env;
        std.envMapIntensity = 0.5;
      }
    }
  });
  group.add(inner);

  const mixer = new THREE.AnimationMixer(model);
  const clip = gltf.animations[0];
  if (clip) mixer.clipAction(clip).play();

  const half = (size.z * s) / 2;
  const core = cfg.engine?.core ?? "#fff4ec";
  const edge = cfg.engine?.edge ?? VERMILION;
  const { mesh: plumeMesh, material: plume } = makePlume(core, edge, 0.3, 4);
  plumeMesh.rotation.x = Math.PI / 2; // trail along -Z
  plumeMesh.position.set(0, 0, -half + 0.05);
  group.add(plumeMesh);

  const glow = engineGlow();
  glow.position.z = -half - 0.2;
  group.add(glow);

  const light = new THREE.PointLight(edge, 6, 26, 1.6);
  light.position.z = -half - 0.5;
  group.add(light);

  const tick = (dtS: number, gait: number) => {
    mixer.update(dtS * gait);
  };
  const dispose = () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
  };
  return { group, plume, plumeMesh, glow, light, footOffset: half, uprightRoll: ((cfg.uprightRoll ?? 0) * Math.PI) / 180, tick, dispose };
}

// Prepare + play in one go (replay, or a launch that beat the prewarm).
export async function runJourney3d(opts: Journey3DOptions): Promise<Journey3DHandle> {
  const handle = await prepareJourney3d(opts);
  if (!handle.start()) {
    handle.cancel();
    throw new Error("webgl context lost");
  }
  return handle;
}

// Build the whole flight (renderer, textures, models, compiled shaders)
// and render its first frame, but hold the clock until start(). FlightExperience
// calls this while the guest fills in the form, so pressing board plays at once
// instead of waiting seconds for the scene to build.
export async function prepareJourney3d(opts: Journey3DOptions): Promise<Journey3DHandle> {
  const { canvas, durationMs, onCaption, onThesis, onProgress, onCue, onReady, onDone } = opts;
  const thesis = opts.thesis ?? [];
  const vehicle: Vehicle = opts.vehicle ?? "rocket";
  // Every vehicle leaves a sparkling tail. The horse flight also gets
  // glittering planets and a sunset-pink planet to land on.
  const glitterOn = vehicle === "horse";
  const durS = durationMs / 1000;
  const tl = buildWarp(durS);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance", stencil: false });
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps colours true, compresses only highlights
  renderer.toneMappingExposure = 1;

  const sizeOf = () => ({ w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight });
  let { w, h } = sizeOf();
  renderer.setSize(w, h, false);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // Everything below allocates GPU resources; if any step throws, free what
  // exists so the 2D fallback starts from a clean slate.
  const scene = new THREE.Scene();
  let composer: EffectComposer | null = null;
  let envRT: THREE.WebGLRenderTarget | null = null;
  let rig: VehicleRig | null = null;
  const planetMaps: THREE.Texture[] = [];
  let ro: ResizeObserver | null = null;
  let raf = 0;
  let cancelled = false;

  const disposeAll = () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    ro?.disconnect();
    rig?.dispose?.();
    disposeTree(scene);
    planetMaps.forEach((t) => t.dispose());
    envRT?.dispose();
    if (composer) {
      for (const p of composer.passes) p.dispose();
      composer.dispose();
    }
    renderer.dispose();
  };

  try {
    scene.background = new THREE.Color("#05060a");
    scene.fog = new THREE.FogExp2("#05060a", 0.011); // only the asteroids opt in

    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 2000);
    scene.add(camera); // the fill light rides with the camera

    // soft reflections for the vehicle only (planets are photos, rocks are matte)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    envRT = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    const env = envRT.texture;

    const loader = new THREE.TextureLoader();
    const load = (url: string) =>
      new Promise<THREE.Texture>((res) => {
        loader.load(
          url,
          (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            t.anisotropy = maxAniso;
            res(t);
          },
          undefined,
          () => res(new THREE.Texture()),
        );
      });
    const [earthTex, moonTex, marsTex, loadedRig] = await Promise.all([
      load("/flight/earth.jpg"),
      load("/flight/moon.jpg"),
      load("/flight/mars-planet.jpg"),
      vehicle === "horse"
        ? makeHorse(env).catch(() => makeRocket(env))
        : vehicle === "gorilla"
          ? makeGoldGorilla(env).catch(() => makeRocket(env))
          : vehicle === "custom" && opts.customVehicle
            ? makeCustom(env, opts.customVehicle).catch((e) => {
                console.warn("[flight-pass] custom vehicle failed to load, flying the rocket:", e);
                return makeRocket(env);
              })
            : Promise.resolve(makeRocket(env)),
    ]);
    planetMaps.push(earthTex, moonTex, marsTex);
    rig = loadedRig;
    if (cancelled) throw new Error("cancelled");

    // ---- the path ----
    const F = buildFlight(durS);
    const _p = new THREE.Vector3();
    const _d = new THREE.Vector3();
    const fwdAt = (t: number, out: THREE.Vector3) => {
      const y = readNum(F, F.yaw, t);
      return out.set(-Math.sin(y), 0, -Math.cos(y));
    };

    // ---- lights ----
    scene.add(new THREE.HemisphereLight("#8fa4ff", "#2a1810", 0.45));
    const fill = new THREE.DirectionalLight("#dfe6ff", 0.7);
    fill.position.set(1.5, 2.5, 0);
    fill.target.position.set(0, 0, -12);
    camera.add(fill, fill.target);

    // ---- stars (ride with the camera) ----
    const STARS = Math.min(2200, Math.max(900, Math.floor((w * h) / 180)));
    const sPos = new Float32Array(STARS * 3);
    const sSize = new Float32Array(STARS);
    const sTone = new Float32Array(STARS);
    for (let i = 0; i < STARS; i++) {
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(320 + Math.random() * 180);
      sPos.set([_d.x, _d.y, _d.z], i * 3);
      sSize[i] = 0.55 + Math.pow(Math.random(), 3) * 1.3;
      sTone[i] = Math.random();
    }
    const stars = makeStreaks(sPos, sSize, sTone);
    stars.mesh.renderOrder = -10;
    scene.add(stars.mesh);

    // ---- dust (world-fixed, along the whole route) ----
    const DUST = 520;
    const dPos = new Float32Array(DUST * 3);
    const dSize = new Float32Array(DUST);
    const dTone = new Float32Array(DUST);
    const _r = new THREE.Vector3();
    for (let i = 0; i < DUST; i++) {
      const t = 0.03 + Math.random() * 0.8;
      readVec(F, F.pos, t, _p);
      fwdAt(t, _d);
      _r.crossVectors(_d, UP).normalize();
      const a = Math.random() * Math.PI * 2;
      const rr = 2.5 + Math.pow(Math.random(), 0.7) * 16;
      _p.addScaledVector(_r, Math.cos(a) * rr).addScaledVector(UP, Math.sin(a) * rr * 0.8).addScaledVector(_d, (Math.random() - 0.5) * 8);
      dPos.set([_p.x, _p.y, _p.z], i * 3);
      dSize[i] = 0.5 + Math.random() * 0.7;
      dTone[i] = 0.25 + Math.random() * 0.5;
    }
    const dust = makeStreaks(dPos, dSize, dTone);
    dust.material.uniforms.uNearFade.value = 3;
    dust.mesh.renderOrder = -3;
    scene.add(dust.mesh);

    // ---- Earth: under the pad; the lit limb rotated up to meet the rocket ----
    const earth = makePlanet({ map: earthTex, cx: 0.497, cy: 0.495, r: 0.4, rot: Math.PI / 6 }, 16);
    const earthPos = new THREE.Vector3(0, -rig.footOffset - 16 * 0.985, -2.5);
    earth.mesh.position.copy(earthPos);
    scene.add(earth.mesh);

    // ---- Moon: abeam on the left as the warp settles ----
    const moon = makePlanet({ map: moonTex, cx: 0.504, cy: 0.488, r: 0.428, rot: 0 }, 3.4);
    readVec(F, F.pos, BEAT.moon, _p);
    fwdAt(BEAT.moon, _d);
    _r.crossVectors(_d, UP).normalize();
    moon.mesh.position.copy(_p).addScaledVector(_r, -8.5).addScaledVector(UP, 2.8).addScaledVector(_d, 7);
    scene.add(moon.mesh);

    // ---- Sun: just above and left of the line we fly, so it grows dead ahead
    // through the approach (a portrait frame is narrow) and the rocket skims
    // under its corona as the slingshot turn begins ----
    const SUN_R = 3.0;
    const sun = makeSun(SUN_R);
    readVec(F, F.pos, 0.64, _p);
    fwdAt(0.64, _d);
    _r.crossVectors(_d, UP).normalize();
    const sunPos = _p.clone().addScaledVector(_r, -2.5).addScaledVector(UP, 6.5);
    sun.mesh.position.copy(sunPos);
    scene.add(sun.mesh);
    const sunLight = new THREE.PointLight("#ffe2c6", 2.2, 0, 0);
    sunLight.position.copy(sunPos);
    scene.add(sunLight);

    // ---- Mars + the landing shot ----
    const T = F.touchdown;
    const ground = T.clone().addScaledVector(UP, -rig.footOffset);
    const camFinal = T.clone().addScaledVector(F.landFwd, -19).addScaledVector(F.landRight, 4).addScaledVector(UP, 1.6);
    const lookFinal = T.clone().addScaledVector(UP, 2.5).addScaledVector(F.landRight, -0.4);
    const MARS_R = 12;
    const mars = makePlanet({ map: marsTex, cx: 0.498, cy: 0.496, r: 0.4, rot: Math.PI / 2 }, MARS_R);
    // Put the disc's top limb on the final camera's line of sight through the
    // touchdown point, just behind it, so the rocket's feet meet the horizon
    // exactly. The billboard tilts with the view, hence a few fixed-point passes.
    const _v = new THREE.Vector3();
    const _u = new THREE.Vector3();
    const limb = ground.clone().addScaledVector(_v.subVectors(ground, camFinal).normalize(), 1.5);
    const marsPos = limb.clone().addScaledVector(UP, -MARS_R);
    for (let i = 0; i < 6; i++) {
      _v.subVectors(marsPos, camFinal).normalize();
      _u.copy(UP).addScaledVector(_v, -UP.dot(_v)).normalize();
      marsPos.copy(limb).addScaledVector(_u, -MARS_R * 0.995);
    }
    mars.mesh.position.copy(marsPos);
    scene.add(mars.mesh);

    // touchdown dust ring
    const puff = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialTexture([
          [0, "rgba(255,200,160,0.35)"],
          [0.5, "rgba(245,160,110,0.8)"],
          [0.75, "rgba(210,120,80,0.35)"],
          [1, "rgba(160,80,50,0)"],
        ]),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    puff.position.copy(ground);
    puff.renderOrder = 2;
    scene.add(puff);

    // ---- glitter: a sparkling tail on both vehicles ----
    const glitter = makeGlitter(1400, !glitterOn && vehicle !== "gorilla", vehicle === "gorilla");
    glitter.points.renderOrder = -2;
    scene.add(glitter.points);
    if (glitterOn) {
      for (const pl of [earth, moon, mars]) pl.material.uniforms.uGlitter.value = 1;
      mars.material.uniforms.uTint.value = 1; // a sunset-pink planet instead of red Mars
      (puff.material as THREE.SpriteMaterial).color.setRGB(1.0, 0.62, 0.9);
    }
    const _gp = new THREE.Vector3();
    const _gv = new THREE.Vector3();
    let glitterAcc = 0;
    // a spark leaving point p with a little scatter around velocity v
    const spark = (p: THREE.Vector3, vx: number, vy: number, vz: number, scatter: number, at: number) => {
      glitter.emit(
        p.x + (Math.random() - 0.5) * 0.5,
        p.y + (Math.random() - 0.5) * 0.5,
        p.z + (Math.random() - 0.5) * 0.5,
        vx + (Math.random() - 0.5) * scatter,
        vy + (Math.random() - 0.5) * scatter,
        vz + (Math.random() - 0.5) * scatter,
        at,
      );
    };

    // ---- asteroid belt (instanced, lumpy, lit) ----
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    {
      const pa = rockGeo.getAttribute("position");
      for (let i = 0; i < pa.count; i++) {
        _v.set(pa.getX(i), pa.getY(i), pa.getZ(i));
        const n = Math.sin(_v.x * 3.1 + _v.y * 1.7) * Math.cos(_v.z * 2.3 - _v.x * 1.1);
        _v.multiplyScalar(1 + 0.22 * n);
        pa.setXYZ(i, _v.x, _v.y, _v.z);
      }
      rockGeo.computeVertexNormals();
    }
    const rockMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95, metalness: 0.05, flatShading: true });
    const ROCKS = 64;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
    const rockBase: THREE.Matrix4[] = [];
    const rockAxis: THREE.Vector3[] = [];
    const rockSpeed = new Float32Array(ROCKS);
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    for (let i = 0; i < ROCKS; i++) {
      const t = 0.17 + Math.random() * 0.43;
      readVec(F, F.pos, t, _p);
      fwdAt(t, _d);
      _r.crossVectors(_d, UP).normalize();
      const a = Math.random() * Math.PI * 2;
      const rr = 9.5 + Math.pow(Math.random(), 1.3) * 24;
      dummy.position.copy(_p).addScaledVector(_r, Math.cos(a) * rr).addScaledVector(UP, Math.sin(a) * rr * 0.7).addScaledVector(_d, (Math.random() - 0.5) * 6);
      const s = 0.3 + Math.pow(Math.random(), 2.2) * 1.5;
      dummy.scale.set(s, s * (0.65 + Math.random() * 0.5), s * (0.8 + Math.random() * 0.4));
      dummy.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
      rockBase.push(dummy.matrix.clone());
      rockAxis.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize());
      rockSpeed[i] = 0.15 + Math.random() * 0.6;
      tint.setHSL(0.05 + Math.random() * 0.04, 0.16 + Math.random() * 0.12, 0.22 + Math.random() * 0.12);
      rocks.setColorAt(i, tint);
    }
    rocks.frustumCulled = false;
    scene.add(rocks);

    // ---- vehicle ----
    scene.add(rig.group);

    const bufW = w * dpr;
    const bufH = h * dpr;

    // ---- post ----
    const rt = new THREE.WebGLRenderTarget(bufW, bufH, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(scene, camera));
    // threshold 1.0 on the HDR buffer: only the sun + engine are bright
    // enough to bloom; planets and the hull stay crisp
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.75, 0.42, 1.05);
    composer.addPass(bloom);
    const finish = new ShaderPass(FinishShader);
    composer.addPass(finish);
    composer.addPass(new OutputPass());

    const setViewport = () => {
      stars.material.uniforms.uViewport.value.set(w * dpr, h * dpr);
      dust.material.uniforms.uViewport.value.set(w * dpr, h * dpr);
      stars.material.uniforms.uWidth.value = 1.15 * dpr;
      dust.material.uniforms.uWidth.value = 0.9 * dpr;
    };
    setViewport();

    const applySize = () => {
      const s = sizeOf();
      w = s.w;
      h = s.h;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      composer!.setPixelRatio(dpr);
      composer!.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      setViewport();
    };
    let resizePending = false;
    ro = new ResizeObserver(() => {
      resizePending = true;
    });
    ro.observe(canvas);

    // ---- per-frame state (all preallocated) ----
    const cRight = camTrack(1);
    const cUp = camTrack(2);
    const cBack = camTrack(3);
    const cLookUp = camTrack(4);
    const cLookAhead = camTrack(5);
    const cFov = camTrack(6);
    const camRel = new SpringV3();
    const lookRel = new SpringV3();
    const scalarVel = new Float64Array(4);
    let fovNow = 55;
    let rollNow = 0;
    let bankNow = 0;
    let camYaw = 0;

    const rkPos = new THREE.Vector3();
    const rkDir = new THREE.Vector3();
    const fwdH = new THREE.Vector3(); // camera frame heading (lagged)
    const headH = new THREE.Vector3(); // the vehicle's own horizontal heading
    const rightH = new THREE.Vector3();
    const camTarget = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    const _x = new THREE.Vector3();
    const _y = new THREE.Vector3();
    const _z = new THREE.Vector3();
    const _m = new THREE.Matrix4();
    const _q = new THREE.Quaternion();
    const _qUp = new THREE.Quaternion();
    const _qBank = new THREE.Quaternion();
    const _look = new THREE.Vector3();
    const _rot = new THREE.Matrix4();
    const Z_AXIS = new THREE.Vector3(0, 0, 1);

    let lastCaption: string | null = null;
    let lastThesis = -1;
    let cueIdx = 0;
    let doneFired = false;

    // t: design progress 0..1. realS: real seconds into the flight. rate:
    // design / real speed.
    const update = (t: number, dtS: number, elapsedS: number, snap: boolean, realS: number, rate: number) => {
      // --- vehicle on the path ---
      readVec(F, F.pos, t, rkPos);
      readVec(F, F.dir, t, rkDir).normalize();
      // the camera's heading trails the rocket's on a spring, so turns read as
      // the rocket banking away rather than the whole world swinging round
      const yawT = readNum(F, F.yaw, t);
      headH.set(-Math.sin(yawT), 0, -Math.cos(yawT));
      camYaw = snap ? yawT : springStep(camYaw, yawT, scalarVel, 3, 0.45, dtS);
      fwdH.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
      rightH.crossVectors(fwdH, UP).normalize();
      const speed = readNum(F, F.speed, t);
      const turn = readNum(F, F.turn, t);
      const accel = readNum(F, F.accel, t);

      // attitude basis: +Z along travel, X = the pitch axis (never degenerate,
      // even pointing straight up on the pad), Y completes it
      _z.copy(rkDir);
      _x.crossVectors(UP, headH).normalize();
      _y.crossVectors(_z, _x).normalize();
      _x.crossVectors(_y, _z).normalize();
      _m.makeBasis(_x, _y, _z);
      _q.setFromRotationMatrix(_m);
      // landing attitude: flip to stand on its tail for the retro burn
      const flip = ease(0.855, 0.925, t);
      if (flip > 0) {
        _z.copy(UP);
        _y.copy(headH).negate();
        _x.crossVectors(_y, _z);
        _m.makeBasis(_x, _y, _z);
        _qUp.setFromRotationMatrix(_m);
        _q.slerp(_qUp, flip);
      }
      // bank into turns (damped so it breathes in and out)
      const bankTarget = THREE.MathUtils.clamp(-turn * 0.55, -0.75, 0.75) * (1 - flip);
      bankNow = snap ? bankTarget : springStep(bankNow, bankTarget, scalarVel, 0, 0.25, dtS);
      _qBank.setFromAxisAngle(Z_AXIS, bankNow);
      _q.multiply(_qBank);
      // how upright it is (from the attitude itself, so it eases in and out
      // with the gravity turn and the landing flip)
      const upright = clamp01(_z.set(0, 0, 1).applyQuaternion(_q).y);
      if (rig!.uprightRoll) {
        _q.multiply(_qBank.setFromAxisAngle(Z_AXIS, rig!.uprightRoll * upright * upright));
      }
      rig!.group.position.copy(rkPos);
      rig!.group.quaternion.copy(_q);

      // --- engine ---
      const warp = Math.max(bell(0.025, 0.12, t), bell(0.715, 0.8, t) * 0.85);
      const retro = bell(0.855, BEAT.touchdown + 0.004, t);
      const cut = 1 - ease(BEAT.touchdown - 0.004, BEAT.touchdown + 0.02, t);
      const ignite = ease(0, 0.02, t);
      const power = (0.5 + 0.4 * ignite + warp * 0.8 + retro * 1.0 + ease(0.7, 0.75, t) * (1 - ease(0.78, 0.84, t)) * 0.3) * cut;
      const pm = rig!.plume;
      pm.uniforms.uPower.value = power;
      pm.uniforms.uTime.value = elapsedS;
      rig!.plumeMesh.scale.set(1, 0.7 + 0.35 * power + warp * 0.6, 1);
      rig!.glow.scale.setScalar(0.9 + power * 0.5);
      (rig!.glow.material as THREE.SpriteMaterial).opacity = Math.min(1, 0.1 + power * 0.3);
      rig!.light.intensity = 0.8 + power * 2.2;
      // the horse gallops the whole way and stands still once it has landed
      rig!.tick?.(dtS, 1 - ease(BEAT.touchdown - 0.01, BEAT.touchdown + 0.02, t), upright);

      // --- camera: heading-frame offsets -> landing shot, on a spring ---
      const back = cBack.at(t) + THREE.MathUtils.clamp(accel * 0.09, -1.5, 5);
      camTarget.copy(rkPos).addScaledVector(rightH, cRight.at(t)).addScaledVector(UP, cUp.at(t)).addScaledVector(fwdH, -back);
      lookTarget.copy(rkPos).addScaledVector(UP, cLookUp.at(t)).addScaledVector(fwdH, cLookAhead.at(t));
      // Slingshot: ease the view partway toward the sun (slowly, across the
      // whole beat) so its corona fills the inside of the turn.
      const sling = ease(0.5, 0.63, t) * (1 - ease(0.7, 0.8, t));
      if (sling > 0) lookTarget.lerp(sunPos, sling * 0.12);
      const land = ease(0.845, 0.935, t);
      if (land > 0) {
        camTarget.lerp(camFinal, land);
        lookTarget.lerp(lookFinal, land);
      }
      camTarget.sub(rkPos);
      lookTarget.sub(rkPos);
      if (snap) {
        camRel.snap(camTarget);
        lookRel.snap(lookTarget);
      } else {
        camRel.update(camTarget, 0.2, dtS);
        lookRel.update(lookTarget, 0.14, dtS);
      }
      camera.position.copy(rkPos).add(camRel.value);
      _look.copy(rkPos).add(lookRel.value);
      // a whisper of shake on ignition and touchdown (smooth sines, no noise)
      const shake = bell(0.004, 0.07, t) * 0.05 + bell(BEAT.touchdown - 0.004, BEAT.touchdown + 0.03, t) * 0.035;
      if (shake > 0) {
        camera.position.x += Math.sin(elapsedS * 53) * shake;
        camera.position.y += Math.sin(elapsedS * 41 + 1.3) * shake;
      }
      camera.up.copy(UP);
      camera.lookAt(_look);
      const rollTarget = bankNow * 0.35 * (1 - sling);
      rollNow = snap ? rollTarget : springStep(rollNow, rollTarget, scalarVel, 1, 0.3, dtS);
      camera.rotateZ(rollNow);
      const fovTarget = cFov.at(t) + warp * 4;
      fovNow = snap ? fovTarget : springStep(fovNow, fovTarget, scalarVel, 2, 0.15, dtS);
      // keep the horizontal field sane if the canvas is ever landscape
      const aspect = w / h;
      const fov = aspect > 0.9 ? (2 * Math.atan(Math.tan((fovNow * DEG) / 2) * (0.9 / aspect))) / DEG : fovNow;
      if (Math.abs(camera.fov - fov) > 1e-3 || camera.aspect !== aspect) {
        camera.fov = fov;
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      }
      camera.updateMatrixWorld();

      // --- stars + dust ---
      stars.mesh.position.copy(camera.position);
      stars.material.uniforms.uTrail.value.copy(rkDir).multiplyScalar(warp * 150);
      dust.material.uniforms.uTrail.value.copy(rkDir).multiplyScalar(speed * rate * 0.05 + warp * 3);
      dust.material.uniforms.uGain.value = 0.55 * (1 - ease(0.84, 0.9, t));

      // --- planets face the camera ---
      earth.mesh.lookAt(camera.position);
      moon.mesh.lookAt(camera.position);
      mars.mesh.lookAt(camera.position);
      sun.mesh.lookAt(camera.position);
      earth.mesh.visible = t < 0.2;
      moon.mesh.visible = t > 0.03 && t < 0.3;
      sun.material.uniforms.uTime.value = elapsedS;
      sun.material.uniforms.uBoost.value = ease(0.3, 0.6, t); // revealed for its own beat
      // Mars is a photo: keep it at photo brightness, a touch dimmer as it
      // fills the frame so the hand-off to the surface shot does not flash
      mars.material.uniforms.uBright.value = 1 - 0.18 * ease(0.86, 1, t);
      // Mars waits for the fling: it would otherwise hang beside the sun
      mars.material.uniforms.uAlpha.value = ease(0.685, 0.73, t);
      mars.mesh.visible = t > 0.685;

      // --- asteroids spin (only while the belt is near) ---
      if (t > 0.12 && t < 0.72) {
        for (let i = 0; i < ROCKS; i++) {
          _rot.makeRotationAxis(rockAxis[i], elapsedS * rockSpeed[i]);
          _m.multiplyMatrices(rockBase[i], _rot);
          rocks.setMatrixAt(i, _m);
        }
        rocks.instanceMatrix.needsUpdate = true;
      }
      rocks.visible = t > 0.1 && t < 0.8;

      // --- touchdown dust ---
      const pt = clamp01((t - BEAT.touchdown + 0.004) / 0.06);
      const pm2 = puff.material as THREE.SpriteMaterial;
      pm2.opacity = pt > 0 ? Math.sin(Math.min(1, pt * 1.6) * Math.PI) * 0.9 * (1 - pt * 0.4) : 0;
      const ps = 1 + ease(0, 1, pt) * 7;
      puff.scale.set(ps, ps * 0.32, 1); // flattened: dust spreading along the ground
      puff.visible = pm2.opacity > 0.001;

      // --- glitter: the tail on every vehicle; for the horse also the planets,
      // and once it has landed a slow shimmer rising around it ---
      {
        earth.material.uniforms.uTime.value = elapsedS;
        moon.material.uniforms.uTime.value = elapsedS;
        mars.material.uniforms.uTime.value = elapsedS;
        glitter.material.uniforms.uTime.value = elapsedS;
        glitter.material.uniforms.uScale.value = (h * dpr) / (2 * Math.tan((camera.fov * DEG) / 2));
        if (!snap) {
          const landed = ease(BEAT.touchdown - 0.004, BEAT.touchdown + 0.02, t);
          glitterAcc += dtS * ((vehicle === "gorilla" ? 480 : 360) * (1 - landed) + (glitterOn ? 50 : 0) * landed);
          // tail point, behind the vehicle in its own frame (the rocket's nozzle)
          _gp.set(0, 0, -rig!.footOffset).applyQuaternion(rig!.group.quaternion).add(rig!.group.position);
          while (glitterAcc >= 1) {
            glitterAcc -= 1;
            if (landed < 0.5) {
              const sp = 0.5 + Math.random() * 1.8;
              spark(_gp, -rkDir.x * sp, -rkDir.y * sp, -rkDir.z * sp, 0.9, elapsedS);
            } else if (glitterOn) {
              _gv.copy(rig!.group.position).addScaledVector(UP, -rig!.footOffset * 0.6);
              spark(_gv, 0, 0.5 + Math.random() * 0.6, 0, 1.2, elapsedS);
            }
          }
        }
      }

      // --- post ---
      const surge = bell(0.6, 0.78, t);
      bloom.strength = 0.6 + surge * 0.2;
      renderer.toneMappingExposure = 1 - 0.28 * bell(0.6, 0.74, t); // eyes adjusting to the sun
      finish.uniforms.uAmount.value = surge * 0.0045 + warp * 0.0025;

      // --- captions, cues, progress ---
      let cap = "";
      for (let i = 0; i < CAPTIONS.length; i++) if (t >= CAPTIONS[i].at) cap = CAPTIONS[i].text;
      if (cap !== lastCaption) {
        lastCaption = cap;
        onCaption?.(cap);
      }
      let li = -1;
      for (let i = 0; i < thesis.length; i++) if (t >= thesis[i].at) li = i;
      if (li !== lastThesis) {
        // replaying from the start or seeking can skip entries: only a step
        // to the very next entry may stack, anything else redraws cleanly
        const step = li === lastThesis + 1;
        lastThesis = li;
        const entry = li >= 0 ? thesis[li] : null;
        onThesis?.(entry ? entry.text : "", !!entry?.add && step);
      }
      while (!snap && cueIdx < CUES.length && t >= CUES[cueIdx].at) {
        if (glitterOn && CUES[cueIdx].cue === "touchdown") {
          // a burst of glitter where the horse lands
          for (let i = 0; i < 240; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = 1.2 + Math.random() * 3.2;
            spark(ground, Math.cos(a) * sp, 0.4 + Math.random() * 2.2, Math.sin(a) * sp, 0.6, elapsedS);
          }
        }
        onCue?.(CUES[cueIdx].cue);
        cueIdx++;
      }
      onProgress?.(t);
    };

    // ---- warm up: compile every shader and upload every texture before the
    // clock starts, so the first seconds of the flight never hitch ----
    for (const tex of [earthTex, moonTex, marsTex]) renderer.initTexture(tex);
    update(0, 1 / 60, 0, true, 0, 1);
    // compile only walks visible objects, so show everything for the pass
    scene.traverse((o) => {
      o.visible = true;
    });
    await renderer.compileAsync(scene, camera);
    if (cancelled) throw new Error("cancelled");
    update(0, 1 / 60, 0, true, 0, 1); // restores per-beat visibility
    composer.render();

    // ---- loop ----
    let clockMs = 0;
    let lastNow = 0;
    let paused = false;
    let frames = 0;
    let slowMs = 0;
    let downshifted = 0;
    const loop = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(loop);
      if (resizePending) {
        resizePending = false;
        applySize();
      }
      const rawDt = lastNow ? now - lastNow : 16.7;
      lastNow = now;
      if (paused) return;
      // clamp: a hitch or a backgrounded tab slows the flight instead of skipping it
      const dt = Math.min(rawDt, 34);
      clockMs += dt;
      const realS = clockMs / 1000;
      const tau = tl.tau(realS);
      const t = Math.min(1, tau / durS);

      // adaptive resolution: if the device cannot hold ~50fps early on, drop
      // the pixel ratio once (while the warp hides the change)
      frames++;
      if (frames > 12 && frames <= 60) slowMs += rawDt;
      if (frames === 60 && downshifted === 0 && slowMs / 48 > 21 && dpr > 1.25) {
        dpr = Math.max(1.25, dpr * 0.75);
        downshifted = 1;
        applySize();
      }

      update(t, dt / 1000, realS, false, realS, tl.rate(tau));
      composer!.render();
      if (realS >= tl.realS && !doneFired) {
        doneFired = true;
        onDone();
        // keep rendering (dust settling, sun shimmer) while the caller fades
        // the canvas out; it calls cancel() when the fade is over
      }
    };
    let started = false;

    return {
      start: () => {
        if (cancelled) return false;
        if (started) return true;
        if (renderer.getContext().isContextLost()) return false;
        started = true;
        // the warm-up frames ran update() before anyone was listening, so the
        // first caption and thesis line fire again on the first real frame
        lastCaption = null;
        lastThesis = -1;
        cueIdx = 0;
        // the viewport may have changed while it waited (keyboard, rotation)
        if (resizePending) {
          resizePending = false;
          applySize();
          composer!.render();
        }
        onReady?.();
        raf = requestAnimationFrame(loop);
        return true;
      },
      cancel: disposeAll,
      seek: (t: number) => {
        paused = true;
        const tc = clamp01(t);
        clockMs = tl.real(tc * durS) * 1000;
        update(tc, 1 / 60, clockMs / 1000, true, clockMs / 1000, tl.rate(tc * durS));
        composer!.render();
      },
    };
  } catch (err) {
    disposeAll();
    throw err;
  }
}
