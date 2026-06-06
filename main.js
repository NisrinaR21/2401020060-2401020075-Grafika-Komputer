/**
 * Nama: Dhiya Zarifa Putri Marzuki
 * NIM: 2401020075
 * File: main.js
 * Kontribusi: Entry point aplikasi, pemuatan asset, integrasi modul, render loop, kontrol UI, dan pergantian map.
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
  drawLightingOverlay,
} from './renderer.js';

import {
  createAnimationState,
  updateAnimations,
  toggleTrack,
  pauseTrack,
  randomizeCarriagePosition,
  randomizeTargetPosition,
  updateCameraFollow,
  breakCameraFollow,
  enableCameraFollow,
  getDynamicRouteMarkerObjects,
  validateRoadGraph,
} from './animation.js';

// ============================================================
// BAGIAN 2 — KONFIGURASI UTAMA
// ============================================================

const CANVAS_ID = 'glCanvas';
const SPRITESHEET_URL = './spritesheet.png';

const MAP_VARIANT_URLS = [
  './map_variant1.json',
  './map_variant2.json',
  './map_variant3.json',
  './map_variant4.json',
];

const UI_IDS = {
  startPause: 'btnStartPause',
  randomizeMap: 'btnRandomizeMap',
  randomizePosition: 'btnRandomizePosition',
  randomizeTarget: 'btnRandomizeTarget',
  followCamera: 'btnFollowCamera',
  variantLabel: 'variantLabel',
  worldTimeLabel: 'worldTimeLabel',
  routeStatusLabel: 'routeStatusLabel',
};

const MAX_DELTA_TIME = 0.10;
const DEFAULT_WORLD_PADDING = 220;

// ============================================================
// BAGIAN 3 — STATE GLOBAL APLIKASI
// ============================================================

const appState = {
  initialized: false,
  assetsReady: false,
  isSwitchingMap: false,
  lastFrameTime: 0,
  animationFrameId: 0,
  currentVariantIndex: 0,
  mapCache: new Map(),
};

let canvas = null;
let gl = null;
let locations = null;
let cameraState = null;

let spritesheetImage = null;
let currentMapData = null;
let simulationState = null;

const rendererState = {
  texture: null,
  roads: null,
  sprites: null,
  atlasData: {},
  atlasSize: 2048,
  simulationTime: 0,
  dayNightProgress: 0,
};

// ============================================================
// BAGIAN 4 — ASSET LOADING
// ============================================================

async function loadJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`[main.js] Gagal memuat JSON: ${url} (${response.status} ${response.statusText})`);
  }

  return response.json();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`[main.js] Gagal memuat gambar: ${url}`));

    image.src = url;
  });
}

async function loadMapVariant(index) {
  const normalizedIndex = ((index % MAP_VARIANT_URLS.length) + MAP_VARIANT_URLS.length) % MAP_VARIANT_URLS.length;
  const url = MAP_VARIANT_URLS[normalizedIndex];

  return loadJSON(url);
}

function getRoadGraphSignature(mapData) {
  const nodes = mapData?.roadGraph?.nodes || [];
  const edges = mapData?.roadGraph?.edges || [];
  return `${nodes.length}N-${edges.length}E-${nodes.slice(0, 4).map((n) => `${Math.round(n.x)},${Math.round(n.y)}`).join('|')}`;
}

// ============================================================
// BAGIAN 5 — MAP / SPRITE DATA UTILITIES
// ============================================================

function getStaticObjects(mapData) {
  const rawObjects = Array.isArray(mapData?.objek_statis)
    ? mapData.objek_statis
    : Array.isArray(mapData?.objects)
      ? mapData.objects
      : Array.isArray(mapData?.buildings)
        ? mapData.buildings
        : Array.isArray(mapData?.sprites)
          ? mapData.sprites
          : [];

  // Bendera lama tidak boleh menjadi statis permanen karena sekarang marker route dinamis.
  return rawObjects.filter((obj) => !isStaticRouteMarker(obj));
}

function isStaticRouteMarker(obj) {
  const id = String(obj?.id || '').toLowerCase();
  const type = String(obj?.type || obj?.tipe || obj?.sprite || obj?.atlasKey || '').toLowerCase();

  return (
    type === 'start_flag' ||
    type === 'target_flag' ||
    type === 'finish_flag' ||
    id.includes('start_flag') ||
    id.includes('target_flag') ||
    id.includes('finish_flag')
  );
}

function getRenderableSpriteObjects() {
  if (!currentMapData) return [];

  const staticObjects = getStaticObjects(currentMapData);
  const dynamicMarkers = getDynamicRouteMarkerObjects(simulationState);

  return staticObjects.concat(dynamicMarkers);
}

function syncSpriteObjects() {
  if (!rendererState.sprites) return;
  rendererState.sprites.objects = getRenderableSpriteObjects();
}

function computeWorldBounds(mapData) {
  if (mapData?.worldBounds) {
    return {
      minX: Number.isFinite(mapData.worldBounds.minX) ? mapData.worldBounds.minX : -1600,
      maxX: Number.isFinite(mapData.worldBounds.maxX) ? mapData.worldBounds.maxX : 1600,
      minY: Number.isFinite(mapData.worldBounds.minY) ? mapData.worldBounds.minY : -900,
      maxY: Number.isFinite(mapData.worldBounds.maxY) ? mapData.worldBounds.maxY : 900,
      padding: Number.isFinite(mapData.worldBounds.padding) ? mapData.worldBounds.padding : DEFAULT_WORLD_PADDING,
    };
  }

  const points = [];

  for (const node of mapData?.roadGraph?.nodes || []) {
    if (Number.isFinite(node.x) && Number.isFinite(node.y)) points.push({ x: node.x, y: node.y });
  }

  for (const obj of getStaticObjects(mapData)) {
    if (Number.isFinite(obj.x) && Number.isFinite(obj.y)) points.push({ x: obj.x, y: obj.y });
  }

  if (points.length === 0) {
    return { minX: -1600, maxX: 1600, minY: -900, maxY: 900, padding: DEFAULT_WORLD_PADDING };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, maxX, minY, maxY, padding: DEFAULT_WORLD_PADDING };
}

function resetCameraFromMapHint(mapData) {
  if (!cameraState) return;

  const hint = mapData?.metadata?.camera?.viewportHint || {};

  cameraState.panX = Number.isFinite(hint.x) ? hint.x : 0;
  cameraState.panY = Number.isFinite(hint.y) ? hint.y : 0;
  cameraState.zoom = Number.isFinite(hint.zoom) ? hint.zoom : 0.85;
  cameraState.isDirty = true;
}

// ============================================================
// BAGIAN 6 — MAP SETUP DAN RESOURCE UPDATE
// ============================================================

async function setupMapVariant(index, options = {}) {
  if (appState.isSwitchingMap) return false;

  appState.isSwitchingMap = true;
  setControlsEnabled(false);
  setText(UI_IDS.routeStatusLabel, 'Memuat map...');

  try {
    const mapData = await loadMapVariant(index);
    const validation = validateRoadGraph(mapData);

    if (!validation.isStrictlyValid) {
      console.warn('[main.js] roadGraph map variant belum strict valid. Map tetap dimuat, tetapi map_variant final harus diperbaiki.', validation);
    }

    disposeMapRendererResources();

    currentMapData = mapData;
    appState.currentVariantIndex = index;

    rendererState.atlasData = currentMapData.atlasData || {};
    rendererState.atlasSize = currentMapData.atlasSize || 2048;
    rendererState.roads = setupRoadGeometry(gl, locations, currentMapData);

    simulationState = createAnimationState(currentMapData);
    rendererState.sprites = setupSpriteGeometry(gl, locations, getRenderableSpriteObjects());

    if (options.resetCamera !== false) {
      resetCameraFromMapHint(currentMapData);
    }

    syncSpriteObjects();
    updateUI();

    console.log(`[main.js] Map variant ${getVariantLabel()} siap. RoadGraph: ${getRoadGraphSignature(currentMapData)}`, validation);
    return true;
  } catch (error) {
    console.error(error);
    setText(UI_IDS.routeStatusLabel, 'Gagal memuat map');
    return false;
  } finally {
    appState.isSwitchingMap = false;
    setControlsEnabled(true);
    syncStartPauseButton();
  }
}

function disposeMapRendererResources() {
  if (!gl) return;

  const roadRenderer = rendererState.roads?.rendererInstance;
  if (roadRenderer) {
    if (roadRenderer.vbo) gl.deleteBuffer(roadRenderer.vbo);
    if (roadRenderer.program) gl.deleteProgram(roadRenderer.program);
  }

  const spriteRenderer = rendererState.sprites?.rendererInstance;
  if (spriteRenderer) {
    if (spriteRenderer.vbo) gl.deleteBuffer(spriteRenderer.vbo);
    if (spriteRenderer.program) gl.deleteProgram(spriteRenderer.program);
  }

  rendererState.roads = null;
  rendererState.sprites = null;
}

function pickRandomMapIndex() {
  if (MAP_VARIANT_URLS.length <= 1) return 0;

  let nextIndex = appState.currentVariantIndex;
  let guard = 0;

  while (nextIndex === appState.currentVariantIndex && guard < 12) {
    nextIndex = Math.floor(Math.random() * MAP_VARIANT_URLS.length);
    guard += 1;
  }

  return nextIndex;
}

// ============================================================
// BAGIAN 7 — UI EVENTS
// ============================================================

function setupUIEvents() {
  const btnStartPause = document.getElementById(UI_IDS.startPause);
  const btnRandomizeMap = document.getElementById(UI_IDS.randomizeMap);
  const btnRandomizePosition = document.getElementById(UI_IDS.randomizePosition);
  const btnRandomizeTarget = document.getElementById(UI_IDS.randomizeTarget);
  const btnFollowCamera = document.getElementById(UI_IDS.followCamera);

  if (btnStartPause) {
    btnStartPause.addEventListener('click', () => {
      if (!simulationState) return;
      toggleTrack(simulationState);
      syncSpriteObjects();
      updateUI();
    });
  }

  if (btnRandomizeMap) {
    btnRandomizeMap.addEventListener('click', async () => {
      if (appState.isSwitchingMap) return;
      pauseTrack(simulationState);
      await setupMapVariant(pickRandomMapIndex(), { resetCamera: true });
    });
  }

  if (btnRandomizePosition) {
    btnRandomizePosition.addEventListener('click', () => {
      if (!simulationState) return;
      randomizeCarriagePosition(simulationState);
      syncSpriteObjects();
      updateUI();
    });
  }

  if (btnRandomizeTarget) {
    btnRandomizeTarget.addEventListener('click', () => {
      if (!simulationState) return;
      randomizeTargetPosition(simulationState);
      syncSpriteObjects();
      updateUI();
    });
  }

  if (btnFollowCamera) {
    btnFollowCamera.addEventListener('click', () => {
      if (!simulationState) return;
      enableCameraFollow(simulationState);
      updateUI();
    });
  }
}

function setupManualCameraOverrideListeners() {
  if (!canvas) return;

  canvas.addEventListener('pointerdown', () => {
    breakCameraFollow(simulationState);
    updateUI();
  });

  canvas.addEventListener('wheel', () => {
    breakCameraFollow(simulationState);
    updateUI();
  }, { passive: true });
}

function setControlsEnabled(enabled) {
  for (const id of [
    UI_IDS.startPause,
    UI_IDS.randomizeMap,
    UI_IDS.randomizePosition,
    UI_IDS.randomizeTarget,
    UI_IDS.followCamera,
  ]) {
    const element = document.getElementById(id);
    if (element) element.disabled = !enabled;
  }
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function getVariantLabel() {
  const id = currentMapData?.metadata?.variantId;
  return id ? `Variant ${id}` : `Variant ${appState.currentVariantIndex + 1}`;
}

function updateUI() {
  if (!simulationState || !currentMapData) return;

  setText(UI_IDS.variantLabel, getVariantLabel());

  const dayNight = simulationState.dayNight;
  if (dayNight) {
    setText(UI_IDS.worldTimeLabel, `${dayNight.label} — ${dayNight.timestamp}`);
  }

  const stats = simulationState.pathfindingStats || {};
  const routeText = stats.lastStatus || (simulationState.isRunning ? 'Berjalan' : 'Siaga');
  setText(UI_IDS.routeStatusLabel, routeText);

  syncStartPauseButton();
  syncFollowButton();
}

function syncStartPauseButton() {
  const button = document.getElementById(UI_IDS.startPause);
  if (!button) return;

  button.textContent = simulationState?.isRunning ? 'Pause' : 'Start';
}

function syncFollowButton() {
  const button = document.getElementById(UI_IDS.followCamera);
  if (!button || !simulationState?.cameraFollow) return;

  button.textContent = simulationState.cameraFollow.enabled ? 'Follow Aktif' : 'Follow Kamera';
}

// ============================================================
// BAGIAN 8 — DAY / NIGHT CLEAR COLOR
// ============================================================

function applyDayNightClearColor() {

  gl.clearColor(0.070, 0.205, 0.090, 1.0);
}

function mixColor(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
    a[3] + (b[3] - a[3]) * k,
  ];
}

// ============================================================
// BAGIAN 9 — CAMERA BOUNDS
// ============================================================

function clampCameraToWorldBounds() {
  if (!cameraState || !currentMapData) return;

  const bounds = computeWorldBounds(currentMapData);
  const padding = bounds.padding || DEFAULT_WORLD_PADDING;

  const minX = bounds.minX - padding;
  const maxX = bounds.maxX + padding;
  const minY = bounds.minY - padding;
  const maxY = bounds.maxY + padding;

  const zoom = Math.max(0.01, Number(cameraState.zoom) || 1);
  const viewW = (canvas?.width || cameraState.canvasWidth || 1) / zoom;
  const viewH = (canvas?.height || cameraState.canvasHeight || 1) / zoom;

  const worldW = maxX - minX;
  const worldH = maxY - minY;

  let targetPanX = cameraState.panX;
  let targetPanY = cameraState.panY;

  if (viewW >= worldW) {
    const centerX = (minX + maxX) * 0.5;
    targetPanX = viewW * 0.5 - centerX;
  } else {
    const minPanX = viewW - maxX;
    const maxPanX = -minX;
    targetPanX = clamp(targetPanX, minPanX, maxPanX);
  }

  if (viewH >= worldH) {
    const centerY = (minY + maxY) * 0.5;
    targetPanY = viewH * 0.5 - centerY;
  } else {
    const minPanY = viewH - maxY;
    const maxPanY = -minY;
    targetPanY = clamp(targetPanY, minPanY, maxPanY);
  }

  if (targetPanX !== cameraState.panX || targetPanY !== cameraState.panY) {
    cameraState.panX = targetPanX;
    cameraState.panY = targetPanY;
    cameraState.isDirty = true;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ============================================================
// BAGIAN 10 — GAME LOOP
// ============================================================

function runFrame(timestampMs) {
  appState.animationFrameId = requestAnimationFrame(runFrame);

  if (!appState.assetsReady || !gl || !canvas || !cameraState || !simulationState) return;

  const now = timestampMs * 0.001;
  const deltaTime = appState.lastFrameTime > 0
    ? Math.min(MAX_DELTA_TIME, now - appState.lastFrameTime)
    : 0;

  appState.lastFrameTime = now;

  updateAnimations(simulationState, deltaTime);
  updateCameraFollow(simulationState, cameraState, deltaTime);
  clampCameraToWorldBounds();

  rendererState.simulationTime = simulationState.time || 0;
  rendererState.dayNightProgress = simulationState.dayNight?.progress || 0;

  syncSpriteObjects();
  applyDayNightClearColor(rendererState.dayNightProgress);

  beginFrame(gl, cameraState, locations, canvas.width, canvas.height);

  drawRoads(gl, locations, rendererState, cameraState);
  drawSprites(gl, locations, rendererState, simulationState, cameraState);
  drawLightingOverlay(gl, locations, rendererState);

  updateUI();
}

// ============================================================
// BAGIAN 11 — BOOTSTRAP
// ============================================================

async function bootstrap() {
  try {
    setControlsEnabled(false);
    setText(UI_IDS.routeStatusLabel, 'Memulai WebGL...');

    const engine = initWebGL(CANVAS_ID);
    if (!engine) throw new Error('[main.js] initWebGL gagal.');

    canvas = engine.canvas;
    gl = engine.gl;
    locations = engine.locations;
    cameraState = engine.cameraState;

    setupUIEvents();
    setupManualCameraOverrideListeners();

    setText(UI_IDS.routeStatusLabel, 'Memuat spritesheet...');
    spritesheetImage = await loadImage(SPRITESHEET_URL);
    rendererState.texture = setupTexture(gl, locations, spritesheetImage);

    setText(UI_IDS.routeStatusLabel, 'Memuat map...');
    const ok = await setupMapVariant(0, { resetCamera: true });
    if (!ok) throw new Error('[main.js] Map awal gagal dimuat.');

    appState.assetsReady = true;
    appState.initialized = true;
    setControlsEnabled(true);
    updateUI();

    appState.animationFrameId = requestAnimationFrame(runFrame);
    console.log('[main.js] Aplikasi siap.');
  } catch (error) {
    console.error(error);
    setControlsEnabled(true);
    setText(UI_IDS.routeStatusLabel, 'Error saat inisialisasi');
  }
}

window.addEventListener('DOMContentLoaded', bootstrap);

window.addEventListener('beforeunload', () => {
  if (appState.animationFrameId) cancelAnimationFrame(appState.animationFrameId);
  disposeMapRendererResources();
});
