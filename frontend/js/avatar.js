// Valentina Avatar — Phase 1 POC
// Three.js + @pixiv/three-vrm + WebSocket voice chat + audio-driven lipsync

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { VRMLoaderPlugin, VRMUtils, VRMExpressionPresetName } from '@pixiv/three-vrm';

// ────────────────────────────────────────────────────────────────
// DOM refs
// ────────────────────────────────────────────────────────────────
const loadingEl = document.getElementById('loading');
const canvas = document.getElementById('scene');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// ────────────────────────────────────────────────────────────────
// Three.js scene setup
// ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.35, 2.2);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.3, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.8;
controls.maxDistance = 5;
controls.enablePan = false;
controls.update();

// Cyberpunk lighting: magenta key + cyan rim + violet fill
const keyLight = new THREE.DirectionalLight(0xff5ac8, 0.9);
keyLight.position.set(2, 3, 2);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x00f0ff, 1.2);
rimLight.position.set(-3, 2, -2);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0x9b5cff, 0.4);
fillLight.position.set(-1, 1, 3);
scene.add(fillLight);

const ambient = new THREE.AmbientLight(0x2a1a4a, 0.45);
scene.add(ambient);

// ────────────────────────────────────────────────────────────────
// Post-processing: Bloom + chromatic aberration
// ────────────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.setSize(window.innerWidth, window.innerHeight);

const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.35,   // strength (lowered)
  0.4,    // radius
  0.78    // threshold — only bright highlights bloom, not the whole character
);
composer.addPass(bloomPass);

// Chromatic aberration + subtle film grain + vignette
const hologramShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.0025 },
    uGrain: { value: 0.04 },
    uVignette: { value: 0.9 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uVignette;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 dir = vUv - 0.5;
      float dist = length(dir);
      // Chromatic aberration scales with distance from center
      float a = uAberration * (0.5 + dist);
      vec4 cr = texture2D(tDiffuse, vUv + dir * a);
      vec4 cg = texture2D(tDiffuse, vUv);
      vec4 cb = texture2D(tDiffuse, vUv - dir * a);
      vec4 col = vec4(cr.r, cg.g, cb.b, 1.0);
      // Vignette
      float vig = smoothstep(uVignette, 0.2, dist);
      col.rgb *= vig;
      // Film grain
      float grain = (rand(vUv + uTime * 0.001) - 0.5) * uGrain;
      col.rgb += grain;
      gl_FragColor = col;
    }
  `,
};
const hologramPass = new ShaderPass(hologramShader);
composer.addPass(hologramPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

// ────────────────────────────────────────────────────────────────
// Ground reflection (cyberpunk dancefloor)
// ────────────────────────────────────────────────────────────────
const mirrorGeo = new THREE.CircleGeometry(8, 64);
const mirror = new Reflector(mirrorGeo, {
  clipBias: 0.003,
  textureWidth: Math.min(window.innerWidth, 1024),
  textureHeight: Math.min(window.innerHeight, 1024),
  color: 0x222244,
});
mirror.rotation.x = -Math.PI / 2;
mirror.position.y = 0;
scene.add(mirror);

// Dark tint overlay on the mirror so reflection is subtle not mirror-perfect
const mirrorTintGeo = new THREE.CircleGeometry(8, 64);
const mirrorTintMat = new THREE.MeshBasicMaterial({
  color: 0x05030f,
  transparent: true,
  opacity: 0.65,
});
const mirrorTint = new THREE.Mesh(mirrorTintGeo, mirrorTintMat);
mirrorTint.rotation.x = -Math.PI / 2;
mirrorTint.position.y = 0.001;
scene.add(mirrorTint);

// ────────────────────────────────────────────────────────────────
// Volumetric fog — ground-level colored mist
// ────────────────────────────────────────────────────────────────
scene.fog = new THREE.FogExp2(0x0a0520, 0.11);

const fogPlaneGeo = new THREE.PlaneGeometry(16, 16, 1, 1);
const fogPlaneMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 } },
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vPos;
    void main() {
      vUv = uv;
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vPos;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
                 mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
    }
    void main() {
      vec2 p = vPos.xy * 0.25;
      float n = noise(p + uTime * 0.15);
      n += noise(p * 2.0 - uTime * 0.1) * 0.5;
      n += noise(p * 4.0 + uTime * 0.08) * 0.25;
      n *= 0.55;
      vec2 c = vUv - 0.5;
      float radial = smoothstep(0.5, 0.05, length(c));
      vec3 col = mix(vec3(0.08, 0.02, 0.25), vec3(0.0, 0.2, 0.4), n);
      col += vec3(0.15, 0.0, 0.2) * pow(n, 2.0);
      gl_FragColor = vec4(col * n * radial, n * radial * 0.55);
    }
  `,
});
const fogPlane = new THREE.Mesh(fogPlaneGeo, fogPlaneMat);
fogPlane.rotation.x = -Math.PI / 2;
fogPlane.position.y = 0.05;
scene.add(fogPlane);

// (second fog layer removed — was overpowering with additive blending)

// ────────────────────────────────────────────────────────────────
// Volumetric light beams (cones with shader)
// ────────────────────────────────────────────────────────────────
function makeLightBeam(color, posX, posZ) {
  const geo = new THREE.ConeGeometry(0.8, 6, 24, 1, true);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vPos;
      void main() {
        vUv = uv;
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vPos;
      void main() {
        // Fade from top (narrow, bright) to bottom (wide, faint)
        float vFade = smoothstep(0.0, 1.0, 1.0 - vUv.y);
        // Radial fade on the cone surface
        float edge = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
        float pulse = 0.8 + sin(uTime * 1.2) * 0.2;
        float alpha = vFade * edge * 0.35 * pulse;
        gl_FragColor = vec4(uColor * 1.5, alpha);
      }
    `,
  });
  const beam = new THREE.Mesh(geo, mat);
  beam.position.set(posX, 3, posZ);
  beam.rotation.x = Math.PI; // point down
  return { mesh: beam, mat };
}

const beam1 = makeLightBeam(0x00f0ff, -1.5, -0.5);
const beam2 = makeLightBeam(0xff00c8, 1.5, -0.5);
const beam3 = makeLightBeam(0x9b5cff, 0, 1.2);
scene.add(beam1.mesh, beam2.mesh, beam3.mesh);

// ────────────────────────────────────────────────────────────────
// Ambient dust — denser, smaller, closer particles for depth
// ────────────────────────────────────────────────────────────────
const DUST_COUNT = 800;
const dustGeo = new THREE.BufferGeometry();
const dPos = new Float32Array(DUST_COUNT * 3);
const dSize = new Float32Array(DUST_COUNT);
for (let i = 0; i < DUST_COUNT; i++) {
  dPos[i * 3 + 0] = (Math.random() - 0.5) * 8;
  dPos[i * 3 + 1] = Math.random() * 3.5;
  dPos[i * 3 + 2] = (Math.random() - 0.5) * 6;
  dSize[i] = 0.005 + Math.random() * 0.015;
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
dustGeo.setAttribute('size', new THREE.BufferAttribute(dSize, 1));
const dustMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  vertexShader: `
    attribute float size;
    uniform float uTime;
    varying float vAlpha;
    void main() {
      vec3 p = position;
      p.y += sin(uTime * 0.3 + position.x * 3.0) * 0.05;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = size * (400.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
      vAlpha = smoothstep(10.0, 0.5, -mv.z);
    }
  `,
  fragmentShader: `
    varying float vAlpha;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c);
      if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.0, d) * vAlpha * 0.5;
      gl_FragColor = vec4(0.7, 0.85, 1.0, a);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const dust = new THREE.Points(dustGeo, dustMat);
scene.add(dust);

// ────────────────────────────────────────────────────────────────
// Voice aura — radial shockwave pulse on speech start
// ────────────────────────────────────────────────────────────────
const auraGeo = new THREE.PlaneGeometry(4, 4, 1, 1);
const auraMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: {
    uProgress: { value: -1 }, // -1 = inactive, 0-1 = active animation
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uProgress;
    varying vec2 vUv;
    void main() {
      if (uProgress < 0.0) discard;
      vec2 c = vUv - 0.5;
      float d = length(c) * 2.0;
      // Ring expands outward: center at progress, width 0.08
      float ringCenter = uProgress;
      float ringWidth = 0.08;
      float ring = smoothstep(ringCenter - ringWidth, ringCenter, d) *
                   smoothstep(ringCenter + ringWidth, ringCenter, d);
      // Fade out over the lifetime of the pulse
      float fade = 1.0 - uProgress;
      float alpha = ring * fade * 1.2;
      vec3 col = mix(vec3(0.0, 0.9, 1.0), vec3(0.6, 0.3, 1.0), uProgress);
      gl_FragColor = vec4(col * 1.8, alpha);
    }
  `,
});
const auraMesh = new THREE.Mesh(auraGeo, auraMat);
auraMesh.position.set(0, 1.0, 0); // around chest height; billboarded each frame
scene.add(auraMesh);

let auraStartTime = -1;
const AURA_DURATION = 1.1; // seconds

function triggerVoiceAura() {
  auraStartTime = time;
}

// Floor glow ring
const ringGeo = new THREE.RingGeometry(0.4, 0.6, 64);
const ringMat = new THREE.MeshBasicMaterial({
  color: 0x00f0ff,
  transparent: true,
  opacity: 0.35,
  side: THREE.DoubleSide,
});
const ring = new THREE.Mesh(ringGeo, ringMat);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.01;
scene.add(ring);

// ────────────────────────────────────────────────────────────────
// Floating bokeh particles (cyan/magenta/violet)
// ────────────────────────────────────────────────────────────────
const PARTICLE_COUNT = 400;
const particleGeo = new THREE.BufferGeometry();
const pPositions = new Float32Array(PARTICLE_COUNT * 3);
const pColors = new Float32Array(PARTICLE_COUNT * 3);
const pSizes = new Float32Array(PARTICLE_COUNT);
const pSpeeds = new Float32Array(PARTICLE_COUNT);
const palette = [
  new THREE.Color(0x00f0ff), // cyan
  new THREE.Color(0xff00c8), // magenta
  new THREE.Color(0x9b5cff), // violet
  new THREE.Color(0xff5ac8), // pink
];
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const r = 2 + Math.random() * 4;
  const theta = Math.random() * Math.PI * 2;
  const phi = (Math.random() - 0.5) * 1.2;
  pPositions[i * 3 + 0] = Math.cos(theta) * r;
  pPositions[i * 3 + 1] = 0.5 + phi * 2 + Math.random() * 2;
  pPositions[i * 3 + 2] = Math.sin(theta) * r - 1;
  const c = palette[Math.floor(Math.random() * palette.length)];
  pColors[i * 3 + 0] = c.r;
  pColors[i * 3 + 1] = c.g;
  pColors[i * 3 + 2] = c.b;
  pSizes[i] = 0.02 + Math.random() * 0.06;
  pSpeeds[i] = 0.1 + Math.random() * 0.3;
}
particleGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
particleGeo.setAttribute('color', new THREE.BufferAttribute(pColors, 3));
particleGeo.setAttribute('size', new THREE.BufferAttribute(pSizes, 1));

const particleMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  vertexShader: `
    attribute float size;
    attribute vec3 color;
    varying vec3 vColor;
    uniform float uTime;
    void main() {
      vColor = color;
      vec3 p = position;
      p.y += sin(uTime * 0.5 + position.x * 2.0) * 0.1;
      p.x += cos(uTime * 0.3 + position.z * 2.0) * 0.08;
      vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = size * (300.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      vec2 c = gl_PointCoord - vec2(0.5);
      float d = length(c);
      if (d > 0.5) discard;
      float alpha = smoothstep(0.5, 0.0, d);
      alpha = pow(alpha, 2.0);
      gl_FragColor = vec4(vColor * 1.5, alpha * 0.9);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const particles = new THREE.Points(particleGeo, particleMat);
scene.add(particles);

// ────────────────────────────────────────────────────────────────
// Nebula background (procedural shader on a big sphere)
// ────────────────────────────────────────────────────────────────
const nebulaGeo = new THREE.SphereGeometry(30, 32, 32);
const nebulaMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: { uTime: { value: 0 } },
  vertexShader: `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vPos;
    uniform float uTime;
    // Simple value noise
    float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float noise(vec3 p) {
      vec3 i = floor(p); vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                     mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                     mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    void main() {
      vec3 dir = normalize(vPos);
      float n = noise(dir * 3.0 + vec3(uTime * 0.03));
      float n2 = noise(dir * 6.0 + vec3(uTime * 0.05, 0.0, 0.0));
      vec3 violet = vec3(0.15, 0.05, 0.35);
      vec3 cyan = vec3(0.0, 0.3, 0.55);
      vec3 magenta = vec3(0.4, 0.0, 0.3);
      vec3 col = mix(violet, cyan, n);
      col = mix(col, magenta, n2 * 0.5);
      col *= 0.4 + n * 0.6;
      // Star sparkles
      float stars = pow(noise(dir * 200.0), 40.0) * 3.0;
      col += vec3(stars);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const nebula = new THREE.Mesh(nebulaGeo, nebulaMat);
scene.add(nebula);

// ────────────────────────────────────────────────────────────────
// VRM loader
// ────────────────────────────────────────────────────────────────
let vrm = null;
let eyeGlowSprites = []; // additive sprite overlays on each eye
let gestureRig = null;
let gazeRig = null;
const gestureEuler = new THREE.Euler();
const gestureQuat = new THREE.Quaternion();
const gazeEuler = new THREE.Euler();
const gazeQuat = new THREE.Quaternion();
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

function cacheGestureRig() {
  const humanoid = vrm?.humanoid;
  if (!humanoid) {
    gestureRig = null;
    gazeRig = null;
    return;
  }

  const bones = {
    head: humanoid.getNormalizedBoneNode('head'),
    neck: humanoid.getNormalizedBoneNode('neck'),
    chest: humanoid.getNormalizedBoneNode('chest'),
    spine: humanoid.getNormalizedBoneNode('spine'),
    leftUpperArm: humanoid.getNormalizedBoneNode('leftUpperArm'),
    rightUpperArm: humanoid.getNormalizedBoneNode('rightUpperArm'),
    leftLowerArm: humanoid.getNormalizedBoneNode('leftLowerArm'),
    rightLowerArm: humanoid.getNormalizedBoneNode('rightLowerArm'),
    leftHand: humanoid.getNormalizedBoneNode('leftHand'),
    rightHand: humanoid.getNormalizedBoneNode('rightHand'),
    leftEye: humanoid.getNormalizedBoneNode('leftEye'),
    rightEye: humanoid.getNormalizedBoneNode('rightEye'),
  };

  const restRotations = {};
  for (const [name, bone] of Object.entries(bones)) {
    if (bone) restRotations[name] = bone.quaternion.clone();
  }

  gestureRig = { bones, restRotations };
  gazeRig = {
    bones: {
      leftEye: bones.leftEye || null,
      rightEye: bones.rightEye || null,
    },
    restRotations: {
      leftEye: restRotations.leftEye || null,
      rightEye: restRotations.rightEye || null,
    },
  };
}

const GAZE_SETTINGS = {
  baseYaw: 0,
  basePitch: -0.003,
  driftYawAmplitude: 0.028,
  driftPitchAmplitude: 0.018,
  driftYawSpeed: 0.18,
  driftPitchSpeed: 0.14,
  microIntervalMin: 2.8,
  microIntervalMax: 6.0,
  microDurationMin: 0.08,
  microDurationMax: 0.16,
  microYawAmplitude: 0.05,
  microPitchAmplitude: 0.028,
  followSpeed: 11.0,
  clampYaw: 0.13,
  clampPitch: 0.08,
  speechYawBias: 0.012,
  speechPitchBias: 0.014,
  speechBlend: 3.2,
};

const gazeState = {
  driftYawPhase: Math.random() * Math.PI * 2,
  driftPitchPhase: Math.random() * Math.PI * 2,
  currentYaw: 0,
  currentPitch: 0,
  speechYaw: 0,
  speechPitch: 0,
  speechYawTarget: 0,
  speechPitchTarget: 0,
  microActive: false,
  microStartAt: 0,
  microDuration: 0,
  microYaw: 0,
  microPitch: 0,
  nextMicroAt: Number.POSITIVE_INFINITY,
};

function scheduleNextMicroSaccade() {
  const range = GAZE_SETTINGS.microIntervalMax - GAZE_SETTINGS.microIntervalMin;
  gazeState.nextMicroAt = time + GAZE_SETTINGS.microIntervalMin + Math.random() * range;
}

function seedSpeechGazeBias() {
  gazeState.speechYawTarget = (Math.random() * 2 - 1) * GAZE_SETTINGS.speechYawBias;
  gazeState.speechPitchTarget = -Math.abs(Math.random() * GAZE_SETTINGS.speechPitchBias);
}

function triggerMicroSaccade() {
  const microRange = GAZE_SETTINGS.microDurationMax - GAZE_SETTINGS.microDurationMin;
  gazeState.microActive = true;
  gazeState.microStartAt = time;
  gazeState.microDuration = GAZE_SETTINGS.microDurationMin + Math.random() * microRange;
  gazeState.microYaw = (Math.random() * 2 - 1) * GAZE_SETTINGS.microYawAmplitude;
  gazeState.microPitch = (Math.random() * 2 - 1) * GAZE_SETTINGS.microPitchAmplitude;
}

function applyEyeOrientation(eyeBone, rest, yaw, pitch) {
  if (!eyeBone || !rest) return;
  gazeEuler.set(pitch, yaw, 0, 'XYZ');
  gazeQuat.setFromEuler(gazeEuler);
  eyeBone.quaternion.copy(rest).multiply(gazeQuat);
}

function updateGaze(dt) {
  if (!gazeRig || (!gazeRig.bones.leftEye && !gazeRig.bones.rightEye)) return;

  if (time >= gazeState.nextMicroAt && !gazeState.microActive) {
    triggerMicroSaccade();
    scheduleNextMicroSaccade();
  }

  const speaking = lipsyncActive ? THREE.MathUtils.clamp(smoothedVolume, 0, 1) : 0;
  const driftYaw = Math.sin(time * GAZE_SETTINGS.driftYawSpeed + gazeState.driftYawPhase) * GAZE_SETTINGS.driftYawAmplitude;
  const driftPitch = Math.cos(time * GAZE_SETTINGS.driftPitchSpeed + gazeState.driftPitchPhase) * GAZE_SETTINGS.driftPitchAmplitude;

  let microYaw = 0;
  let microPitch = 0;
  if (gazeState.microActive) {
    const t = (time - gazeState.microStartAt) / Math.max(0.0001, gazeState.microDuration);
    if (t >= 1) {
      gazeState.microActive = false;
      gazeState.microYaw = 0;
      gazeState.microPitch = 0;
    } else {
      const s = Math.sin(Math.PI * t);
      microYaw = gazeState.microYaw * s * s;
      microPitch = gazeState.microPitch * s * s;
    }
  }

  gazeState.speechYaw = THREE.MathUtils.lerp(
    gazeState.speechYaw,
    gazeState.speechYawTarget * speaking,
    1 - Math.exp(-GAZE_SETTINGS.speechBlend * dt)
  );
  gazeState.speechPitch = THREE.MathUtils.lerp(
    gazeState.speechPitch,
    gazeState.speechPitchTarget * speaking,
    1 - Math.exp(-GAZE_SETTINGS.speechBlend * dt)
  );

  const targetYaw = THREE.MathUtils.clamp(
    GAZE_SETTINGS.baseYaw + driftYaw + microYaw + gazeState.speechYaw,
    -GAZE_SETTINGS.clampYaw,
    GAZE_SETTINGS.clampYaw
  );
  const targetPitch = THREE.MathUtils.clamp(
    GAZE_SETTINGS.basePitch + driftPitch + microPitch + gazeState.speechPitch,
    -GAZE_SETTINGS.clampPitch,
    GAZE_SETTINGS.clampPitch
  );

  const follow = 1 - Math.exp(-GAZE_SETTINGS.followSpeed * dt);
  gazeState.currentYaw = THREE.MathUtils.lerp(gazeState.currentYaw, targetYaw, follow);
  gazeState.currentPitch = THREE.MathUtils.lerp(gazeState.currentPitch, targetPitch, follow);

  applyEyeOrientation(gazeRig.bones.leftEye, gazeRig.restRotations.leftEye, gazeState.currentYaw, gazeState.currentPitch);
  applyEyeOrientation(gazeRig.bones.rightEye, gazeRig.restRotations.rightEye, gazeState.currentYaw, gazeState.currentPitch);
}

function applyGestureRotation(name, x = 0, y = 0, z = 0) {
  const bone = gestureRig?.bones?.[name];
  const rest = gestureRig?.restRotations?.[name];
  if (!bone || !rest) return;

  gestureEuler.set(x, y, z, 'XYZ');
  gestureQuat.setFromEuler(gestureEuler);
  bone.quaternion.copy(rest).multiply(gestureQuat);
}

function updateGestures(dt, time) {
  if (!vrm || !gestureRig) return;

  const speaking = lipsyncActive ? 1 : 0;
  const volume = THREE.MathUtils.clamp(smoothedVolume, 0, 1);
  const speakAmount = speaking * (0.101 + volume * 0.272);
  const breathe = Math.sin(time * 0.95);
  const sway = Math.sin(time * 0.272 + 0.4);
  const micro = Math.sin(time * 1.0 + 0.8);
  const talkPulse = Math.sin(time * (1.92 + volume * 1.02));
  const talkLift = Math.max(0, talkPulse);

  const spineX = 0.0047 + breathe * 0.0031 + speakAmount * (0.0022 + talkLift * 0.003);
  const spineY = sway * 0.0046 + speakAmount * 0.00235;
  const spineZ = sway * 0.0018;
  applyGestureRotation('spine', spineX, spineY, spineZ);

  const chestX = 0.0074 + breathe * 0.0051 + speakAmount * (0.0032 + talkLift * 0.0043);
  const chestY = sway * 0.0063 + speakAmount * talkPulse * 0.0039;
  const chestZ = micro * 0.00265 + speakAmount * 0.00375;
  applyGestureRotation('chest', chestX, chestY, chestZ);

  const neckX = breathe * 0.002 + speakAmount * talkPulse * 0.0035;
  const neckY = sway * 0.0059 + micro * 0.0024 + speakAmount * 0.0045;
  const neckZ = Math.sin(time * 0.5 + 1.1) * 0.0029 + speakAmount * 0.003;

  updateHeadAccents(dt);
  if (lipsyncActive && time >= headAccentState.nextPulseAt) {
    const speechImpulse = HEAD_ACCENT_SETTINGS.speechPulseMin +
      Math.random() * (HEAD_ACCENT_SETTINGS.speechPulseMax - HEAD_ACCENT_SETTINGS.speechPulseMin);
    triggerHeadAccent(speechImpulse);
    scheduleSpeechHeadAccent();
  }

  const neckAccentPitch = headAccentState.pitch * HEAD_ACCENT_SETTINGS.neckPitchScale;
  const neckAccentYaw = headAccentState.yaw * HEAD_ACCENT_SETTINGS.neckYawScale;
  applyGestureRotation(
    'neck',
    neckX + neckAccentPitch,
    neckY + neckAccentYaw,
    neckZ + headAccentState.roll * 0.0004
  );

  const headX = breathe * 0.0029 + speakAmount * (talkPulse * 0.0061 + talkLift * 0.002);
  const headY = sway * 0.0069 + micro * 0.0028 + speakAmount * 0.0048;
  const headZ = Math.sin(time * 0.55 + 2.0) * 0.0039 + speakAmount * 0.0037;
  const headAccentPitch = headAccentState.pitch * HEAD_ACCENT_SETTINGS.headPitchScale;
  const headAccentYaw = headAccentState.yaw * HEAD_ACCENT_SETTINGS.headYawScale;
  const headAccentRoll = headAccentState.roll * HEAD_ACCENT_SETTINGS.headRollScale;
  applyGestureRotation('head', headX + headAccentPitch, headY + headAccentYaw, headZ + headAccentRoll);

  const forearmDrift = Math.sin(time * 0.63 + 2.1) * 0.0034;
  const handDrift = Math.sin(time * 0.82 + 0.2) * 0.0039;
  const handSpeak = speakAmount * 0.0034;

  applyGestureRotation('leftUpperArm', breathe * 0.00095, 0, 0);
  applyGestureRotation('rightUpperArm', breathe * 0.00095, 0, 0);

  applyGestureRotation('leftLowerArm', forearmDrift * 0.12, -forearmDrift * 0.12, handDrift * 0.03);
  applyGestureRotation('rightLowerArm', forearmDrift * 0.12, forearmDrift * 0.12, -handDrift * 0.03);

  applyGestureRotation('leftHand', handDrift * 0.06, -handDrift * 0.072 - handSpeak, Math.sin(time * 0.9 + 0.4) * 0.0028);
  applyGestureRotation('rightHand', handDrift * 0.06, handDrift * 0.072 + handSpeak, -Math.sin(time * 0.9 + 0.4) * 0.0028);
}

loader.load(
  '/assets/models/valentina.vrm',
  (gltf) => {
    vrm = gltf.userData.vrm;
    try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch (e) {}
    try { VRMUtils.combineSkeletons && VRMUtils.combineSkeletons(gltf.scene); } catch (e) {}
    scene.add(vrm.scene);

    // Face the camera
    vrm.scene.rotation.y = Math.PI;
    vrm.scene.position.y = 0;

    // Relaxed default pose — arms down from T-pose
    try {
      const humanoid = vrm.humanoid;
      if (humanoid) {
        const lUpper = humanoid.getNormalizedBoneNode('leftUpperArm');
        const rUpper = humanoid.getNormalizedBoneNode('rightUpperArm');
        const lLower = humanoid.getNormalizedBoneNode('leftLowerArm');
        const rLower = humanoid.getNormalizedBoneNode('rightLowerArm');
        // In VRM normalized space, T-pose arms point along ±X. Rotate around Z to bring them down.
        if (lUpper) lUpper.rotation.z = -1.25;  // ~-72°
        if (rUpper) rUpper.rotation.z = 1.25;
        // Slight elbow bend for natural rest
        if (lLower) lLower.rotation.y = -0.2;
        if (rLower) rLower.rotation.y = 0.2;
      }
    } catch (e) { console.warn('Pose adjust failed:', e); }

    cacheGestureRig();

    // Eye glow via additive sprites parented to VRM bones.
    // VRM humanoid exposes leftEye/rightEye bones (optional). Fall back to head offsets.
    const humanoid = vrm.humanoid;
    const leftEyeBone = humanoid?.getNormalizedBoneNode('leftEye');
    const rightEyeBone = humanoid?.getNormalizedBoneNode('rightEye');
    const headBone = humanoid?.getNormalizedBoneNode('head');

    // Build a radial gradient texture for the glow sprite
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.2, 'rgba(200,240,255,0.9)');
    grad.addColorStop(0.5, 'rgba(100,200,255,0.4)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const glowTex = new THREE.CanvasTexture(canvas);
    glowTex.colorSpace = THREE.SRGBColorSpace;

    function makeGlowSprite() {
      const mat = new THREE.SpriteMaterial({
        map: glowTex,
        color: 0x9b5cff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,   // always render on top (eyes glow through face)
        depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      s.scale.set(0.05, 0.05, 0.05);
      s.renderOrder = 999;   // draw after the VRM
      return s;
    }

    if (headBone) {
      // Attach to head bone — most reliable. VRoid VRMs: eyes are at roughly
      // y=+0.055, z=+0.08 relative to head bone origin, x ±0.032.
      const lSprite = makeGlowSprite();
      const rSprite = makeGlowSprite();
      lSprite.position.set(0.038, 0.062, 0.085);
      rSprite.position.set(-0.038, 0.062, 0.085);
      headBone.add(lSprite);
      headBone.add(rSprite);
      eyeGlowSprites.push(lSprite, rSprite);
      console.log('Eye glow: attached to head bone');
    } else {
      console.warn('Eye glow: no head bone found');
    }

    scheduleNextMicroSaccade();

    loadingEl.style.display = 'none';
    console.log('VRM loaded:', vrm);
  },
  (xhr) => {
    const pct = xhr.total ? Math.round((xhr.loaded / xhr.total) * 100) : 0;
    loadingEl.textContent = `⧗ CHARGEMENT ${pct}% ⧗`;
  },
  (err) => {
    console.error('VRM load error:', err);
    loadingEl.textContent = '⚠ ERREUR DE CHARGEMENT';
  }
);

// ────────────────────────────────────────────────────────────────
// Lipsync — phoneme timeline driven (replaces FFT analyser)
// ────────────────────────────────────────────────────────────────
let audioCtx = null;
let currentSource = null;
let lipsyncActive = false;
let smoothedVolume = 0;  // kept for backward compat (eye glow, rim light)

// Timeline state
let visemeTimeline = [];       // array of {t, v, w, j}
let timelineStartTime = 0;     // audioCtx.currentTime when audio begins
let timelineIndex = 0;         // next event to process
// Current target blendshape weights (will be lerped toward)
const visemeTargets = { Aa: 0, Ih: 0, Ee: 0, Ou: 0, Oh: 0 };
const visemeCurrent = { Aa: 0, Ih: 0, Ee: 0, Ou: 0, Oh: 0 };
let jawTarget = 0;
let jawCurrent = 0;

const BLINK_SETTINGS = {
  intervalMin: 3.1,
  intervalMax: 7.2,
  speechIntervalMin: 0.75,
  speechIntervalMax: 2.2,
  speechWindow: 1.3,
  speechDoubleChance: 0.08,
  doubleBlinkChance: 0.035,
  closeDuration: 0.082,
  holdDuration: 0.026,
  openDuration: 0.095,
  interBlinkGap: 0.09,
};

const FACIAL_EXPRESSION_SETTINGS = {
  relaxedBase: 0.045,
  relaxedWobble: 0.01,
  relaxedWobbleSpeed: 0.21,
  relaxedSmoothing: 6.2,
  speakingRelaxDip: 0.012,
  speakingSupportMax: 0.028,
  speakingSupportLerp: 6.0,
  speakingPulseSpeed: 1.85,
  speakingPulseDepth: 0.008,
  blinkAsymmetryAmount: 0.04,
  blinkAsymmetrySpeed: 0.35,
};

const subtleFacialState = {
  relaxed: 0,
  speaking: 0,
  asymPhase: Math.random() * Math.PI * 2,
};

const FACIAL_EXPRESSION_KEYS = {
  relaxed: [VRMExpressionPresetName.Relaxed, 'relaxed', 'Relaxed'],
  speaking: [VRMExpressionPresetName.Fun, 'fun', 'Fun'],
  blinkLeft: [VRMExpressionPresetName.BlinkLeft, 'blinkLeft', 'BlinkLeft'],
  blinkRight: [VRMExpressionPresetName.BlinkRight, 'blinkRight', 'BlinkRight'],
};

const facialExpressionKeyCache = {
  relaxed: null,
  speaking: null,
  blinkLeft: null,
  blinkRight: null,
};

function setSafeExpression(expr, kind, rawValue) {
  const candidates = FACIAL_EXPRESSION_KEYS[kind];
  if (!expr || !candidates) return;
  const value = THREE.MathUtils.clamp(rawValue, 0, 1);
  const cached = facialExpressionKeyCache[kind];
  if (cached === false) return;

  const trySet = (name) => {
    expr.setValue(name, value);
    return true;
  };

  if (cached) {
    try {
      if (trySet(cached)) return;
    } catch (_error) {
      facialExpressionKeyCache[kind] = false;
    }
  }

  for (const name of candidates) {
    if (!name) continue;
    try {
      if (trySet(name)) {
        facialExpressionKeyCache[kind] = name;
        return;
      }
    } catch (_error) {}
  }
  facialExpressionKeyCache[kind] = false;
}

function updateBlinkAsymmetry(expr, blinkAmount) {
  // Disabled for this VRM: BlinkLeft/BlinkRight drive the eyelids far too low
  // and create a "lashes on the cheeks" artifact. Keep them neutral.
  setSafeExpression(expr, 'blinkLeft', 0);
  setSafeExpression(expr, 'blinkRight', 0);
}

function blinkRandomInterval(isSpeechContext = false) {
  const min = isSpeechContext ? BLINK_SETTINGS.speechIntervalMin : BLINK_SETTINGS.intervalMin;
  const max = isSpeechContext ? BLINK_SETTINGS.speechIntervalMax : BLINK_SETTINGS.intervalMax;
  const skew = (Math.random() + Math.random() + Math.random()) / 3; // soft triangular center
  return min + (max - min) * skew;
}

const blinkState = {
  timer: 0,
  nextAt: blinkRandomInterval(),
  phase: 'idle', // idle | close | hold | open | gap
  phaseTime: 0,
  phaseDuration: 0,
  blinksLeft: 0,
  forceDoubleBlink: false,
};
let blinkSpeechWindowUntil = 0;
let speechEndBlinkBoost = false;
function setSmoothStep(t) {
  return t * t * (3 - 2 * t);
}

function scheduleSpeechBlinkBias() {
  blinkSpeechWindowUntil = Math.max(blinkSpeechWindowUntil, time + BLINK_SETTINGS.speechWindow);
  blinkState.nextAt = Math.min(blinkState.nextAt, blinkRandomInterval(true));
  speechEndBlinkBoost = true;
  if (Math.random() < BLINK_SETTINGS.speechDoubleChance) {
    blinkState.forceDoubleBlink = true;
  }
}

function startBlinkSequence() {
  const isInSpeechWindow = time < blinkSpeechWindowUntil;
  const shouldDouble = blinkState.forceDoubleBlink || (isInSpeechWindow && Math.random() < BLINK_SETTINGS.speechDoubleChance) || Math.random() < BLINK_SETTINGS.doubleBlinkChance;
  blinkState.forceDoubleBlink = false;
  blinkState.phase = 'close';
  blinkState.phaseTime = 0;
  blinkState.phaseDuration = BLINK_SETTINGS.closeDuration;
  blinkState.blinksLeft = shouldDouble ? 2 : 1;
}

function resetBlinkSchedule() {
  const isInSpeechWindow = time < blinkSpeechWindowUntil;
  const decayWindow = isInSpeechWindow || speechEndBlinkBoost;
  blinkState.phase = 'idle';
  blinkState.phaseTime = 0;
  blinkState.timer = 0;
  blinkState.nextAt = blinkRandomInterval(decayWindow);
  if (time >= blinkSpeechWindowUntil) {
    speechEndBlinkBoost = false;
  }
}

function updateBlink(dt, expr) {
  let blinkAmount = 0;

  if (blinkState.phase === 'idle') {
    blinkState.timer += dt;
    if (blinkState.timer >= blinkState.nextAt) {
      startBlinkSequence();
      return updateBlink(dt, expr);
    }
  } else if (blinkState.phase === 'close') {
    blinkState.phaseTime += dt;
    const t = Math.min(1, blinkState.phaseTime / blinkState.phaseDuration);
    blinkAmount = setSmoothStep(t);
    if (t >= 1) {
      blinkState.phase = 'hold';
      blinkState.phaseTime = 0;
      blinkState.phaseDuration = BLINK_SETTINGS.holdDuration;
    }
  } else if (blinkState.phase === 'hold') {
    blinkAmount = 1;
    blinkState.phaseTime += dt;
    if (blinkState.phaseTime >= blinkState.phaseDuration) {
      blinkState.phase = 'open';
      blinkState.phaseTime = 0;
      blinkState.phaseDuration = BLINK_SETTINGS.openDuration;
    }
  } else if (blinkState.phase === 'open') {
    blinkState.phaseTime += dt;
    const t = Math.min(1, blinkState.phaseTime / blinkState.phaseDuration);
    blinkAmount = 1 - setSmoothStep(t);
    if (t >= 1) {
      blinkState.blinksLeft -= 1;
      if (blinkState.blinksLeft > 0) {
        blinkState.phase = 'gap';
        blinkState.phaseTime = 0;
        blinkState.phaseDuration = BLINK_SETTINGS.interBlinkGap;
      } else {
        resetBlinkSchedule();
      }
    }
  } else if (blinkState.phase === 'gap') {
    blinkState.phaseTime += dt;
    blinkAmount = 0;
    if (blinkState.phaseTime >= blinkState.phaseDuration) {
      blinkState.phase = 'close';
      blinkState.phaseTime = 0;
      blinkState.phaseDuration = BLINK_SETTINGS.closeDuration;
    }
  }

  expr.setValue(VRMExpressionPresetName.Blink, blinkAmount);
  updateBlinkAsymmetry(expr, blinkAmount);
}

function updateSubtleExpressions(dt, expr) {
  const speaking = lipsyncActive ? 1 : 0;
  const volume = THREE.MathUtils.clamp(smoothedVolume, 0, 1);
  const relaxedTarget =
    FACIAL_EXPRESSION_SETTINGS.relaxedBase
    + Math.sin(time * FACIAL_EXPRESSION_SETTINGS.relaxedWobbleSpeed) * FACIAL_EXPRESSION_SETTINGS.relaxedWobble
    - speaking * FACIAL_EXPRESSION_SETTINGS.speakingRelaxDip;

  const relaxedBlend = 1 - Math.exp(-FACIAL_EXPRESSION_SETTINGS.relaxedSmoothing * dt);
  subtleFacialState.relaxed = THREE.MathUtils.lerp(
    subtleFacialState.relaxed,
    THREE.MathUtils.clamp(relaxedTarget, 0, 1),
    relaxedBlend
  );
  setSafeExpression(expr, 'relaxed', subtleFacialState.relaxed);

  const speakingPulse = Math.max(0, Math.sin(time * FACIAL_EXPRESSION_SETTINGS.speakingPulseSpeed));
  const speakingTarget = speaking * (
    FACIAL_EXPRESSION_SETTINGS.speakingSupportMax * (0.6 + 0.4 * volume)
    + speakingPulse * FACIAL_EXPRESSION_SETTINGS.speakingPulseDepth
  );
  const speakingBlend = 1 - Math.exp(-FACIAL_EXPRESSION_SETTINGS.speakingSupportLerp * dt);
  subtleFacialState.speaking = THREE.MathUtils.lerp(
    subtleFacialState.speaking,
    THREE.MathUtils.clamp(speakingTarget, 0, FACIAL_EXPRESSION_SETTINGS.speakingSupportMax),
    speakingBlend
  );
  setSafeExpression(expr, 'speaking', subtleFacialState.speaking);
}

const HEAD_ACCENT_SETTINGS = {
  startPulse: 0.011,
  speechPulseMin: 0.0052,
  speechPulseMax: 0.0082,
  decay: 8.8,
  nextMin: 0.8,
  nextMax: 1.9,
  headPitchScale: 0.42,
  headYawScale: 0.28,
  headRollScale: 0.16,
  neckPitchScale: 0.24,
  neckYawScale: 0.21,
};

const headAccentState = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  nextPulseAt: Number.POSITIVE_INFINITY,
};

function updateHeadAccents(dt) {
  const decay = Math.exp(-HEAD_ACCENT_SETTINGS.decay * dt);
  headAccentState.pitch *= decay;
  headAccentState.yaw *= decay;
  headAccentState.roll *= decay;
}

function triggerHeadAccent(strength = 0.004) {
  const signPitch = Math.random() < 0.5 ? -1 : 1;
  const signYaw = Math.random() < 0.5 ? -1 : 1;
  const signRoll = Math.random() < 0.5 ? -1 : 1;
  headAccentState.pitch = THREE.MathUtils.clamp(headAccentState.pitch + signPitch * strength, -0.018, 0.018);
  headAccentState.yaw = THREE.MathUtils.clamp(headAccentState.yaw + signYaw * strength * 0.7, -0.018, 0.018);
  headAccentState.roll = THREE.MathUtils.clamp(headAccentState.roll + signRoll * strength * 0.4, -0.015, 0.015);
}

function scheduleSpeechHeadAccent() {
  headAccentState.nextPulseAt = time + HEAD_ACCENT_SETTINGS.nextMin + Math.random() * (HEAD_ACCENT_SETTINGS.nextMax - HEAD_ACCENT_SETTINGS.nextMin);
}

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Map a viseme event onto the 5 mouth blendshapes.
// Consonants (PP, FF, DD, KK) close the mouth or shape it briefly.
function applyVisemeEvent(ev) {
  // Reset all first
  visemeTargets.Aa = 0;
  visemeTargets.Ih = 0;
  visemeTargets.Ee = 0;
  visemeTargets.Ou = 0;
  visemeTargets.Oh = 0;
  jawTarget = 0;

  switch (ev.v) {
    case 'Aa': visemeTargets.Aa = ev.w; break;
    case 'Ih': visemeTargets.Ih = ev.w; break;
    case 'Ee': visemeTargets.Ee = ev.w; break;
    case 'Ou': visemeTargets.Ou = ev.w; break;
    case 'Oh': visemeTargets.Oh = ev.w; break;
    case 'PP': /* lips closed */ break;  // all 0 = closed
    case 'FF': visemeTargets.Ih = ev.w * 0.3; break; // slight stretch for lip bite
    case 'DD': visemeTargets.Ih = ev.w * 0.4; break;
    case 'KK': visemeTargets.Aa = ev.w * 0.35; break;
    case 'Neutral': default: break;
  }
  jawTarget = ev.j;
}

function updateLipsync(dt) {
  if (!vrm || !vrm.expressionManager) return;
  const expr = vrm.expressionManager;

  // Advance timeline if playing
  if (lipsyncActive && visemeTimeline.length > 0 && audioCtx) {
    const now = audioCtx.currentTime - timelineStartTime;
    while (timelineIndex < visemeTimeline.length &&
           visemeTimeline[timelineIndex].t <= now) {
      applyVisemeEvent(visemeTimeline[timelineIndex]);
      timelineIndex++;
    }
    // Rough "volume" proxy for the eye glow / rim light effects
    const totalMouth = visemeTargets.Aa + visemeTargets.Ih + visemeTargets.Ee +
                       visemeTargets.Ou + visemeTargets.Oh + jawTarget;
    smoothedVolume = Math.min(1, smoothedVolume * 0.7 + totalMouth * 0.12);
  } else {
    // Decay everything back to rest
    visemeTargets.Aa = visemeTargets.Ih = visemeTargets.Ee = 0;
    visemeTargets.Ou = visemeTargets.Oh = 0;
    jawTarget = 0;
    smoothedVolume *= 0.85;
  }

  // Critically-damped lerp toward targets for smooth transitions
  // Fast attack (55), slower release via max() gives natural mouth motion
  const ATTACK = Math.min(1, dt * 28);
  const RELEASE = Math.min(1, dt * 14);
  for (const k of ['Aa', 'Ih', 'Ee', 'Ou', 'Oh']) {
    const target = visemeTargets[k];
    const cur = visemeCurrent[k];
    const alpha = target > cur ? ATTACK : RELEASE;
    visemeCurrent[k] = cur + (target - cur) * alpha;
    expr.setValue(VRMExpressionPresetName[k], visemeCurrent[k]);
  }
  // Jaw bone rotation
  jawCurrent = jawCurrent + (jawTarget - jawCurrent) * (jawTarget > jawCurrent ? ATTACK : RELEASE);
  const jawBone = vrm.humanoid?.getNormalizedBoneNode('jaw');
  if (jawBone) {
    // Rotate ~0.35rad (~20°) max around X axis
    jawBone.rotation.x = jawCurrent * 0.35;
  }

  updateBlink(dt, expr);
  updateSubtleExpressions(dt, expr);

  expr.update();
}

function onSpeechStart() {
  scheduleSpeechBlinkBias();
  triggerHeadAccent(HEAD_ACCENT_SETTINGS.startPulse);
  scheduleSpeechHeadAccent();
  seedSpeechGazeBias();
}

function onSpeechEnd() {
  scheduleSpeechBlinkBias();
  headAccentState.nextPulseAt = Number.POSITIVE_INFINITY;
  gazeState.speechYawTarget = 0;
  gazeState.speechPitchTarget = 0;
}

// ────────────────────────────────────────────────────────────────
// Animation loop
// ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let time = 0;

function animate() {
  const dt = clock.getDelta();
  time += dt;

  updateLipsync(dt);

  if (vrm) {
    vrm.update(dt);
    updateGestures(dt, time);
    updateGaze(dt);
  }
  controls.update();

  // Ring pulse
  ring.material.opacity = 0.25 + Math.sin(time * 2) * 0.1;
  ring.rotation.z = time * 0.3;

  // Particles + nebula time uniforms
  particleMat.uniforms.uTime.value = time;
  nebulaMat.uniforms.uTime.value = time;
  hologramPass.uniforms.uTime.value = time;
  fogPlaneMat.uniforms.uTime.value = time;
  dustMat.uniforms.uTime.value = time;
  beam1.mat.uniforms.uTime.value = time;
  beam2.mat.uniforms.uTime.value = time + 1.3;
  beam3.mat.uniforms.uTime.value = time + 2.7;
  // Slowly sway the beams
  beam1.mesh.rotation.z = Math.sin(time * 0.3) * 0.08;
  beam2.mesh.rotation.z = Math.sin(time * 0.3 + 1.5) * 0.08;
  beam3.mesh.rotation.x = Math.PI + Math.sin(time * 0.2) * 0.06;

  // Dynamic rim light pulse (intensifies subtly when speaking)
  const speakBoost = lipsyncActive ? smoothedVolume * 0.6 : 0;
  rimLight.intensity = 1.2 + Math.sin(time * 1.5) * 0.15 + speakBoost;
  keyLight.intensity = 0.9 + Math.sin(time * 0.8) * 0.08;
  bloomPass.strength = 0.35 + speakBoost * 0.15;

  // Eye glow — subtle "eyes lighting up" effect via additive sprites
  if (eyeGlowSprites.length > 0) {
    const idleIntensity = 0.12 + Math.sin(time * 2.0) * 0.03;
    const speakBoostEyes = lipsyncActive ? (0.45 + smoothedVolume * 0.9) : 0;
    const totalIntensity = idleIntensity + speakBoostEyes;
    // Color shift: deep violet (idle) → hot magenta (speaking)
    const blend = lipsyncActive ? Math.min(1, smoothedVolume * 2.0) : 0;
    // idle: #6B2BE0 deep violet → speaking: #FF2AD0 hot magenta
    const r = (0.42 * (1 - blend) + 1.0 * blend);
    const g = (0.17 * (1 - blend) + 0.16 * blend);
    const b = (0.88 * (1 - blend) + 0.82 * blend);
    const scale = 0.032 * (1 + totalIntensity * 0.1);
    eyeGlowSprites.forEach((sp) => {
      sp.material.color.setRGB(r * totalIntensity, g * totalIntensity, b * totalIntensity);
      sp.scale.set(scale, scale, scale);
    });
  }

  // Voice aura — expanding shockwave
  if (auraStartTime >= 0) {
    const elapsed = time - auraStartTime;
    const progress = elapsed / AURA_DURATION;
    if (progress >= 1) {
      auraMat.uniforms.uProgress.value = -1;
      auraStartTime = -1;
    } else {
      auraMat.uniforms.uProgress.value = progress;
    }
  }
  // Billboard aura toward camera
  auraMesh.quaternion.copy(camera.quaternion);

  composer.render();
  requestAnimationFrame(animate);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ────────────────────────────────────────────────────────────────
// WebSocket voice chat
// ────────────────────────────────────────────────────────────────
let ws = null;
let audioQueue = [];
let isPlaying = false;
let pendingTimeline = null;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/voice-chat`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => { console.log('WS connected'); setStatus('PRÊTE'); };
  ws.onclose = () => { console.log('WS closed'); setStatus('DÉCONNECTÉE'); setTimeout(connectWS, 2000); };
  ws.onerror = (e) => { console.error('WS error:', e); };

  ws.onmessage = async (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'text_chunk') {
          transcriptEl.textContent += msg.text;
        } else if (msg.type === 'viseme_timeline') {
          // Prime the phoneme timeline (arrives just before the audio bytes)
          pendingTimeline = msg.events || [];
          console.log(`Received viseme timeline: ${pendingTimeline.length} events`);
        } else if (msg.type === 'response_complete') {
          // Mark end of audio stream
          audioQueue.push(null); // sentinel
          if (!isPlaying) drainAudioQueue();
        } else if (msg.type === 'error') {
          console.error('Server error:', msg.text);
          setStatus('ERREUR', '');
        }
      } catch (e) { console.warn('bad json', e); }
    } else {
      // Binary: append audio chunk
      audioQueue.push(ev.data);
      if (!isPlaying) drainAudioQueue();
    }
  };
}

async function drainAudioQueue() {
  if (audioQueue.length === 0) return;
  isPlaying = true;
  setStatus('EN TRAIN DE PARLER', 'speaking');

  ensureAudioCtx();

  // Collect all binary chunks until sentinel
  const chunks = [];
  while (true) {
    if (audioQueue.length === 0) {
      await new Promise(r => setTimeout(r, 30));
      continue;
    }
    const item = audioQueue.shift();
    if (item === null) break; // end-of-stream
    chunks.push(new Uint8Array(item));
    // If we got an end sentinel OR we have enough bytes to start, try decoding
    // Simplest: wait until sentinel, then decode everything at once.
  }

  if (chunks.length === 0) {
    isPlaying = false;
    setStatus('PRÊTE');
    return;
  }

  // Concatenate
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { combined.set(c, off); off += c.length; }

  try {
    const audioBuf = await audioCtx.decodeAudioData(combined.buffer.slice(0));
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioCtx.destination);

    // Prime phoneme timeline
    visemeTimeline = pendingTimeline || [];
    pendingTimeline = null;
    timelineIndex = 0;
    timelineStartTime = audioCtx.currentTime;

    lipsyncActive = true;
    currentSource = src;
    onSpeechStart();
    triggerVoiceAura(); // single shockwave at speech start
    src.onended = () => {
      lipsyncActive = false;
      currentSource = null;
      isPlaying = false;
      visemeTimeline = [];
      timelineIndex = 0;
      onSpeechEnd();
      setStatus('PRÊTE');
      if (audioQueue.length > 0) drainAudioQueue();
    };
    src.start();
  } catch (e) {
    console.error('Audio decode failed:', e);
    isPlaying = false;
    setStatus('PRÊTE');
  }
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ensureAudioCtx(); // unlock audio on user gesture
  transcriptEl.textContent = '';
  setStatus('RÉFLÉCHIT...', 'thinking');
  ws.send(JSON.stringify({ type: 'user_message', text }));
  inputEl.value = '';
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

connectWS();
