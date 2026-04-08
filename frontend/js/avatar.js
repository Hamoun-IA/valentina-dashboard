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
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

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
// Lipsync from live audio (analyser-driven viseme)
// ────────────────────────────────────────────────────────────────
let audioCtx = null;
let analyser = null;
let currentSource = null;
let lipsyncActive = false;

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Basic viseme: use volume + low/mid/high energy ratios to drive aa/ih/ou blendshapes
const freqData = new Uint8Array(1024);
let smoothedVolume = 0;
let blinkTimer = 0;
let nextBlinkAt = 2 + Math.random() * 3;

function updateLipsync(dt) {
  if (!vrm || !vrm.expressionManager) return;
  const expr = vrm.expressionManager;

  if (lipsyncActive && analyser) {
    analyser.getByteFrequencyData(freqData);
    // Low band (vowel openness), mid band (formants), high band (consonants)
    let low = 0, mid = 0, high = 0;
    for (let i = 2; i < 20; i++) low += freqData[i];
    for (let i = 20; i < 80; i++) mid += freqData[i];
    for (let i = 80; i < 200; i++) high += freqData[i];
    low /= 18; mid /= 60; high /= 120;

    const vol = Math.max(low, mid, high) / 255;
    smoothedVolume = smoothedVolume * 0.6 + vol * 0.4;

    const openness = Math.min(1, smoothedVolume * 2.2);
    const aa = openness * (low / (low + mid + high + 1));
    const ih = openness * (mid / (low + mid + high + 1));
    const ou = openness * (high / (low + mid + high + 1));

    expr.setValue(VRMExpressionPresetName.Aa, Math.min(1, aa * 2.5));
    expr.setValue(VRMExpressionPresetName.Ih, Math.min(1, ih * 2.0));
    expr.setValue(VRMExpressionPresetName.Ou, Math.min(1, ou * 1.8));
  } else {
    // Decay mouth to closed
    smoothedVolume *= 0.85;
    expr.setValue(VRMExpressionPresetName.Aa, 0);
    expr.setValue(VRMExpressionPresetName.Ih, 0);
    expr.setValue(VRMExpressionPresetName.Ou, 0);
  }

  // Idle blink
  blinkTimer += dt;
  if (blinkTimer >= nextBlinkAt) {
    const phase = blinkTimer - nextBlinkAt;
    if (phase < 0.08) {
      expr.setValue(VRMExpressionPresetName.Blink, phase / 0.08);
    } else if (phase < 0.16) {
      expr.setValue(VRMExpressionPresetName.Blink, 1 - (phase - 0.08) / 0.08);
    } else {
      expr.setValue(VRMExpressionPresetName.Blink, 0);
      blinkTimer = 0;
      nextBlinkAt = 2 + Math.random() * 4;
    }
  }

  expr.update();
}

// ────────────────────────────────────────────────────────────────
// Animation loop
// ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let time = 0;

function animate() {
  const dt = clock.getDelta();
  time += dt;

  if (vrm) {
    vrm.update(dt);
    // Gentle breathing / idle sway
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    if (head) {
      head.rotation.x = Math.sin(time * 0.8) * 0.02;
      head.rotation.y = Math.sin(time * 0.5) * 0.04;
    }
  }

  updateLipsync(dt);
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
    src.connect(analyser);
    analyser.connect(audioCtx.destination);

    lipsyncActive = true;
    currentSource = src;
    triggerVoiceAura(); // single shockwave at speech start
    src.onended = () => {
      lipsyncActive = false;
      currentSource = null;
      isPlaying = false;
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
