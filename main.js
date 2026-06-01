/**
 * ============================================================
 * main.js
 * Medieval Spatial Mapping — WebGL 1.0 Pure / ES6 Modules
 * Entry Point, Asset Loader, Game Loop, dan UI Controller
 * ============================================================
 *
 * File ini menghubungkan engine.js, renderer.js, animation.js,
 * map_grafika.json, dan spritesheet.png.
 *
 * Kontrak modul:
 * - engine.js     : initWebGL(), beginFrame()
 * - renderer.js   : setupTexture(), setupRoadGeometry(), setupSpriteGeometry(), drawRoads(), drawSprites()
 * - animation.js  : createAnimationState(), updateAnimations(), start/pause/toggle, randomize, camera follow
 *
 * Catatan:
 * - Tidak menggunakan Three.js, Babylon.js, gl-matrix, atau library eksternal.
 * - Path asset disesuaikan dengan struktur repo root:
 *   ./map_grafika.json dan ./spritesheet.png
 */

'use strict';

// ============================================================
// BAGIAN 1 — IMPORT MODUL
// ============================================================

import { initWebGL, beginFrame } from './engine.js';

import {
  setupTexture,
  setupRoadGeometry,
  setupSpriteGeometry,
  drawRoads,
  drawSprites,
} from './renderer.js';

import {
  createAnimationState,
  updateAnimations,
  startTrack,
  pauseTrack,
  toggleTrack,
  randomizeCarriagePosition,
  randomizeTargetPosition,
  requestRouteToNode,
  updateCameraFollow,
  breakCameraFollow,
  enableCameraFollow,
} from './animation.js';

// ============================================================
// BAGIAN 2 — KONFIGURASI GLOBAL
// ============================================================

const CANVAS_ID = 'glCanvas';

// Struktur repo saat ini menaruh JSON dan spritesheet di root.
// Jika nanti dipindahkan ke folder assets/, cukup ubah dua konstanta ini.
const DATA_URL = './map_grafika.json';
const SPRITESHEET_URL = './spritesheet.png';

// ID tombol disesuaikan dengan HTML. Semua bersifat opsional:
// jika ID tidak ada di HTML, aplikasi tetap berjalan.
const START_PAUSE_BUTTON_ID = 'btnStartPause';
const RANDOMIZE_MAP_BUTTON_ID = 'btnRandomizeMap';
const RANDOMIZE_POSITION_BUTTON_ID = 'btnRandomizePosition';
const RANDOMIZE_TARGET_BUTTON_ID = 'btnRandomizeTarget';
const FOLLOW_CAMERA_BUTTON_ID = 'btnFollowCamera';

const MAX_DELTA_TIME = 0.1;

// ============================================================
// BAGIAN 3 — ASSET LOADING
// ============================================================

async function loadJSON(url) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`[Asset] JSON berhasil dimuat: ${url}`);
    return data;
  } catch (error) {
    console.error(`[Asset] Gagal memuat JSON "${url}".`, error);
    throw error;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      console.log(`[Asset] Gambar berhasil dimuat: ${url} (${img.width}x${img.height})`);
      resolve(img);
    };

    img.onerror = () => {
      const err = new Error(`Gagal memuat gambar: ${url}`);
      console.error(`[Asset] ${err.message}`);
      reject(err);
    };

    img.src = url;
  });
}

async function loadAssets() {
  const [mapData, spritesheet] = await Promise.all([
    loadJSON(DATA_URL),
    loadImage(SPRITESHEET_URL),
  ]);

  return { mapData, spritesheet };
}

// ============================================================
// BAGIAN 4 — STATE UTAMA APLIKASI
// ============================================================

let appState = {
  isRunning: false,
  lastFrameTime: 0,
  assetsLoaded: false,
  debug: false,
};

let rendererState = {};
let simulationState = null;
let currentMapData = null;

let gl = null;
let canvas = null;
let cameraState = null;
let locations = null;

// ============================================================
// BAGIAN 5 — UTILITAS DATA MAP
// ============================================================

function getRoadData(mapData) {
  // setupRoadGeometry versi final aman menerima mapData penuh.
  // Ini penting agar renderer bisa menggambar roadGraph.edges yang bercabang,
  // bukan hanya rute_jalan linear.
  return mapData;
}

function getBuildingData(mapData) {
  return mapData?.objek_statis ?? mapData?.buildings ?? mapData?.objects ?? [];
}

function applyInitialRouteFromMap(mapData) {
  if (!simulationState || !mapData) return;

  const startNodeId = mapData.penanda_rute?.startNodeId;
  const targetNodeId = mapData.penanda_rute?.targetNodeId;

  // createAnimationState() sudah memilih node pertama sebagai posisi awal.
  // Jika penanda_rute.startNodeId ada, sinkronkan posisi awal kereta ke node itu.
  if (startNodeId && simulationState.graph?.nodes?.has(startNodeId)) {
    const startNode = simulationState.graph.nodes.get(startNodeId);
    simulationState.currentNodeId = startNodeId;
    simulationState.carriage.x = startNode.x;
    simulationState.carriage.y = startNode.y;
  }

  // Target awal diambil dari JSON, bukan random, supaya demo lebih terkontrol.
  if (targetNodeId && simulationState.graph?.nodes?.has(targetNodeId)) {
    requestRouteToNode(simulationState, targetNodeId);
  } else {
    randomizeTargetPosition(simulationState);
  }
}

function syncStartPauseButton() {
  const btn = document.getElementById(START_PAUSE_BUTTON_ID);
  if (!btn) return;

  const running = Boolean(simulationState?.isRunning);
  btn.textContent = running ? 'Pause' : 'Start';
}

// ============================================================
// BAGIAN 6 — RENDER LOOP
// ============================================================

function renderLoop(time) {
  let deltaTime = (time - appState.lastFrameTime) / 1000;

  if (!Number.isFinite(deltaTime) || deltaTime < 0) {
    deltaTime = 0;
  }

  if (deltaTime > MAX_DELTA_TIME) {
    deltaTime = MAX_DELTA_TIME;
  }

  appState.lastFrameTime = time;

  // Update simulasi dilakukan sebelum beginFrame agar camera follow dapat
  // memperbarui cameraState sebelum matrix kamera dikirim ke shader.
  if (simulationState) {
    updateAnimations(simulationState, deltaTime);
    updateCameraFollow(simulationState, cameraState, deltaTime);
    appState.isRunning = Boolean(simulationState.isRunning);
  }

  beginFrame(gl, cameraState, locations, canvas.width, canvas.height);

  drawRoads(gl, locations, rendererState, cameraState);
  drawSprites(gl, locations, rendererState, simulationState, cameraState);

  requestAnimationFrame(renderLoop);
}

// ============================================================
// BAGIAN 7 — UI LISTENERS
// ============================================================

function setupUIListeners() {
  const btnStartPause = document.getElementById(START_PAUSE_BUTTON_ID);
  if (btnStartPause) {
    btnStartPause.addEventListener('click', () => {
      if (!simulationState) return;
      toggleTrack(simulationState);
      appState.isRunning = Boolean(simulationState.isRunning);
      syncStartPauseButton();
      console.log(`[UI] Simulasi ${simulationState.isRunning ? 'dimulai' : 'dijeda'}.`);
    });
  } else {
    console.warn(`[UI] Tombol "${START_PAUSE_BUTTON_ID}" tidak ditemukan. Fitur Start/Pause via UI dilewati.`);
  }

  const btnRandomizeMap = document.getElementById(RANDOMIZE_MAP_BUTTON_ID);
  if (btnRandomizeMap) {
    btnRandomizeMap.addEventListener('click', () => {
      // Fitur acak map prosedural penuh belum dibuat di main.js.
      // Untuk demo aman, tombol ini tidak membangun map baru secara palsu.
      // Randomisasi map sebaiknya dibuat sebagai modul terpisah agar buffer lama
      // dapat dibersihkan dan mapGraph tetap valid.
      console.warn('[UI] Acak Map belum diimplementasikan. Gunakan Acak Posisi/Tujuan untuk demo pathfinding.');
    });
  }

  const btnRandomizePosition = document.getElementById(RANDOMIZE_POSITION_BUTTON_ID);
  if (btnRandomizePosition) {
    btnRandomizePosition.addEventListener('click', () => {
      if (!simulationState) return;
      randomizeCarriagePosition(simulationState);
      startTrack(simulationState);
      appState.isRunning = true;
      syncStartPauseButton();
    });
  }

  const btnRandomizeTarget = document.getElementById(RANDOMIZE_TARGET_BUTTON_ID);
  if (btnRandomizeTarget) {
    btnRandomizeTarget.addEventListener('click', () => {
      if (!simulationState) return;
      randomizeTargetPosition(simulationState);
      startTrack(simulationState);
      appState.isRunning = true;
      syncStartPauseButton();
    });
  }

  const btnFollowCamera = document.getElementById(FOLLOW_CAMERA_BUTTON_ID);
  if (btnFollowCamera) {
    btnFollowCamera.addEventListener('click', () => {
      if (!simulationState) return;
      enableCameraFollow(simulationState);
      console.log('[UI] Auto-follow camera diaktifkan kembali.');
    });
  }

  // Break auto-follow ketika user mengambil kontrol manual.
  // Event utama engine.js tetap boleh berjalan; listener ini hanya mengubah flag animasi.
  if (canvas) {
    canvas.addEventListener('mousedown', () => {
      if (simulationState) breakCameraFollow(simulationState);
    });

    canvas.addEventListener('wheel', () => {
      if (simulationState) breakCameraFollow(simulationState);
    }, { passive: true });
  }
}

// ============================================================
// BAGIAN 8 — BOOTSTRAP APLIKASI
// ============================================================

async function runApp() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║ Medieval Spatial Mapping — WebGL 1.0 Pure       ║');
  console.log('╚══════════════════════════════════════════════════╝');

  let mapData;
  let spritesheet;

  try {
    const assets = await loadAssets();
    mapData = assets.mapData;
    spritesheet = assets.spritesheet;
    currentMapData = mapData;
    appState.assetsLoaded = true;
  } catch (error) {
    console.error('[App] FATAL: Asset gagal dimuat. Aplikasi dihentikan.', error);
    return;
  }

  let engineData;
  try {
    engineData = initWebGL(CANVAS_ID);

    if (!engineData || !engineData.gl || !engineData.canvas) {
      throw new Error('initWebGL() harus mengembalikan minimal { gl, canvas, cameraState, locations }.');
    }
  } catch (error) {
    console.error('[App] FATAL: Gagal inisialisasi WebGL.', error);
    return;
  }

  gl = engineData.gl;
  canvas = engineData.canvas;
  cameraState = engineData.cameraState;
  locations = engineData.locations;

  if (!cameraState) {
    console.warn('[App] cameraState tidak tersedia dari engine.js. Renderer membutuhkan viewProjectionMatrix.');
  }

  let textureResult;
  let roadGeometryResult;
  let spriteGeometryResult;

  try {
    textureResult = setupTexture(gl, locations, spritesheet);

    // Road renderer menerima mapData penuh agar dapat memakai roadGraph.edges.
    roadGeometryResult = setupRoadGeometry(gl, locations, getRoadData(mapData));

    // Sprite renderer hanya butuh objek statis.
    spriteGeometryResult = setupSpriteGeometry(gl, locations, getBuildingData(mapData));
  } catch (error) {
    console.error('[App] FATAL: Gagal setup renderer.', error);
    return;
  }

  rendererState = {
    texture: textureResult,
    roads: roadGeometryResult,
    sprites: spriteGeometryResult,
    atlasData: mapData.atlasData ?? {},
    atlasSize: mapData.atlasSize ?? spritesheet.width ?? 2048,
  };

  try {
    simulationState = createAnimationState(mapData);

    // Salin data atlas ke simulationState agar drawSprites bisa membacanya.
    simulationState.atlasData = mapData.atlasData ?? {};
    simulationState.atlasSize = mapData.atlasSize ?? spritesheet.width ?? 2048;

    applyInitialRouteFromMap(mapData);
    startTrack(simulationState);
    appState.isRunning = true;
  } catch (error) {
    console.error('[App] FATAL: Gagal inisialisasi animation.js.', error);
    return;
  }

  setupUIListeners();
  syncStartPauseButton();

  appState.lastFrameTime = performance.now();

  if (appState.debug) {
    console.log('[Debug] currentMapData:', currentMapData);
    console.log('[Debug] rendererState:', rendererState);
    console.log('[Debug] simulationState:', simulationState);
    console.log('[Debug] cameraState:', cameraState);
  }

  console.log('[App] Inisialisasi selesai. Render loop dimulai.');
  requestAnimationFrame(renderLoop);
}

// ============================================================
// BAGIAN 9 — ENTRY POINT
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  runApp().catch((error) => {
    console.error('[App] FATAL: Error tidak tertangkap saat runApp().', error);
  });
});
