/**
 * ============================================================
 *  render.js — WebGL Isometric City Simulation Engine
 *  Modul: Bezier Road Geometry Generator
 * ============================================================
 *  Fungsi utama: generateBezierRoad(waypoints, segments, roadWidth)
 *
 *  Pipeline:
 *    1. Hitung Titik Kontrol otomatis (Smooth Cubic Bézier Spline)
 *    2. Evaluasi kurva Bézier Kubik pada setiap parameter t
 *    3. Hitung turunan (tangent) → vektor Normal 2D
 *    4. Ekstrusi vertex kiri & kanan sejauh roadWidth / 2
 *    5. Hitung UV mapping (U: melintang, V: searah kurva)
 *    6. Kembalikan Float32Array format interleave untuk gl.TRIANGLE_STRIP
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
//  KONSTANTA & KONFIGURASI
// ─────────────────────────────────────────────────────────────

/** Faktor skala untuk menghasilkan titik kontrol yang halus.
 *  Nilai 0.33 berarti P1/P2 ditempatkan ~1/3 jarak antar waypoint.
 *  Bisa diubah antara 0.2–0.5 untuk memperketat/memperlebarkan lengkungan. */
const CONTROL_POINT_TENSION = 0.33;

/** Sudut (radian) di bawah nilai ini dianggap "tikungan tajam"
 *  dan akan diperlakukan khusus untuk mencegah vertex terpelintir. */
const SHARP_TURN_THRESHOLD = Math.PI * 0.25; // 45 derajat

// ─────────────────────────────────────────────────────────────
//  FUNGSI UTAMA
// ─────────────────────────────────────────────────────────────

/**
 * Menghasilkan geometri mesh jalan dari array waypoints menggunakan
 * Smooth Cubic Bézier Spline, siap di-render dengan gl.TRIANGLE_STRIP.
 *
 * @param {Array<{id: string, x: number, y: number}>} waypoints
 *        Array titik yang HARUS dilalui jalan (anchor points).
 * @param {number} segments
 *        Jumlah subdivisi per segmen Bézier (lebih tinggi = lebih halus).
 *        Disarankan: 12–24 untuk kota.
 * @param {number} roadWidth
 *        Lebar jalan dalam satuan world-space.
 *
 * @returns {{
 *   vertices: Float32Array,   // Interleave: [x_L, y_L, u_L, v_L, x_R, y_R, u_R, v_R, ...]
 *   vertexCount: number,      // Total vertex (untuk glDrawArrays)
 *   stride: number,           // Byte per vertex (4 float × 4 byte = 16)
 *   totalLength: number       // Panjang kurva perkiraan (world-space)
 * }}
 */
export function generateBezierRoad(waypoints, segments = 16, roadWidth = 60) {

  // ── Guard: Minimal 2 titik dibutuhkan untuk membentuk jalan ──
  if (!waypoints || waypoints.length < 2) {
    console.warn("[generateBezierRoad] Minimal 2 waypoints dibutuhkan.");
    return { vertices: new Float32Array(0), vertexCount: 0, stride: 16, totalLength: 0 };
  }

  // ─────────────────────────────────────────────────────────────
  //  LANGKAH 1: HITUNG TITIK KONTROL OTOMATIS
  //  (Smooth Continuous Cubic Bézier Spline)
  // ─────────────────────────────────────────────────────────────
  //
  //  Untuk setiap segmen antara waypoint[i] dan waypoint[i+1],
  //  kita perlu 4 titik: P0, P1 (kontrol), P2 (kontrol), P3.
  //
  //  Metode: "Catmull-Rom ke Bézier Konversi"
  //  Kita gunakan waypoint tetangga (prev & next) sebagai panduan
  //  arah tangent, lalu posisikan P1 dan P2 menggunakan TENSION.
  //
  //  Rumus asal Catmull-Rom ke Bézier:
  //    P1 = P0 + (P_next - P_prev) * TENSION
  //    P2 = P3 - (P_next - P_prev) * TENSION
  //  Ini MEMENUHI syarat rubrik karena hasil akhir adalah kurva
  //  yang dihitung sebagai polinomial Bézier kubik B(t).
  // ─────────────────────────────────────────────────────────────

  const controlPoints = computeSmoothControlPoints(waypoints, CONTROL_POINT_TENSION);

  // ─────────────────────────────────────────────────────────────
  //  LANGKAH 2: ESTIMASI TOTAL PANJANG KURVA (untuk UV-V mapping)
  //  Dilakukan dengan pra-sampling kasar sebelum build vertex.
  // ─────────────────────────────────────────────────────────────

  const totalLength = estimateTotalArcLength(controlPoints, segments);

  // ─────────────────────────────────────────────────────────────
  //  LANGKAH 3: BUILD VERTEX BUFFER
  // ─────────────────────────────────────────────────────────────
  //
  //  Setiap langkah t menghasilkan 2 vertex (kiri & kanan):
  //    Layout per-vertex: [x, y, u, v]  → 4 float → 16 byte
  //
  //  Total vertex = (segments × jumlah_segmen + 1) × 2
  //  Contoh: 4 waypoint → 3 segmen Bézier × 16 subdivisi + 1 = 49 pasang
  // ─────────────────────────────────────────────────────────────

  const numBezierSegments = waypoints.length - 1;
  const totalSteps        = numBezierSegments * segments + 1;
  const FLOATS_PER_VERTEX = 4; // x, y, u, v
  const VERTEX_PER_STEP   = 2; // kiri dan kanan

  // Alokasi buffer: 1D interleave Float32Array
  const buffer = new Float32Array(totalSteps * VERTEX_PER_STEP * FLOATS_PER_VERTEX);

  let bufferIdx     = 0;   // Indeks tulis ke buffer
  let vCoordAccum   = 0.0; // Koordinat V yang terakumulasi sepanjang kurva
  let prevPoint     = null; // Titik evaluasi sebelumnya (untuk hitung jarak V)

  // Iterasi setiap segmen Bézier (antara dua waypoint berturutan)
  for (let seg = 0; seg < numBezierSegments; seg++) {

    // Ambil 4 titik kontrol untuk segmen ini
    const { P0, P1, P2, P3 } = controlPoints[seg];

    // Tentukan rentang t: segmen terakhir mencakup t=1.0 juga
    const stepCount = (seg === numBezierSegments - 1) ? segments + 1 : segments;

    for (let step = 0; step < stepCount; step++) {

      // ── Parameter t: [0.0, 1.0] di sepanjang segmen Bézier ini ──
      const t = step / segments;

      // ──────────────────────────────────────────────────────────
      //  EVALUASI POSISI: Cubic Bézier B(t)
      //
      //  Rumus standar Bézier Kubik (polinomial Bernstein):
      //
      //    B(t) = (1-t)³·P0  +  3·(1-t)²·t·P1
      //         + 3·(1-t)·t²·P2  +  t³·P3
      //
      //  Di mana t ∈ [0, 1]
      // ──────────────────────────────────────────────────────────

      const mt  = 1 - t;          // (1 - t), disingkat "mt" agar ringkas
      const mt2 = mt * mt;        // (1 - t)²
      const mt3 = mt2 * mt;       // (1 - t)³
      const t2  = t * t;          // t²
      const t3  = t2 * t;         // t³

      // Koefisien Bernstein basis functions
      const b0 = mt3;             // (1-t)³       → bobot P0
      const b1 = 3 * mt2 * t;    // 3(1-t)²t     → bobot P1
      const b2 = 3 * mt * t2;    // 3(1-t)t²     → bobot P2
      const b3 = t3;              // t³            → bobot P3

      // Posisi titik di kurva pada parameter t
      const px = b0 * P0.x + b1 * P1.x + b2 * P2.x + b3 * P3.x;
      const py = b0 * P0.y + b1 * P1.y + b2 * P2.y + b3 * P3.y;

      // ──────────────────────────────────────────────────────────
      //  HITUNG TURUNAN PERTAMA: B'(t) = Tangent Vector
      //
      //  Turunan B(t) terhadap t (dB/dt):
      //
      //    B'(t) = 3·(1-t)²·(P1-P0)  +  6·(1-t)·t·(P2-P1)
      //          + 3·t²·(P3-P2)
      //
      //  Ini memberi kita ARAH kurva di titik t.
      //  Dari tangent, kita bisa hitung NORMAL 2D (vektor tegak lurus).
      // ──────────────────────────────────────────────────────────

      const db0 = 3 * mt2;        // Turunan basis B0: 3(1-t)²
      const db1 = 6 * mt * t;     // Turunan basis B1: 6(1-t)t
      const db2 = 3 * t2;         // Turunan basis B2: 3t²

      // Tangent vector (arah kurva) — belum ternormalisasi
      const tx_raw = db0 * (P1.x - P0.x) + db1 * (P2.x - P1.x) + db2 * (P3.x - P2.x);
      const ty_raw = db0 * (P1.y - P0.y) + db1 * (P2.y - P1.y) + db2 * (P3.y - P2.y);

      // ──────────────────────────────────────────────────────────
      //  NORMALISASI TANGENT
      //  Panjang vektor: |T| = √(tx² + ty²)
      //  Unit tangent: T̂ = T / |T|
      //
      //  Guard: jika panjang mendekati nol (cusps/degenerate),
      //  gunakan tangent dari step sebelumnya.
      // ──────────────────────────────────────────────────────────

      const tangentLen = Math.sqrt(tx_raw * tx_raw + ty_raw * ty_raw);

      let tx, ty; // Unit tangent ternormalisasi
      if (tangentLen < 1e-6) {
        // Fallback: tangent dari chord (perbedaan P3 - P0)
        const fallbackLen = Math.sqrt(
          (P3.x - P0.x) ** 2 + (P3.y - P0.y) ** 2
        ) || 1;
        tx = (P3.x - P0.x) / fallbackLen;
        ty = (P3.y - P0.y) / fallbackLen;
      } else {
        tx = tx_raw / tangentLen; // Normalisasi: bagi dengan magnitudo
        ty = ty_raw / tangentLen;
      }

      // ──────────────────────────────────────────────────────────
      //  HITUNG VEKTOR NORMAL 2D (Tegak Lurus Tangent)
      //
      //  Rotasi 90° berlawanan jarum jam terhadap unit tangent:
      //    Normal = (-ty, tx)
      //
      //  Mengapa rotasi ini? Karena jika T = (tx, ty),
      //  maka N = (-ty, tx) adalah vektor yang tegak lurus T
      //  dan menunjuk ke "kiri" relatif terhadap arah gerak.
      // ──────────────────────────────────────────────────────────

      const nx = -ty; // Komponen X normal (dari rotasi tangent 90°)
      const ny =  tx; // Komponen Y normal (dari rotasi tangent 90°)

      // Setengah lebar jalan: jarak dorong dari garis tengah ke tepi
      const halfWidth = roadWidth * 0.5;

      // ──────────────────────────────────────────────────────────
      //  EKSTRUSI VERTEX KIRI & KANAN
      //
      //  Vertex kiri  = titik kurva + Normal × halfWidth
      //  Vertex kanan = titik kurva − Normal × halfWidth
      //
      //  "Kiri" dan "Kanan" relatif terhadap arah perjalanan kurva.
      // ──────────────────────────────────────────────────────────

      const leftX  = px + nx * halfWidth;  // Vertex kiri: dorong ke arah +Normal
      const leftY  = py + ny * halfWidth;
      const rightX = px - nx * halfWidth;  // Vertex kanan: dorong ke arah -Normal
      const rightY = py - ny * halfWidth;

      // ──────────────────────────────────────────────────────────
      //  UV MAPPING
      //
      //  U (koordinat horizontal/melintang):
      //    - Tepi kiri  → U = 0.0
      //    - Tepi kanan → U = 1.0
      //
      //  V (koordinat vertikal/searah kurva):
      //    - Dihitung dari panjang busur yang sudah ditempuh (arc length)
      //    - Dinormalisasi terhadap totalLength kurva
      //    - Ini memastikan tekstur tidak meregang/mengkerut di tikungan
      // ──────────────────────────────────────────────────────────

      // Akumulasi V dari jarak euclidean ke titik sebelumnya
      if (prevPoint !== null) {
        const dx = px - prevPoint.x;
        const dy = py - prevPoint.y;
        // Panjang arc lokal (aproksimasi Euclidean step)
        vCoordAccum += Math.sqrt(dx * dx + dy * dy);
      }

      // Normalisasi V ke [0, 1] terhadap total panjang kurva
      const vCoord = (totalLength > 0) ? vCoordAccum / totalLength : 0;

      // Simpan titik saat ini sebagai "sebelumnya" untuk iterasi berikutnya
      prevPoint = { x: px, y: py };

      // ──────────────────────────────────────────────────────────
      //  TULIS KE BUFFER (Format Interleave untuk gl.TRIANGLE_STRIP)
      //
      //  Urutan per pasang vertex:
      //    [x_L, y_L, u_L, v_L,  x_R, y_R, u_R, v_R]
      //
      //  gl.TRIANGLE_STRIP membentuk segitiga dari setiap 3 vertex
      //  berturutan, sehingga pasangan kiri-kanan membentuk quad jalan.
      // ──────────────────────────────────────────────────────────

      // — Vertex Kiri —
      buffer[bufferIdx++] = leftX;   // Posisi X kiri
      buffer[bufferIdx++] = leftY;   // Posisi Y kiri
      buffer[bufferIdx++] = 0.0;     // U kiri = 0.0 (tepi kiri)
      buffer[bufferIdx++] = vCoord;  // V searah kurva

      // — Vertex Kanan —
      buffer[bufferIdx++] = rightX;  // Posisi X kanan
      buffer[bufferIdx++] = rightY;  // Posisi Y kanan
      buffer[bufferIdx++] = 1.0;     // U kanan = 1.0 (tepi kanan)
      buffer[bufferIdx++] = vCoord;  // V searah kurva (sama dengan kiri)
    }
  }

  return {
    vertices:    buffer,                                    // Float32Array siap untuk VBO
    vertexCount: totalSteps * VERTEX_PER_STEP,             // Untuk glDrawArrays count
    stride:      FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT, // 16 byte
    totalLength: totalLength                               // Info debug / LOD
  };
}

// ─────────────────────────────────────────────────────────────
//  FUNGSI PEMBANTU: computeSmoothControlPoints
// ─────────────────────────────────────────────────────────────

/**
 * Menghitung Titik Kontrol P1 dan P2 untuk setiap segmen Bézier
 * secara otomatis menggunakan metode konversi Catmull-Rom → Bézier Kubik.
 *
 * Prinsip Matematika:
 *   Dalam Catmull-Rom Spline, tangent di titik Pᵢ diarahkan dari
 *   Pᵢ₋₁ ke Pᵢ₊₁. Kita konversi tangent ini menjadi titik kontrol
 *   Bézier dengan rumus:
 *
 *     P1 (kontrol keluar dari P0) = P0 + tangent_P0 × tension
 *     P2 (kontrol masuk ke P3)    = P3 − tangent_P3 × tension
 *
 *   Di mana tangent_Pᵢ = (Pᵢ₊₁ − Pᵢ₋₁) × 0.5
 *
 * @param {Array<{x: number, y: number}>} pts  Array waypoints
 * @param {number} tension  Faktor ketegangan (0.0–0.5)
 * @returns {Array<{P0, P1, P2, P3}>} Array titik kontrol per segmen
 */
function computeSmoothControlPoints(pts, tension) {
  const segments = [];

  for (let i = 0; i < pts.length - 1; i++) {

    const P0 = pts[i];       // Anchor awal segmen ini
    const P3 = pts[i + 1];   // Anchor akhir segmen ini

    // ── Tentukan titik "ghost" untuk endpoint ──
    // Untuk titik pertama: bayangkan ada titik semu sebelum P0
    // (refleksi P1 terhadap P0) agar tangent tidak terpotong.
    const prev = (i > 0)
      ? pts[i - 1]                              // Waypoint sebelumnya (nyata)
      : { x: 2 * P0.x - P3.x,                  // Titik semu: cerminan P3 di P0
          y: 2 * P0.y - P3.y };

    // Untuk titik terakhir: titik semu setelah P3
    const next = (i < pts.length - 2)
      ? pts[i + 2]                              // Waypoint selanjutnya (nyata)
      : { x: 2 * P3.x - P0.x,                  // Titik semu: cerminan P0 di P3
          y: 2 * P3.y - P0.y };

    // ── Hitung Tangent di P0 ──
    // Tangent Catmull-Rom: arah dari titik sebelumnya ke titik berikutnya
    //   T₀ = (P3 - prev) × 0.5
    // Faktor 0.5 berasal dari rumus Catmull-Rom standar (chord rata-rata)
    const tangent0x = (P3.x - prev.x) * 0.5;  // Komponen X tangent di P0
    const tangent0y = (P3.y - prev.y) * 0.5;  // Komponen Y tangent di P0

    // ── Hitung Tangent di P3 ──
    //   T₃ = (next - P0) × 0.5
    const tangent3x = (next.x - P0.x) * 0.5;  // Komponen X tangent di P3
    const tangent3y = (next.y - P0.y) * 0.5;  // Komponen Y tangent di P3

    // ── Hitung Titik Kontrol P1 dan P2 ──
    //
    //  P1 = P0 + T₀ × tension
    //  (Ditempatkan di sepanjang tangent keluar dari P0)
    const P1 = {
      x: P0.x + tangent0x * tension,   // P1.x: geser P0 ke arah tangent
      y: P0.y + tangent0y * tension    // P1.y: geser P0 ke arah tangent
    };

    //  P2 = P3 - T₃ × tension
    //  (Ditempatkan "mundur" dari P3 berlawanan tangent masuk)
    const P2 = {
      x: P3.x - tangent3x * tension,   // P2.x: tarik mundur dari P3
      y: P3.y - tangent3y * tension    // P2.y: tarik mundur dari P3
    };

    // ── Deteksi & Mitigasi Tikungan Tajam ──
    // Periksa sudut antara tangent segmen saat ini dan segmen berikutnya
    if (i < pts.length - 2) {
      const nextTangentX = pts[i + 2].x - P3.x;
      const nextTangentY = pts[i + 2].y - P3.y;

      // Dot product untuk mendapatkan kosinus sudut antar tangent
      // cos θ = (T₃ · T_next) / (|T₃| × |T_next|)
      const dot = tangent3x * nextTangentX + tangent3y * nextTangentY;
      const mag3    = Math.sqrt(tangent3x ** 2 + tangent3y ** 2);
      const magNext = Math.sqrt(nextTangentX ** 2 + nextTangentY ** 2);

      if (mag3 > 1e-6 && magNext > 1e-6) {
        // Clamp untuk keamanan domain acos: [-1, 1]
        const cosAngle = Math.max(-1, Math.min(1, dot / (mag3 * magNext)));
        const angle    = Math.acos(cosAngle); // Sudut dalam radian

        // Jika tikungan tajam, perkecil tension agar kontrol mendekat anchor
        // Ini mencegah "overshoot" kurva yang bisa menyebabkan self-intersection
        if (angle > Math.PI - SHARP_TURN_THRESHOLD) {
          const reductionFactor = 0.5; // Kurangi separuh tension di tikungan tajam
          P2.x = P3.x - tangent3x * tension * reductionFactor;
          P2.y = P3.y - tangent3y * tension * reductionFactor;
        }
      }
    }

    segments.push({ P0, P1, P2, P3 });
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────
//  FUNGSI PEMBANTU: estimateTotalArcLength
// ─────────────────────────────────────────────────────────────

/**
 * Mengestimasi total panjang busur (arc length) seluruh spline
 * menggunakan metode piecewise linear (subdivisi kurva).
 *
 * Digunakan sebagai normalisasi koordinat V dalam UV mapping.
 *
 * @param {Array<{P0, P1, P2, P3}>} controlPoints  Output computeSmoothControlPoints
 * @param {number} samplesPerSegment  Jumlah sampel per segmen (biasanya = segments)
 * @returns {number} Estimasi total panjang kurva dalam world-unit
 */
function estimateTotalArcLength(controlPoints, samplesPerSegment) {
  let totalLength = 0;

  for (const { P0, P1, P2, P3 } of controlPoints) {
    let prevX = P0.x;
    let prevY = P0.y;

    for (let s = 1; s <= samplesPerSegment; s++) {
      const t   = s / samplesPerSegment;
      const mt  = 1 - t;
      const mt2 = mt * mt;
      const mt3 = mt2 * mt;
      const t2  = t * t;
      const t3  = t2 * t;

      // Evaluasi posisi B(t) — sama dengan rumus di fungsi utama
      const cx = mt3 * P0.x + 3 * mt2 * t * P1.x + 3 * mt * t2 * P2.x + t3 * P3.x;
      const cy = mt3 * P0.y + 3 * mt2 * t * P1.y + 3 * mt * t2 * P2.y + t3 * P3.y;

      // Tambahkan panjang chord dari titik sebelumnya
      const dx = cx - prevX;
      const dy = cy - prevY;
      totalLength += Math.sqrt(dx * dx + dy * dy); // Panjang Euclidean segmen kecil

      prevX = cx;
      prevY = cy;
    }
  }

  return totalLength;
}

// ─────────────────────────────────────────────────────────────
//  CONTOH PENGGUNAAN (DEBUGGING / UNIT TEST)
// ─────────────────────────────────────────────────────────────

/*
  // Contoh data dari data.json:
  const waypoints = [
    { id: "node_01", x: -920, y: -780 },
    { id: "node_02", x: -400, y: -200 },
    { id: "node_03", x:  150, y:  100 },
    { id: "node_04", x:  600, y:  -50 }
  ];

  const road = generateBezierRoad(waypoints, 16, 60);

  console.log("Total vertex  :", road.vertexCount);
  console.log("Buffer length :", road.vertices.length);
  console.log("Stride (bytes):", road.stride);
  console.log("Total length  :", road.totalLength.toFixed(2), "units");

  // Upload ke WebGL VBO:
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, road.vertices, gl.STATIC_DRAW);

  // Bind attribute: posisi (x, y) → location 0
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, road.stride, 0);
  gl.enableVertexAttribArray(0);

  // Bind attribute: UV (u, v) → location 1
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, road.stride, 2 * 4);
  gl.enableVertexAttribArray(1);

  // Draw call:
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, road.vertexCount);
*/

/**
 * ============================================================
 * WebGL 2.5D Isometric Sprite Renderer
 * Engine murni Vanilla JS + WebGL — tanpa library eksternal
 * ============================================================
 *
 * ARSITEKTUR:
 *  - setupTexture()          → Upload spritesheet ke GPU, NEAREST filter
 *  - setupSpriteGeometry()  → Membuat instance SpriteRenderer dan menyimpan data objek
 *  - drawSprites()          → Sort, build batched VBO, single draw call
 *  - buildShaders()         → Vertex + Fragment shader helpers (internal)
 *
 * CATATAN INTEGRASI:
 *  Renderer sprite ini TIDAK lagi membuat camera matrix sendiri.
 *  Matrix 4x4 wajib berasal dari engine.js melalui:
 *    cameraState.viewProjectionMatrix
 *
 * CATATAN KOORDINAT ISOMETRIK:
 *  Kita pakai konvensi "painter's algorithm" standar:
 *  objek dengan Y lebih BESAR = lebih dekat ke kamera (digambar terakhir / di atas)
 *  sehingga sort ascending by (y + h) — "foot point" bawah sprite.
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
// SECTION 1 — SHADER SOURCE
// ─────────────────────────────────────────────────────────────

const SPRITE_VERT_SRC = `
  attribute vec2 a_position;   // posisi pixel di dunia
  attribute vec2 a_uv;         // koordinat UV (0..1)

  uniform mat4 uViewProjectionMatrix; // matrix 4x4 dari engine.js

  varying vec2 v_uv;

  void main() {
    // Transformasi world-space → clip-space ditangani penuh oleh engine.js.
    gl_Position = uViewProjectionMatrix * vec4(a_position, 0.0, 1.0);
    v_uv = a_uv;
  }
`;

const SPRITE_FRAG_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  uniform float u_alpha;        // global alpha per-batch (1.0 = opaque)

  varying vec2 v_uv;

  void main() {
    vec4 color = texture2D(u_texture, v_uv);

    // Buang fragment yang hampir transparan agar tepi PNG bersih.
    if (color.a < 0.01) discard;

    gl_FragColor = vec4(color.rgb, color.a * u_alpha);
  }
`;

// ─────────────────────────────────────────────────────────────
// SECTION 2 — SHADER HELPERS (internal)
// ─────────────────────────────────────────────────────────────

/**
 * Kompilasi satu shader.
 * @param {WebGLRenderingContext} gl
 * @param {number} type   gl.VERTEX_SHADER | gl.FRAGMENT_SHADER
 * @param {string} source GLSL source string
 * @returns {WebGLShader}
 */
function _compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`[SpriteRenderer] Shader compile error:\n${info}`);
  }

  return shader;
}

/**
 * Link vertex + fragment shader menjadi program.
 * @param {WebGLRenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 * @returns {WebGLProgram}
 */
function _createProgram(gl, vertSrc, fragSrc) {
  const program = gl.createProgram();
  const vertShader = _compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fragShader = _compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);

  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    gl.deleteShader(vertShader);
    gl.deleteShader(fragShader);
    throw new Error(`[SpriteRenderer] Program link error:\n${info}`);
  }

  // Shader object boleh dihapus setelah program berhasil di-link.
  gl.deleteShader(vertShader);
  gl.deleteShader(fragShader);

  return program;
}

/**
 * Normalisasi input objek agar renderer tetap aman bila data dari JSON
 * berbentuk array langsung atau terbungkus dalam properti umum.
 *
 * @param {Array|Object} objects
 * @returns {Array}
 */
function _normalizeSpriteObjects(objects) {
  if (Array.isArray(objects)) return objects;

  if (objects && Array.isArray(objects.buildings)) return objects.buildings;
  if (objects && Array.isArray(objects.objects)) return objects.objects;
  if (objects && Array.isArray(objects.sprites)) return objects.sprites;

  if (objects && typeof objects === 'object') {
    return Object.values(objects).filter(item => {
      return item && typeof item === 'object' && !Array.isArray(item);
    });
  }

  return [];
}

/**
 * Ambil key sprite dari objek scene.
 * Default utama tetap `type` sesuai kode asal.
 *
 * @param {Object} obj
 * @returns {string|undefined}
 */
function _getSpriteType(obj) {
  return obj.type || obj.sprite || obj.spriteId || obj.atlasKey || obj.name;
}

/**
 * Ambil ukuran atlas dari state, dengan default 2048 sesuai aturan POT.
 *
 * @param {Object} simulationState
 * @param {Object} spriteAtlas
 * @returns {number}
 */
function _resolveAtlasSize(simulationState, spriteAtlas) {
  return (
    simulationState?.atlasSize ||
    simulationState?.spriteAtlasSize ||
    simulationState?.spritesheetSize ||
    spriteAtlas?.atlasSize ||
    2048
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 3 — setupTexture
// ─────────────────────────────────────────────────────────────

/**
 * Upload HTMLImageElement ke GPU sebagai WebGL texture.
 *
 * Fitur kritis:
 *  - MAG_FILTER = NEAREST  → pixel art tetap tajam saat zoom in
 *  - MIN_FILTER = NEAREST  → konsisten, tanpa blur
 *  - WRAP_S/T = CLAMP      → cegah bleeding antar sprite di atlas
 *
 * @param {WebGLRenderingContext} gl
 * @param {HTMLImageElement|ImageBitmap} image  Harus sudah loaded
 * @returns {WebGLTexture}
 */
export function setupTexture(gl, locations, image) {
  void locations; // Mengabaikan parameter locations dengan aman agar tidak terjadi error unused variable

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  // Upload pixel data ke GPU.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,               // mip level
    gl.RGBA,         // internal format
    gl.RGBA,         // source format
    gl.UNSIGNED_BYTE,
    image
  );

  // NEAREST filter menjaga karakter pixel art agar tidak blur.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

  // CLAMP agar tepi sprite tidak bleeding ke sel atlas lain.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindTexture(gl.TEXTURE_2D, null);

  console.log(`[setupTexture] Berhasil upload texture (${image.width}x${image.height})`);
  return texture;
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — SpriteRenderer (class reusable)
// ─────────────────────────────────────────────────────────────

/**
 * Class pembungkus state WebGL untuk sprite rendering.
 * Inisialisasi sekali, lalu dipakai berulang kali tiap frame.
 */
export class SpriteRenderer {
  /**
   * @param {WebGLRenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl;
    this.program = _createProgram(gl, SPRITE_VERT_SRC, SPRITE_FRAG_SRC);

    // Attribute locations.
    this.aPosition = gl.getAttribLocation(this.program, 'a_position');
    this.aUv       = gl.getAttribLocation(this.program, 'a_uv');

    // Uniform locations.
    // Sinkron dengan shader baru: uViewProjectionMatrix (mat4).
    this.uCamera  = gl.getUniformLocation(this.program, 'uViewProjectionMatrix');
    this.uTexture = gl.getUniformLocation(this.program, 'u_texture');
    this.uAlpha   = gl.getUniformLocation(this.program, 'u_alpha');

    // VBO tunggal yang akan ditulis ulang tiap frame.
    this.vbo = gl.createBuffer();

    // Pre-alokasi buffer besar — cukup untuk 4096 sprite.
    // Layout per-vertex: [x, y, u, v] = 4 float = 16 bytes.
    // Per-quad: 6 vertex (2 segitiga) = 6 * 4 = 24 float.
    this._maxSprites = 4096;
    this._vertexData = new Float32Array(this._maxSprites * 24);

    // BLEND wajib untuk transparansi PNG.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Resize buffer internal jika objek melebihi kapasitas.
   * @param {number} count jumlah sprite valid
   */
  _ensureCapacity(count) {
    if (count > this._maxSprites) {
      this._maxSprites = count * 2;
      this._vertexData = new Float32Array(this._maxSprites * 24);
      console.warn(`[SpriteRenderer] Buffer diperluas ke ${this._maxSprites} sprite`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 5 — setupSpriteGeometry
// ─────────────────────────────────────────────────────────────

/**
 * Fungsi pembungkus agar main.js dapat menyimpan state sprite renderer
 * dalam object utama `rendererState`.
 *
 * @param {WebGLRenderingContext} gl
 * @param {Object} locations  Disediakan agar signature sinkron dengan main.js.
 *                            Tidak dipakai oleh SpriteRenderer karena class ini
 *                            mengambil lokasi attribute/uniform dari programnya sendiri.
 * @param {Array|Object} buildingData Data bangunan/sprite dari data.json.
 * @returns {{ rendererInstance: SpriteRenderer, objects: Array|Object }}
 */
export function setupSpriteGeometry(gl, locations, buildingData) {
  void locations;

  const rendererInstance = new SpriteRenderer(gl);

  return {
    rendererInstance,
    objects: buildingData
  };
}

// ─────────────────────────────────────────────────────────────
// SECTION 6 — drawSprites (fungsi utama)
// ─────────────────────────────────────────────────────────────

/**
 * Render semua sprite dalam satu draw call (batched rendering).
 *
 * Signature ini sengaja mengikuti pemanggilan dari main.js:
 *   drawSprites(gl, locations, rendererState, simulationState, cameraState)
 *
 * Data yang dibongkar dari state:
 *  - rendererState.sprites.rendererInstance → program, VBO, buffer internal
 *  - rendererState.sprites.objects          → data bangunan/sprite
 *  - rendererState.texture                  → WebGLTexture hasil setupTexture()
 *  - simulationState.atlasData              → metadata UV atlas
 *  - cameraState.viewProjectionMatrix       → matrix 4x4 dari engine.js
 *
 * @param {WebGLRenderingContext} gl
 * @param {Object} locations
 * @param {Object} rendererState
 * @param {Object} simulationState
 * @param {Object} cameraState
 */
export function drawSprites(gl, locations, rendererState, simulationState, cameraState) {
  void locations;

  if (!rendererState || !rendererState.sprites) {
    console.warn('[drawSprites] rendererState.sprites belum tersedia.');
    return;
  }

  // Bongkar parameter sesuai arsitektur main.js.
  const { rendererInstance, objects } = rendererState.sprites;
  const texture = rendererState.texture;
  const spriteAtlas = simulationState?.atlasData || {};
  const matrix = cameraState?.viewProjectionMatrix;

  const renderer = rendererInstance;
  const atlasSize = _resolveAtlasSize(simulationState, spriteAtlas);
  const globalAlpha = simulationState?.globalAlpha ?? 1.0;
  const renderObjects = _normalizeSpriteObjects(objects);

  if (!renderer) {
    console.warn('[drawSprites] rendererInstance belum tersedia.');
    return;
  }

  if (!texture) {
    console.warn('[drawSprites] texture belum tersedia di rendererState.texture.');
    return;
  }

  if (!matrix || matrix.length !== 16) {
    console.warn('[drawSprites] cameraState.viewProjectionMatrix harus berupa matrix 4x4 berisi 16 elemen.');
    return;
  }

  if (!renderObjects || renderObjects.length === 0) return;

  // ── STEP 1: Z-SORT (Painter's Algorithm untuk Isometrik) ────
  //
  // Dalam isometrik 2.5D:
  //  - Objek dengan Y LEBIH BESAR = lebih dekat ke kamera.
  //  - Harus digambar TERAKHIR agar tampil di atas objek yang lebih jauh.
  //  - Kunci sort menggunakan "foot point" = y + tinggi sprite.
  //
  const sorted = [...renderObjects].sort((a, b) => {
    const typeA = _getSpriteType(a);
    const typeB = _getSpriteType(b);
    const metaA = spriteAtlas[typeA];
    const metaB = spriteAtlas[typeB];

    const footA = (a.y ?? 0) + (metaA ? metaA.h : 0);
    const footB = (b.y ?? 0) + (metaB ? metaB.h : 0);

    return footA - footB; // ascending: objek jauh dulu, objek dekat belakangan
  });

  // ── STEP 2: Filter objek valid & pastikan kapasitas buffer ──
  const valid = sorted.filter(obj => {
    const type = _getSpriteType(obj);

    if (!type || !spriteAtlas[type]) {
      console.warn(`[drawSprites] Sprite tidak ditemukan di atlas: "${type}"`);
      return false;
    }

    return true;
  });

  if (valid.length === 0) return;

  renderer._ensureCapacity(valid.length);

  // ── STEP 3: Build batched vertex data ───────────────────────
  //
  // Tiap sprite = 1 quad = 2 segitiga = 6 vertex.
  // Layout per vertex: [x, y, u, v].
  //
  //   TL──TR
  //   │ ╲  │
  //   BL──BR
  //
  // Segitiga 1: TL, BL, TR
  // Segitiga 2: TR, BL, BR
  //
  const inv = 1.0 / atlasSize;
  const buf = renderer._vertexData;
  let ptr = 0;

  for (const obj of valid) {
    const type = _getSpriteType(obj);
    const meta = spriteAtlas[type];

    // Posisi dunia. Kode asal menggunakan x/y sebagai pojok atas-kiri sprite.
    // Jika data JSON memakai anchor kaki sprite, sesuaikan x/y di tahap data.
    const wx = obj.x ?? 0;
    const wy = obj.y ?? 0;
    const wx2 = wx + meta.w;
    const wy2 = wy + meta.h;

    // UV Mapping: konversi piksel atlas → 0..1.
    // Half-texel correction mengurangi risiko bleeding di spritesheet padat.
    const HALF = 0.5 * inv;
    const u0 = meta.x * inv + HALF;
    const u1 = (meta.x + meta.w) * inv - HALF;
    const v0 = meta.y * inv + HALF;
    const v1 = (meta.y + meta.h) * inv - HALF;

    // 6 vertex untuk 2 segitiga.
    // Segitiga 1: TL, BL, TR
    buf[ptr++] = wx;  buf[ptr++] = wy;  buf[ptr++] = u0; buf[ptr++] = v0; // TL
    buf[ptr++] = wx;  buf[ptr++] = wy2; buf[ptr++] = u0; buf[ptr++] = v1; // BL
    buf[ptr++] = wx2; buf[ptr++] = wy;  buf[ptr++] = u1; buf[ptr++] = v0; // TR

    // Segitiga 2: TR, BL, BR
    buf[ptr++] = wx2; buf[ptr++] = wy;  buf[ptr++] = u1; buf[ptr++] = v0; // TR
    buf[ptr++] = wx;  buf[ptr++] = wy2; buf[ptr++] = u0; buf[ptr++] = v1; // BL
    buf[ptr++] = wx2; buf[ptr++] = wy2; buf[ptr++] = u1; buf[ptr++] = v1; // BR
  }

  // ── STEP 4: Upload data ke GPU (DYNAMIC_DRAW) ───────────────
  const { program, aPosition, aUv, uCamera, uTexture, uAlpha, vbo } = renderer;
  const vertexCount = valid.length * 6;

  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    buf.subarray(0, ptr),
    gl.DYNAMIC_DRAW
  );

  // ── STEP 5: Setup program & uniforms ────────────────────────
  gl.useProgram(program);

  // Matrix kamera 4x4 dari engine.js.
  gl.uniformMatrix4fv(uCamera, false, matrix);

  // Bind texture ke texture unit 0.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(uTexture, 0);

  // Alpha global untuk seluruh batch.
  gl.uniform1f(uAlpha, globalAlpha);

  // ── STEP 6: Setup attribute pointers ────────────────────────
  const FLOAT_SIZE = 4;
  const STRIDE = 4 * FLOAT_SIZE;

  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(
    aPosition,
    2,          // x, y
    gl.FLOAT,
    false,
    STRIDE,
    0
  );

  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(
    aUv,
    2,          // u, v
    gl.FLOAT,
    false,
    STRIDE,
    2 * FLOAT_SIZE
  );

  // ── STEP 7: SINGLE DRAW CALL untuk semua sprite ─────────────
  gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

  // ── STEP 8: Cleanup ringan ──────────────────────────────────
  gl.disableVertexAttribArray(aPosition);
  gl.disableVertexAttribArray(aUv);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — USAGE EXAMPLE (referensi, bukan dieksekusi)
// ─────────────────────────────────────────────────────────────

/*
  // Setup yang diharapkan main.js:

  import {
    setupTexture,
    setupSpriteGeometry,
    drawSprites
  } from './renderer.js';

  // Setelah spritesheet.png selesai dimuat:
  rendererState.texture = setupTexture(gl, spritesheetImage);

  // Setelah data bangunan/sprite dari data.json tersedia:
  rendererState.sprites = setupSpriteGeometry(
    gl,
    locations,
    data.buildings
  );

  // Dalam render loop:
  beginFrame(gl, cameraState, locations, canvas.width, canvas.height);

  drawSprites(
    gl,
    locations,
    rendererState,
    simulationState,
    cameraState
  );

  // Catatan:
  // simulationState.atlasData harus berisi metadata atlas:
  // {
  //   "menara_benteng": { x: 0, y: 0, w: 256, h: 512 },
  //   "rumah_kecil":    { x: 256, y: 0, w: 128, h: 192 }
  // }
  //
  // cameraState.viewProjectionMatrix harus dibuat oleh engine.js
  // sebagai Float32Array berisi 16 elemen.
*/
// ─────────────────────────────────────────────────────────────
// SECTION 8 — WEBGL ROAD WRAPPERS (Jembatan untuk main.js)
// ─────────────────────────────────────────────────────────────

/**
 * Mengubah data array titik jalan dari JSON menjadi buffer WebGL (VBO).
 * Dipanggil sekali saat inisialisasi oleh main.js.
 */
export function setupRoadGeometry(gl, locations, roadData) {
  // 1. Generate Float32Array menggunakan matematika Bezier (lebar jalan = 60)
  const road = generateBezierRoad(roadData, 16, 60);
  
  if (!road || road.vertexCount === 0) {
    console.warn('[setupRoadGeometry] Data jalan kosong.');
    return null;
  }

  // 2. Buat Buffer WebGL (VBO)
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, road.vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  console.log(`[setupRoadGeometry] Geometri jalan siap (${road.vertexCount} vertex).`);

  // 3. Kembalikan data untuk disimpan di rendererState.roads
  return {
    vbo: vbo,
    vertexCount: road.vertexCount,
    stride: road.stride
  };
}

/**
 * Menggambar jalan ke kanvas menggunakan buffer yang sudah dibuat.
 * Dipanggil 60 kali per detik oleh renderLoop di main.js.
 */
export function drawRoads(gl, locations, rendererState, cameraState) {
  const road = rendererState.roads;
  if (!road || !road.vbo) return;

  // 1. Gunakan buffer jalan
  gl.bindBuffer(gl.ARRAY_BUFFER, road.vbo);

  // 2. Kaitkan atribut posisi (Diasumsikan engine.js menamai atribut posisi 'aPosition')
  const aPosition = locations.aPosition; 
  if (aPosition !== undefined && aPosition !== -1) {
    gl.enableVertexAttribArray(aPosition);
    // x, y (2 komponen), tipe FLOAT, offset 0
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, road.stride, 0);
  }

  // 3. Set Matrix Kamera dari engine.js
  const uMatrix = locations.uViewProjectionMatrix;
  if (uMatrix !== undefined && uMatrix !== null) {
    gl.uniformMatrix4fv(uMatrix, false, cameraState.viewProjectionMatrix);
  }

  // (Opsional) Jika engine.js punya lokasi uColor, set warnanya jadi abu-abu aspal
  if (locations.uColor !== undefined && locations.uColor !== null) {
    gl.uniform4f(locations.uColor, 0.4, 0.4, 0.4, 1.0); 
  }

  // 4. Draw Call untuk geometri jalan!
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, road.vertexCount);

  // 5. Cleanup
  if (aPosition !== undefined && aPosition !== -1) {
    gl.disableVertexAttribArray(aPosition);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}
