/**
 * Nama: Nisrina Retnosari
 * NIM: 2401020060
 * File: engine.js
 * Kontribusi: Inisialisasi WebGL, matriks 4x4 manual, kamera orthographic, kontrol pan/zoom, dan beginFrame.
 */

'use strict';

// ============================================================
// BAGIAN 1 — KONFIGURASI KAMERA
// ============================================================

/**
 * Zoom awal.
 * Nilai 0.85 cocok dengan viewportHint di map_grafika.json dan memberi
 * tampilan awal yang cukup lebar untuk peta medieval berkoordinat besar.
 */
const DEFAULT_ZOOM = 0.85;

/** Batas zoom agar peta tidak terlalu jauh atau terlalu dekat. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4.0;

/** Kecepatan zoom per event wheel. */
const ZOOM_SPEED = 0.12;

/**
 * Warna clear background.
 * Hijau gelap dipakai sebagai dasar tanah/rumput medieval.
 */
const CLEAR_R = 0.102;
const CLEAR_G = 0.235;
const CLEAR_B = 0.118;
const CLEAR_A = 1.0;

// ============================================================
// BAGIAN 2 — MATRIKS 4×4 MANUAL
// ============================================================

/**
 * Membuat matriks identitas 4×4 dalam format column-major WebGL.
 * @returns {Float32Array}
 */
export function createIdentityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * Membuat matriks proyeksi orthographic 4×4.
 *
 * Pada engine ini, proyeksi menggunakan koordinat pixel-world:
 * left=0, right=canvasWidth/zoom, top=0, bottom=canvasHeight/zoom.
 * Dengan begitu, rumus kamera follow di animation.js:
 *
 *   targetPanX = halfW / zoom - carriage.x
 *   targetPanY = halfH / zoom - carriage.y
 *
 * akan benar-benar meletakkan kereta mendekati pusat layar.
 *
 * @param {number} left
 * @param {number} right
 * @param {number} bottom
 * @param {number} top
 * @param {number} near
 * @param {number} far
 * @returns {Float32Array}
 */
export function createOrthographicMatrix(left, right, bottom, top, near, far) {
  const rl = right - left;
  const tb = top - bottom;
  const fn = far - near;

  if (Math.abs(rl) < 1e-8 || Math.abs(tb) < 1e-8 || Math.abs(fn) < 1e-8) {
    console.warn('[engine.js] Parameter orthographic tidak valid. Mengembalikan matriks identitas.');
    return createIdentityMatrix();
  }

  return new Float32Array([
    2 / rl, 0, 0, 0,
    0, 2 / tb, 0, 0,
    0, 0, -2 / fn, 0,
    -(right + left) / rl,
    -(top + bottom) / tb,
    -(far + near) / fn,
    1,
  ]);
}

/**
 * Membuat matriks translasi 4×4.
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 * @returns {Float32Array}
 */
export function createTranslationMatrix(tx, ty, tz) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ]);
}

/**
 * Membuat matriks skala 4×4.
 * @param {number} sx
 * @param {number} sy
 * @param {number} sz
 * @returns {Float32Array}
 */
export function createScaleMatrix(sx, sy, sz) {
  return new Float32Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * Perkalian matriks 4×4: out = a × b.
 *
 * Format penyimpanan column-major:
 * index = kolom * 4 + baris.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {Float32Array}
 */
export function multiplyMatrix4(a, b) {
  const out = new Float32Array(16);

  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }

  return out;
}

// ============================================================
// BAGIAN 3 — SHADER DASAR ENGINE
// ============================================================

const VERTEX_SHADER_SOURCE = `
  attribute vec3 aPosition;

  uniform mat4 uViewProjectionMatrix;

  void main(void) {
    gl_Position = uViewProjectionMatrix * vec4(aPosition, 1.0);
  }
`;

const FRAGMENT_SHADER_SOURCE = `
  precision mediump float;

  uniform vec4 uColor;

  void main(void) {
    gl_FragColor = uColor;
  }
`;

/**
 * Kompilasi shader GLSL.
 * @param {WebGLRenderingContext} gl
 * @param {string} source
 * @param {number} type
 * @returns {WebGLShader}
 */
function compileShader(gl, source, type) {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new Error('[engine.js] Gagal membuat WebGLShader.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`[engine.js] Shader compile error:\n${info}`);
  }

  return shader;
}

/**
 * Membuat shader program.
 * @param {WebGLRenderingContext} gl
 * @param {string} vsSource
 * @param {string} fsSource
 * @returns {WebGLProgram}
 */
function createShaderProgram(gl, vsSource, fsSource) {
  const vertexShader = compileShader(gl, vsSource, gl.VERTEX_SHADER);
  const fragmentShader = compileShader(gl, fsSource, gl.FRAGMENT_SHADER);

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error('[engine.js] Gagal membuat WebGLProgram.');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`[engine.js] Program link error:\n${info}`);
  }

  return program;
}

// ============================================================
// BAGIAN 4 — CAMERA STATE DAN UPDATE MATRIX
// ============================================================

/**
 * Membuat cameraState.
 *
 * Field _last* dipakai untuk mendeteksi perubahan eksternal. Ini penting
 * karena animation.js dapat mengubah panX/panY tanpa tahu dirty flag engine.
 *
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {Object}
 */
function createCameraState(canvasWidth, canvasHeight) {
  return {
    zoom: DEFAULT_ZOOM,
    panX: 0.0,
    panY: 0.0,

    canvasWidth,
    canvasHeight,

    isDragging: false,
    lastMouseX: 0,
    lastMouseY: 0,

    isDirty: true,
    viewProjectionMatrix: createIdentityMatrix(),

    _lastPanX: NaN,
    _lastPanY: NaN,
    _lastZoom: NaN,
    _lastCanvasWidth: NaN,
    _lastCanvasHeight: NaN,
  };
}

/**
 * Tandai kamera dirty jika ada perubahan yang terjadi di luar engine.js.
 * Contoh: updateCameraFollow() dari animation.js mengubah panX/panY langsung.
 *
 * @param {Object} cameraState
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 */
function markDirtyIfCameraChanged(cameraState, canvasWidth, canvasHeight) {
  if (!cameraState) return;

  if (
    cameraState.panX !== cameraState._lastPanX ||
    cameraState.panY !== cameraState._lastPanY ||
    cameraState.zoom !== cameraState._lastZoom ||
    canvasWidth !== cameraState._lastCanvasWidth ||
    canvasHeight !== cameraState._lastCanvasHeight
  ) {
    cameraState.isDirty = true;
  }
}

/**
 * Hitung ulang viewProjectionMatrix.
 *
 * Sistem koordinat:
 * - Dunia memakai satuan pixel-like world unit.
 * - Kiri layar = x kecil.
 * - Kanan layar = x besar.
 * - Atas layar = y kecil.
 * - Bawah layar = y besar.
 *
 * VP = Orthographic × Translation.
 * Translasi dipakai untuk pan/follow camera.
 *
 * @param {WebGLRenderingContext} gl
 * @param {Object} cameraState
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 */
export function updateCameraMatrix(gl, cameraState, canvasWidth, canvasHeight) {
  void gl;

  const safeWidth = Math.max(1, canvasWidth || 1);
  const safeHeight = Math.max(1, canvasHeight || 1);
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cameraState.zoom || DEFAULT_ZOOM));

  cameraState.zoom = zoom;
  cameraState.canvasWidth = safeWidth;
  cameraState.canvasHeight = safeHeight;

  const viewW = safeWidth / zoom;
  const viewH = safeHeight / zoom;

  // top=0 dan bottom=viewH membuat Y positif mengarah ke bawah,
  // sesuai koordinat sprite/canvas yang dipakai renderer.
  const projection = createOrthographicMatrix(
    0,
    viewW,
    viewH,
    0,
    -1000,
    1000
  );

  const pan = createTranslationMatrix(cameraState.panX, cameraState.panY, 0);
  cameraState.viewProjectionMatrix = multiplyMatrix4(projection, pan);

  cameraState.isDirty = false;
  cameraState._lastPanX = cameraState.panX;
  cameraState._lastPanY = cameraState.panY;
  cameraState._lastZoom = cameraState.zoom;
  cameraState._lastCanvasWidth = safeWidth;
  cameraState._lastCanvasHeight = safeHeight;
}

// ============================================================
// BAGIAN 5 — KONTROL KAMERA
// ============================================================

/**
 * Pasang kontrol kamera:
 * - wheel: zoom in/out
 * - drag kiri: pan
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} cameraState
 */
export function setupCameraControls(canvas, cameraState) {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();

    const direction = e.deltaY > 0 ? -1 : 1;
    cameraState.zoom = Math.max(
      ZOOM_MIN,
      Math.min(ZOOM_MAX, cameraState.zoom + direction * ZOOM_SPEED)
    );

    cameraState.isDirty = true;
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;

    cameraState.isDragging = true;
    cameraState.lastMouseX = e.clientX;
    cameraState.lastMouseY = e.clientY;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!cameraState.isDragging) return;

    const dx = e.clientX - cameraState.lastMouseX;
    const dy = e.clientY - cameraState.lastMouseY;

    cameraState.lastMouseX = e.clientX;
    cameraState.lastMouseY = e.clientY;

    // Pixel screen dikonversi ke world unit berdasarkan zoom.
    // Karena projection memakai Y positif ke bawah, dy positif juga
    // menambah panY agar peta mengikuti arah drag.
    cameraState.panX += dx / cameraState.zoom;
    cameraState.panY += dy / cameraState.zoom;

    cameraState.isDirty = true;
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;

    cameraState.isDragging = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('mouseleave', () => {
    if (!cameraState.isDragging) {
      canvas.style.cursor = 'grab';
    }
  });

  canvas.style.cursor = 'grab';
}

// ============================================================
// BAGIAN 6 — INISIALISASI WEBGL
// ============================================================

/**
 * Sinkronisasi ukuran framebuffer canvas dengan ukuran CSS.
 * @param {HTMLCanvasElement} canvas
 * @param {WebGLRenderingContext} gl
 */
function resizeCanvasToDisplaySize(canvas, gl) {
  const displayWidth = Math.max(1, Math.floor(canvas.clientWidth || canvas.width || 800));
  const displayHeight = Math.max(1, Math.floor(canvas.clientHeight || canvas.height || 600));

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
}

/**
 * Inisialisasi WebGL.
 *
 * @param {string} canvasId
 * @returns {{
 *   canvas: HTMLCanvasElement,
 *   gl: WebGLRenderingContext,
 *   shaderProgram: WebGLProgram,
 *   cameraState: Object,
 *   locations: Object,
 *   resizeObserver: ResizeObserver|null
 * } | null}
 */
export function initWebGL(canvasId) {
  const canvas = document.getElementById(canvasId);

  if (!canvas) {
    console.error(`[engine.js] Canvas dengan ID "${canvasId}" tidak ditemukan.`);
    return null;
  }

  const gl = canvas.getContext('webgl', {
    antialias: false,
    depth: true,
    alpha: false,
    premultipliedAlpha: false,
  });

  if (!gl) {
    console.error('[engine.js] WebGL 1.0 tidak tersedia di browser/perangkat ini.');
    return null;
  }

  resizeCanvasToDisplaySize(canvas, gl);

  gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);

  // Depth test tidak dimatikan agar geometri solid tetap aman.
  // Renderer sprite tetap mengandalkan painter's algorithm dan alpha blending.
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let shaderProgram;
  try {
    shaderProgram = createShaderProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);
  } catch (error) {
    console.error(error);
    return null;
  }

  gl.useProgram(shaderProgram);

  const locations = {
    aPosition: gl.getAttribLocation(shaderProgram, 'aPosition'),
    uViewProjectionMatrix: gl.getUniformLocation(shaderProgram, 'uViewProjectionMatrix'),
    uColor: gl.getUniformLocation(shaderProgram, 'uColor'),
  };

  if (locations.aPosition < 0) {
    console.warn('[engine.js] Attribute aPosition tidak ditemukan.');
  }

  if (!locations.uViewProjectionMatrix) {
    console.warn('[engine.js] Uniform uViewProjectionMatrix tidak ditemukan.');
  }

  if (!locations.uColor) {
    console.warn('[engine.js] Uniform uColor tidak ditemukan.');
  }

  if (locations.uColor) {
    gl.uniform4f(locations.uColor, 1.0, 1.0, 1.0, 1.0);
  }

  const cameraState = createCameraState(canvas.width, canvas.height);
  updateCameraMatrix(gl, cameraState, canvas.width, canvas.height);

  if (locations.uViewProjectionMatrix) {
    gl.uniformMatrix4fv(
      locations.uViewProjectionMatrix,
      false,
      cameraState.viewProjectionMatrix
    );
  }

  setupCameraControls(canvas, cameraState);

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      resizeCanvasToDisplaySize(canvas, gl);
      cameraState.isDirty = true;
    });
    resizeObserver.observe(canvas);
  } else {
    window.addEventListener('resize', () => {
      resizeCanvasToDisplaySize(canvas, gl);
      cameraState.isDirty = true;
    });
  }

  console.log('[engine.js] Engine siap.');
  console.log(`[engine.js] Canvas: ${canvas.width}×${canvas.height}`);
  console.log(`[engine.js] Zoom awal: ${cameraState.zoom}`);

  return {
    canvas,
    gl,
    shaderProgram,
    cameraState,
    locations,
    resizeObserver,
  };
}

// ============================================================
// BAGIAN 7 — AWAL FRAME
// ============================================================


export function beginFrame(gl, cameraState, locations, canvasWidth, canvasHeight) {
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  if (!cameraState) return;

  markDirtyIfCameraChanged(cameraState, canvasWidth, canvasHeight);

  if (cameraState.isDirty) {
    updateCameraMatrix(gl, cameraState, canvasWidth, canvasHeight);

    // Renderer memakai shader sendiri dan membaca cameraState.viewProjectionMatrix langsung.
    // Tidak perlu upload uniform shader dasar di sini karena program aktif bisa milik renderer.
  }
}


export function setColor(gl, locations, r, g, b, a = 1.0) {
  if (!locations?.uColor) return;
  gl.uniform4f(locations.uColor, r, g, b, a);
}
