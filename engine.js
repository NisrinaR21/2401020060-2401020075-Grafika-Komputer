/**
 * engine.js
 * =============================================================================
 * WebGL Engine Dasar untuk Proyek "Medieval Spatial Mapping"
 * Mata Kuliah Grafika Komputer
 *
 * Deskripsi:
 * File ini menyediakan fondasi rendering WebGL untuk simulasi tata kota
 * medieval dari sudut pandang isometric 2.5D. Engine ini meng-handle:
 * inisialisasi WebGL, kompilasi shader, operasi matriks 4×4 manual,
 * kamera orthographic-isometric, kontrol kamera berbasis mouse, dan
 * optimasi dirty flag agar ringan di hardware GPU terintegrasi.
 *
 * Teknologi:
 * - WebGL 1.0 (canvas.getContext("webgl"))
 * - Vanilla JavaScript ES6 Module (tidak ada library eksternal)
 * - Float32Array untuk matriks (column-major, sesuai standar WebGL)
 *
 * Cara Penggunaan (dari main.js):
 * import { initWebGL, beginFrame, setColor } from './engine.js';
 * const engine = initWebGL('myCanvas');
 * function render() {
 * beginFrame(engine.gl, engine.cameraState, engine.locations,
 * engine.canvas.width, engine.canvas.height);
 * // ... draw calls di sini
 * requestAnimationFrame(render);
 * }
 * render();
 * =============================================================================
 */

// =============================================================================
// KONSTANTA ENGINE
// =============================================================================

/**
 * Ukuran dasar tampilan orthographic dalam satuan dunia (world units)
 * pada level zoom = 1.0. Nilai ini merepresentasikan setengah tinggi
 * area yang terlihat di layar ketika zoom berada di nilai normal.
 * Semakin besar nilai ini, semakin "jauh" tampilan default kamera.
 */
const BASE_VIEW_SIZE = 10.0;

/** Batas minimum zoom. Mencegah kamera terlalu jauh sehingga peta tidak terbaca. */
const ZOOM_MIN = 0.5;

/** Batas maksimum zoom. Mencegah kamera terlalu dekat hingga piksel terlalu besar. */
const ZOOM_MAX = 12.0;

/**
 * Kecepatan perubahan zoom per satu event scroll wheel.
 * Nilai kecil memberikan zoom yang halus dan terkontrol.
 */
const ZOOM_SPEED = 0.15;

/**
 * Sudut rotasi Y untuk tampilan isometric = 45 derajat (PI/4 radian).
 *
 * Rotasi Y 45° memutar seluruh peta secara horizontal sehingga sumbu X
 * dan Z dunia tampak miring simetris dari kiri-atas dan kanan-atas layar.
 * Ini menciptakan tampilan "berlian" khas pada peta isometric medieval.
 */
const ISO_ANGLE_Y = Math.PI / 4; // 45 derajat

/**
 * Sudut rotasi X untuk tampilan isometric ≈ 35.264 derajat.
 *
 * Nilai ini adalah arctan(1 / sqrt(2)) ≈ 35.2644°, yaitu sudut kemiringan
 * di mana ketiga sumbu utama (X, Y, Z) menghasilkan panjang proyeksi yang
 * SAMA PERSIS di layar. Inilah definisi matematis dari "proyeksi isometric
 * sejati" (true isometric / true axonometric).
 *
 * Jika sudut ini diubah:
 * - > 35.264° → sumbu vertikal (Y) tampak lebih pendek (dimetric)
 * - < 35.264° → sumbu vertikal (Y) tampak lebih panjang
 */
const ISO_ANGLE_X = 35.264 * (Math.PI / 180); // ≈ 0.6155 radian

// =============================================================================
// BAGIAN 1: UTILITAS MATRIKS 4×4 MANUAL
// =============================================================================
//
// MENGAPA MATRIKS 4×4?
// ─────────────────────────────────────────────────────────────────────────────
// Grafika komputer 3D menggunakan matriks 4×4 (bukan 3×3) karena:
//
// 1. TRANSLASI dalam bentuk perkalian matriks:
//    Dalam matriks 3×3, translasi tidak bisa direpresentasikan sebagai
//    perkalian matriks. Dengan menambahkan dimensi keempat (koordinat
//    homogen, biasanya w=1), translasi menjadi operasi linier yang bisa
//    dikombinasikan dengan rotasi dan skala dalam SATU perkalian matriks.
//
// 2. PROJEKSI:
//    Proyeksi orthographic dan perspektif membutuhkan baris/kolom keempat
//    untuk mengenkode informasi jarak (nilai w ≠ 1 untuk perspektif).
//
// FORMAT COLUMN-MAJOR (WEBGL):
// ─────────────────────────────────────────────────────────────────────────────
// WebGL membaca matriks dalam format column-major (kolom demi kolom).
// Array 16 elemen disusun sebagai:
//
//   index:   [0]  [1]  [2]  [3]  |  [4]  [5]  [6]  [7]  |  [8]  [9] [10] [11] | [12] [13] [14] [15]
//   posisi:  c0r0 c0r1 c0r2 c0r3 | c1r0 c1r1 c1r2 c1r3  | c2r0 c2r1 c2r2 c2r3 | c3r0 c3r1 c3r2 c3r3
//
//   di mana cN = kolom N, rN = baris N.
//   Rumus: index = kolom * 4 + baris
//
// Contoh matriks identitas 4×4 dalam column-major:
//   [1, 0, 0, 0,   0, 1, 0, 0,   0, 0, 1, 0,   0, 0, 0, 1]
//    ↑────kolom 0───↑  ↑────kolom 1───↑  ↑────kolom 2───↑  ↑────kolom 3───↑

/**
 * Membuat matriks identitas 4×4.
 *
 * Matriks identitas I adalah elemen netral perkalian matriks:
 * A × I = I × A = A
 * Digunakan sebagai titik awal sebelum menerapkan transformasi apapun.
 *
 * @returns {Float32Array} Array 16 elemen — matriks identitas 4×4
 */
export function createIdentityMatrix() {
    // Float32Array dipilih karena:
    // - Kompatibel langsung dengan gl.uniformMatrix4fv (tidak perlu konversi)
    // - Hemat memori dibanding Array biasa (32-bit per elemen, bukan 64-bit)
    // - Performa lebih baik untuk operasi numerik berulang
    return new Float32Array([
        1, 0, 0, 0,  // kolom 0: (1,0,0,0)
        0, 1, 0, 0,  // kolom 1: (0,1,0,0)
        0, 0, 1, 0,  // kolom 2: (0,0,1,0)
        0, 0, 0, 1   // kolom 3: (0,0,0,1)
    ]);
}

/**
 * Membuat matriks proyeksi orthographic 4×4.
 *
 * CARA KERJA PROYEKSI ORTHOGRAPHIC:
 * ─────────────────────────────────────────────────────────────────────────────
 * Orthographic projection memetakan sebuah "kotak" view (frustum rectangular)
 * ke dalam Normalized Device Coordinates (NDC) [-1,1]³ tanpa efek perspektif.
 * Objek yang jauh TIDAK mengecil — ukurannya tetap konsisten di semua jarak.
 *
 * Ini ideal untuk:
 * - Peta dan tampilan top-down
 * - Tampilan isometric 2.5D (tidak ada distorsi perspektif)
 * - Blueprint dan diagram teknis
 *
 * Rumus matriks orthographic (dalam representasi baris × kolom):
 *
 * ┌  2/(r-l)    0           0          -(r+l)/(r-l) ┐
 * │  0          2/(t-b)     0          -(t+b)/(t-b) │
 * │  0          0          -2/(f-n)    -(f+n)/(f-n) │
 * └  0          0           0           1            ┘
 *
 * PENGARUH ZOOM TERHADAP ORTHOGRAPHIC:
 * ─────────────────────────────────────────────────────────────────────────────
 * Zoom diimplementasikan dengan MENGUBAH LEBAR WINDOW orthographic:
 * - Zoom IN  → window lebih sempit → area tampil lebih kecil → objek tampak BESAR
 * - Zoom OUT → window lebih lebar → area tampil lebih besar  → objek tampak KECIL
 *
 * Misalnya dengan BASE_VIEW_SIZE = 10:
 * zoom=1.0 → halfH=10.0 → tampil area ±10 unit vertikal
 * zoom=2.0 → halfH=5.0  → tampil area ±5 unit (lebih dekat, 2× lebih besar)
 * zoom=0.5 → halfH=20.0 → tampil area ±20 unit (lebih jauh, 2× lebih kecil)
 *
 * @param {number} left   Batas kiri frustum (world units)
 * @param {number} right  Batas kanan frustum (world units)
 * @param {number} bottom Batas bawah frustum (world units)
 * @param {number} top    Batas atas frustum (world units)
 * @param {number} near   Jarak near clipping plane (objek lebih dekat dari ini tidak terlihat)
 * @param {number} far    Jarak far clipping plane (objek lebih jauh dari ini tidak terlihat)
 * @returns {Float32Array} Matriks proyeksi orthographic 4×4 (column-major)
 */
export function createOrthographicMatrix(left, right, bottom, top, near, far) {
    // Pre-hitung pembagi untuk menghindari pembagian berulang
    const rl = right - left;   // rentang horizontal
    const tb = top - bottom;   // rentang vertikal
    const fn = far - near;     // rentang kedalaman

    // Matriks disimpan dalam column-major (kolom 0, 1, 2, 3)
    return new Float32Array([
        // Kolom 0: skala X
        2 / rl, 0, 0, 0,

        // Kolom 1: skala Y
        0, 2 / tb, 0, 0,

        // Kolom 2: skala Z (negatif karena OpenGL menggunakan right-hand coordinate)
        0, 0, -2 / fn, 0,

        // Kolom 3: translasi ke NDC center (W tetap 1 karena orthographic)
        -(right + left) / rl,
        -(top + bottom) / tb,
        -(far + near) / fn,
        1
    ]);
}

/**
 * Membuat matriks translasi 4×4.
 *
 * PENGARUH TRANSLASI TERHADAP PANNING:
 * ─────────────────────────────────────────────────────────────────────────────
 * Translasi memindahkan seluruh objek dalam ruang 3D. Pada engine ini,
 * translasi panning diterapkan SETELAH rotasi isometric (dalam ruang view),
 * bukan sebelumnya (dalam ruang dunia).
 *
 * Ini menyebabkan arah panning selalu SEJAJAR DENGAN LAYAR:
 * - panX positif → semua objek bergeser ke KANAN layar
 * - panY positif → semua objek bergeser ke ATAS layar
 *
 * Jika panning diterapkan dalam ruang dunia (sebelum rotasi), arahnya akan
 * mengikuti sumbu 3D dunia yang TIDAK sejajar layar setelah isometric rotation.
 *
 * Matriks translasi (baris × kolom):
 * ┌ 1  0  0  tx ┐
 * │ 0  1  0  ty │
 * │ 0  0  1  tz │
 * └ 0  0  0  1  ┘
 *
 * @param {number} tx Translasi sumbu X (positif = geser kanan)
 * @param {number} ty Translasi sumbu Y (positif = geser atas)
 * @param {number} tz Translasi sumbu Z (positif = geser depan)
 * @returns {Float32Array} Matriks translasi 4×4 (column-major)
 */
export function createTranslationMatrix(tx, ty, tz) {
    return new Float32Array([
        1,  0,  0,  0,  // kolom 0
        0,  1,  0,  0,  // kolom 1
        0,  0,  1,  0,  // kolom 2
        tx, ty, tz, 1   // kolom 3: nilai translasi ada di sini (column-major)
    ]);
}

/**
 * Membuat matriks rotasi terhadap sumbu X sebesar sudut tertentu.
 *
 * Rotasi X digunakan untuk "memiringkan" pandangan kamera ke bawah.
 * Pada kamera isometric, rotasi X sebesar 35.264° menghasilkan sudut
 * tilt yang sempurna sehingga semua sumbu terlihat sama panjang di layar.
 *
 * Matriks rotasi X (baris × kolom):
 * ┌ 1    0       0      0 ┐
 * │ 0    cos(a)  -sin(a) 0 │
 * │ 0    sin(a)  cos(a)  0 │
 * └ 0    0       0      1 ┘
 *
 * @param {number} angleRad Sudut rotasi dalam RADIAN
 * @returns {Float32Array} Matriks rotasi X 4×4 (column-major)
 */
export function createRotationXMatrix(angleRad) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);

    // Perhatikan perbedaan row-major vs column-major:
    // Dalam row-major, baris ke-2 adalah [0, cos, -sin, 0]
    // Dalam column-major (WebGL), kolom ke-1 adalah [0, cos, sin, 0]
    // dan kolom ke-2 adalah [0, -sin, cos, 0]
    return new Float32Array([
        1,  0,  0,  0,  // kolom 0
        0,  c,  s,  0,  // kolom 1: cos dan sin dibalik posisinya karena column-major
        0, -s,  c,  0,  // kolom 2
        0,  0,  0,  1   // kolom 3
    ]);
}

/**
 * Membuat matriks rotasi terhadap sumbu Y sebesar sudut tertentu.
 *
 * Rotasi Y 45° adalah langkah pertama pembentukan tampilan isometric.
 * Rotasi ini memutar peta secara horizontal sehingga kita melihat dari
 * sudut "diagonal" — sumbu X dan Z dunia terlihat simetris dari layar,
 * membentuk tampilan berlian khas isometric medieval.
 *
 * Matriks rotasi Y (baris × kolom):
 * ┌  cos(a)  0  sin(a)  0 ┐
 * │  0       1  0       0 │
 * │ -sin(a)  0  cos(a)  0 │
 * └  0       0  0       1 ┘
 *
 * @param {number} angleRad Sudut rotasi dalam RADIAN
 * @returns {Float32Array} Matriks rotasi Y 4×4 (column-major)
 */
export function createRotationYMatrix(angleRad) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);

    return new Float32Array([
        c,  0, -s,  0,  // kolom 0
        0,  1,  0,  0,  // kolom 1
        s,  0,  c,  0,  // kolom 2
        0,  0,  0,  1   // kolom 3
    ]);
}

/**
 * Membuat matriks skala 4×4.
 *
 * Digunakan untuk memperbesar/memperkecil objek secara individual
 * tanpa mengubah posisinya. Dapat dikombinasikan dengan matriks lain
 * sebagai bagian dari transformasi model.
 *
 * @param {number} sx Faktor skala sumbu X (1.0 = ukuran asli)
 * @param {number} sy Faktor skala sumbu Y (1.0 = ukuran asli)
 * @param {number} sz Faktor skala sumbu Z (1.0 = ukuran asli)
 * @returns {Float32Array} Matriks skala 4×4 (column-major)
 */
export function createScaleMatrix(sx, sy, sz) {
    return new Float32Array([
        sx,  0,   0,   0,  // kolom 0
        0,   sy,  0,   0,  // kolom 1
        0,   0,   sz,  0,  // kolom 2
        0,   0,   0,   1   // kolom 3
    ]);
}

/**
 * Mengalikan dua matriks 4×4: C = A × B.
 *
 * URUTAN PERKALIAN MATRIKS (SANGAT PENTING):
 * ─────────────────────────────────────────────────────────────────────────────
 * Perkalian matriks TIDAK komutatif: (A × B) ≠ (B × A)
 *
 * Dalam pipeline grafika komputer, urutan transformasi standar adalah:
 * gl_Position = Projection × View × Model × vertex
 *
 * Dibaca dari KANAN KE KIRI (urutan penerapan ke vertex):
 * 1. Model (M): posisikan dan orientasikan objek di dunia
 * 2. View  (V): transformasikan ke ruang kamera
 * 3. Projection (P): proyeksikan ke layar 2D
 *
 * Pada engine ini, untuk kamera isometric:
 * VP = Projection × T_pan × RotX × RotY
 * Dibaca kanan ke kiri: Ry → Rx → T_pan → P
 *
 * IMPLEMENTASI COLUMN-MAJOR:
 * ─────────────────────────────────────────────────────────────────────────────
 * Elemen baris r, kolom c tersimpan di index: c * 4 + r
 *
 * C[col][row] = Σ(k=0..3) A[k][row] × B[col][k]
 * Dalam flat array: C[col*4+row] = Σ A[k*4+row] × B[col*4+k]
 *
 * @param {Float32Array} a Matriks 4×4 kiri
 * @param {Float32Array} b Matriks 4×4 kanan
 * @returns {Float32Array} Hasil perkalian a × b
 */
export function multiplyMatrix4(a, b) {
    const result = new Float32Array(16);

    // Iterasi setiap elemen output result[col][row]
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            // Dot product antara baris `row` dari A dan kolom `col` dari B
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                // A[k][row] dalam column-major = a[k*4 + row]
                // B[col][k] dalam column-major = b[col*4 + k]
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            result[col * 4 + row] = sum;
        }
    }

    return result;
}

// =============================================================================
// BAGIAN 2: SHADER WEBGL DASAR
// =============================================================================

/**
 * Vertex Shader Source — GLSL ES 1.00
 *
 * Vertex shader dieksekusi GPU untuk SETIAP vertex objek yang digambar.
 * Tugasnya adalah mentransformasi posisi vertex dari ruang model/dunia
 * ke ruang klip (clip space) menggunakan matriks View-Projection.
 *
 * Variabel:
 * - `aPosition` (attribute): posisi vertex 3D dalam ruang model
 * Dikirim dari VBO (Vertex Buffer Object) di JavaScript.
 * - `uViewProjectionMatrix` (uniform): matriks gabungan VP dari kamera
 * Nilai yang sama untuk semua vertex dalam satu draw call.
 * - `gl_Position` (built-in output): posisi akhir dalam clip space [-1,1]³
 *
 * Transformasi: gl_Position = VP × vec4(aPosition, 1.0)
 * Nilai w=1.0 pada input menandakan ini adalah titik (bukan vektor arah).
 */
const VERTEX_SHADER_SOURCE = `
    attribute vec3 aPosition;

    uniform mat4 uViewProjectionMatrix;

    void main(void) {
        /* Transformasi posisi vertex dari ruang model ke clip space.
           Urutan perkalian: VP pertama (kiri), vertex terakhir (kanan).
           WebGL/GLSL secara otomatis menggunakan konvensi column-major
           untuk gl.uniformMatrix4fv. */
        gl_Position = uViewProjectionMatrix * vec4(aPosition, 1.0);
    }
`;

/**
 * Fragment Shader Source — GLSL ES 1.00
 *
 * Fragment shader dieksekusi GPU untuk SETIAP piksel (fragment) yang
 * dihasilkan oleh rasterisasi objek. Tugasnya adalah menentukan warna
 * final setiap piksel.
 *
 * Pada tahap awal ini, warna diambil dari uniform `uColor` yang
 * dikirimkan dari JavaScript. Pada pengembangan selanjutnya, ini bisa
 * diganti dengan tekstur sampler untuk rendering tilemap/sprite.
 *
 * `precision mediump float` — deklarasi presisi floating-point.
 * mediump (medium precision) adalah keseimbangan antara akurasi dan
 * performa untuk GPU mobile/integrated.
 */
const FRAGMENT_SHADER_SOURCE = `
    precision mediump float;

    uniform vec4 uColor;

    void main(void) {
        /* Output warna fragment: RGBA dari uniform.
           Nilai alpha (komponen keempat) digunakan oleh blend function
           yang sudah diaktifkan di inisialisasi (gl.BLEND). */
        gl_FragColor = uColor;
    }
`;

/**
 * Mengkompilasi satu shader GLSL dan mengembalikan objek WebGLShader.
 *
 * Validasi error dilakukan karena kesalahan GLSL tidak melempar exception
 * biasa di JavaScript — shader "gagal diam-diam" tanpa pesan kecuali
 * kita secara eksplisit mengecek gl.COMPILE_STATUS.
 *
 * @param {WebGLRenderingContext} gl Konteks WebGL
 * @param {string} source           Kode GLSL shader
 * @param {number} type             gl.VERTEX_SHADER atau gl.FRAGMENT_SHADER
 * @returns {WebGLShader|null}      Shader object yang sudah dikompilasi, atau null jika gagal
 */
function compileShader(gl, source, type) {
    // Buat objek shader kosong di GPU
    const shader = gl.createShader(type);

    if (!shader) {
        console.error('[engine.js] Gagal membuat objek shader WebGL di GPU.');
        return null;
    }

    // Pasang source code GLSL ke objek shader
    gl.shaderSource(shader, source);

    // Instruksikan GPU untuk mengkompilasi GLSL ke kode GPU-native
    gl.compileShader(shader);

    // Periksa status kompilasi — WAJIB, karena error tidak otomatis dilempar
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const shaderTypeName = (type === gl.VERTEX_SHADER) ? 'Vertex Shader' : 'Fragment Shader';
        const errorLog = gl.getShaderInfoLog(shader);
        console.error(`[engine.js] GAGAL mengkompilasi ${shaderTypeName}:`);
        console.error(errorLog);

        // Hapus shader yang gagal untuk mencegah memory leak di GPU
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}

/**
 * Membuat dan me-link shader program WebGL dari vertex dan fragment shader.
 *
 * Shader program adalah "paket pipeline GPU" yang menggabungkan vertex shader
 * dan fragment shader menjadi satu unit yang bisa diaktifkan dengan gl.useProgram().
 *
 * Proses lengkap:
 * 1. Kompilasi vertex shader
 * 2. Kompilasi fragment shader
 * 3. Attach kedua shader ke program
 * 4. Link program (menggabungkan output VS dengan input FS, alokasi register)
 * 5. Validasi link status
 * 6. Hapus shader intermediate (sudah ter-embed di program)
 *
 * @param {WebGLRenderingContext} gl  Konteks WebGL
 * @param {string} vsSource          Source code vertex shader (GLSL)
 * @param {string} fsSource          Source code fragment shader (GLSL)
 * @returns {WebGLProgram|null}      Program yang siap digunakan, atau null jika gagal
 */
function createShaderProgram(gl, vsSource, fsSource) {
    // Kompilasi kedua shader
    const vertexShader   = compileShader(gl, vsSource, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(gl, fsSource, gl.FRAGMENT_SHADER);

    // Batalkan jika salah satu shader gagal dikompilasi
    if (!vertexShader || !fragmentShader) {
        console.error('[engine.js] Shader program tidak dapat dibuat karena kompilasi shader gagal.');
        if (vertexShader)   gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
        return null;
    }

    // Buat objek program di GPU
    const program = gl.createProgram();

    if (!program) {
        console.error('[engine.js] Gagal membuat objek WebGLProgram.');
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return null;
    }

    // Attach shader ke program
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    // Link: hubungkan output vertex shader ke input fragment shader,
    // alokasikan register GPU, dan validasi kompatibilitas antar shader
    gl.linkProgram(program);

    // Cek status link
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const errorLog = gl.getProgramInfoLog(program);
        console.error('[engine.js] GAGAL me-link shader program:');
        console.error(errorLog);
        gl.deleteProgram(program);
        return null;
    }

    // Hapus shader objects setelah berhasil di-link.
    // Kode GLSL sudah ter-embed di dalam program — objek shader tidak lagi diperlukan.
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    return program;
}

// =============================================================================
// BAGIAN 3: KAMERA ISOMETRIC
// =============================================================================

/**
 * Membuat objek state kamera dengan nilai awal default.
 *
 * Objek ini adalah "pusat kendali" kamera engine. Semua parameter
 * yang mempengaruhi tampilan disimpan di sini agar bisa diakses dan
 * dimodifikasi dari mana saja (event listener, AI, animasi, dll).
 *
 * @returns {Object} cameraState lengkap dengan semua field yang diperlukan
 */
function createCameraState() {
    return {
        // Faktor zoom saat ini. zoom=1.0 → tampilkan BASE_VIEW_SIZE unit
        zoom: 1.0,

        // Offset panning dalam satuan ruang view (bukan pixel layar).
        // Nilai ini diubah saat pengguna drag mouse.
        panX: 0.0,
        panY: 0.0,

        // State dragging untuk kontrol panning dengan mouse
        isDragging:  false,
        lastMouseX:  0,
        lastMouseY:  0,

        /**
         * FLAG DIRTY — Inti Optimasi Engine
         * ───────────────────────────────────────────────────────────────────
         * isDirty = true  → matriks kamera PERLU dihitung ulang sebelum render
         * isDirty = false → matriks kamera masih valid, SKIP kalkulasi
         *
         * Kapan isDirty di-set true:
         * - Zoom berubah (event scroll)
         * - Pan berubah (event mouse drag)
         * - Ukuran canvas berubah (ResizeObserver)
         * - Inisialisasi pertama
         *
         * Tanpa optimasi ini, engine akan melakukan 6 perkalian matriks
         * di setiap frame (~60 kali/detik), bahkan saat kamera diam.
         * Dengan dirty flag, kalkulasi hanya terjadi saat BENAR-BENAR ada perubahan.
         */
        isDirty: true,

        /**
         * Matriks View-Projection gabungan (Float32Array, 16 elemen, column-major).
         * Dihitung oleh updateCameraMatrix() dan di-upload ke GPU via uniform.
         * Nilai awal: matriks identitas (akan segera di-update karena isDirty=true)
         */
        viewProjectionMatrix: createIdentityMatrix()
    };
}

/**
 * Menghitung ulang matriks View-Projection kamera isometric.
 *
 * Fungsi ini adalah jantung kamera engine. Hanya dipanggil saat
 * cameraState.isDirty === true untuk menghemat CPU.
 *
 * URUTAN TRANSFORMASI DAN LOGIKA MATRIKS:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * VP = P × T_pan × Rx × Ry
 *
 * Dibaca dari KANAN KE KIRI (urutan penerapan ke setiap vertex):
 *
 * Step 1 — Ry (Rotasi Y 45°):
 * Putar seluruh dunia 45° di sumbu Y.
 * Hasil: sumbu X dan Z tampak diagonal simetris dari layar.
 * Ini menciptakan tampilan "berlian" khas isometric.
 *
 * Step 2 — Rx (Rotasi X 35.264°):
 * Miringkan tampilan ke bawah sebesar 35.264°.
 * Sudut ini = arctan(1/√2), yang membuat ketiga sumbu (X,Y,Z)
 * terproyeksi dengan PANJANG SAMA di layar (true isometric).
 *
 * Step 3 — T_pan (Translasi):
 * Geser tampilan untuk panning. Diterapkan SETELAH rotasi isometric
 * sehingga arah pan SEJAJAR dengan layar (screen-aligned), bukan
 * mengikuti sumbu 3D dunia yang sudah dirotasi.
 *
 * Step 4 — P (Orthographic Projection):
 * Peta frustum 3D ke layar 2D tanpa efek perspektif.
 * Window orthographic disesuaikan dengan zoom dan aspek rasio.
 *
 * @param {WebGLRenderingContext} gl  Konteks WebGL
 * @param {Object} cameraState        State kamera yang akan diperbarui
 * @param {number} canvasWidth        Lebar canvas dalam piksel
 * @param {number} canvasHeight       Tinggi canvas dalam piksel
 */
export function updateCameraMatrix(gl, cameraState, canvasWidth, canvasHeight) {
    const { zoom, panX, panY } = cameraState;

    // Hitung aspek rasio untuk mencegah distorsi pada canvas non-persegi
    const aspect = canvasWidth / canvasHeight;

    // Hitung setengah dimensi window orthographic berdasarkan zoom.
    // halfH = BASE_VIEW_SIZE / zoom:
    //   zoom=1  → halfH=10.0 (normal)
    //   zoom=2  → halfH=5.0  (zoom in, area tampil lebih sempit)
    //   zoom=0.5 → halfH=20.0 (zoom out, area tampil lebih lebar)
    const halfH = BASE_VIEW_SIZE / zoom;
    const halfW = halfH * aspect; // sesuaikan lebar dengan aspek rasio

    // ── Bangun komponen-komponen matriks ──────────────────────────────────

    // P: Proyeksi orthographic
    // Memetakan [-halfW, halfW] × [-halfH, halfH] ke NDC [-1,1]²
    // near/far diperluas untuk menampung bangunan tinggi sekalipun
    const matProj = createOrthographicMatrix(
        -halfW,  halfW,
        -halfH,  halfH,
        -100.0,  100.0
    );

    // Ry: Rotasi Y 45° — tampilan diagonal isometric
    const matRotY = createRotationYMatrix(ISO_ANGLE_Y);

    // Rx: Rotasi X 35.264° — kemiringan isometric sempurna
    const matRotX = createRotationXMatrix(ISO_ANGLE_X);

    // T: Translasi panning dalam ruang VIEW (setelah isometric rotation)
    // panX/panY berada dalam satuan world units (bukan pixel)
    const matPan = createTranslationMatrix(panX, panY, 0.0);

    // ── Kalkulasi VP = P × T_pan × Rx × Ry ───────────────────────────────

    // Langkah 1: Gabungkan kedua rotasi isometric
    const matIsoView = multiplyMatrix4(matRotX, matRotY);

    // Langkah 2: Tambahkan panning (dalam view space, setelah rotasi)
    const matViewWithPan = multiplyMatrix4(matPan, matIsoView);

    // Langkah 3: Terapkan proyeksi orthographic
    cameraState.viewProjectionMatrix = multiplyMatrix4(matProj, matViewWithPan);

    // ── Reset dirty flag ──────────────────────────────────────────────────
    // Matriks sudah segar. isDirty akan di-set true kembali
    // oleh event handler kamera jika ada perubahan.
    cameraState.isDirty = false;
}

// =============================================================================
// BAGIAN 4: KONTROL KAMERA (MOUSE)
// =============================================================================

/**
 * Memasang event listener kontrol kamera interaktif pada canvas WebGL.
 *
 * Kontrol yang tersedia:
 * ─────────────────────────────────────────────────────────────────────────────
 * SCROLL WHEEL → Zoom in / zoom out
 * MOUSE DRAG   → Panning peta (geser tampilan)
 *
 * PRINSIP DIRTY FLAG PADA EVENT HANDLER:
 * ─────────────────────────────────────────────────────────────────────────────
 * Setiap event handler yang mengubah state kamera WAJIB mengeset
 * cameraState.isDirty = true. Ini adalah sinyal ke render loop untuk
 * menghitung ulang matriks VP pada frame berikutnya.
 *
 * Event handler sengaja dibuat SESEDERHANA MUNGKIN — hanya mengupdate state
 * dan set flag. Kalkulasi berat (matriks) dilakukan secara terpisah di
 * beginFrame() hanya saat diperlukan.
 *
 * @param {HTMLCanvasElement} canvas  Elemen canvas WebGL yang aktif
 * @param {Object} cameraState        Objek state kamera yang akan dimodifikasi
 */
export function setupCameraControls(canvas, cameraState) {

    // ──────────────────────────────────────────────────────────────────────
    // SCROLL WHEEL — Zoom In / Zoom Out
    // ──────────────────────────────────────────────────────────────────────
    canvas.addEventListener('wheel', function (e) {
        // Cegah default browser action (scroll halaman) saat kursor di canvas
        e.preventDefault();

        // Tentukan arah zoom berdasarkan arah scroll:
        // deltaY > 0 → scroll ke bawah  → zoom out (peta menjauh)
        // deltaY < 0 → scroll ke atas   → zoom in  (peta mendekat)
        const direction = e.deltaY > 0 ? -1 : 1;

        // Update zoom dengan batas minimum dan maksimum
        // Math.max dan Math.min memastikan zoom tidak keluar dari range
        cameraState.zoom = Math.max(
            ZOOM_MIN,
            Math.min(ZOOM_MAX, cameraState.zoom + direction * ZOOM_SPEED)
        );

        // Tandai kamera perlu update pada frame berikutnya
        cameraState.isDirty = true;

    }, { passive: false });
    // passive: false WAJIB agar e.preventDefault() berfungsi pada event wheel


    // ──────────────────────────────────────────────────────────────────────
    // MOUSE DOWN — Mulai Sesi Panning
    // ──────────────────────────────────────────────────────────────────────
    canvas.addEventListener('mousedown', function (e) {
        // Hanya aktifkan drag untuk tombol kiri (button === 0)
        // Tombol tengah (1) dan kanan (2) diabaikan
        if (e.button === 0) {
            cameraState.isDragging  = true;
            cameraState.lastMouseX  = e.clientX;
            cameraState.lastMouseY  = e.clientY;

            // Feedback visual: ubah kursor ke "grabbing hand"
            canvas.style.cursor = 'grabbing';
        }
    });


    // ──────────────────────────────────────────────────────────────────────
    // MOUSE MOVE — Eksekusi Panning selama Drag
    // ──────────────────────────────────────────────────────────────────────
    canvas.addEventListener('mousemove', function (e) {
        // Hanya proses jika sedang dalam mode drag aktif
        if (!cameraState.isDragging) return;

        // Hitung delta pergerakan mouse dari posisi terakhir (dalam pixel)
        const dx = e.clientX - cameraState.lastMouseX;
        const dy = e.clientY - cameraState.lastMouseY;

        // Perbarui posisi mouse terakhir untuk frame mousemove berikutnya
        cameraState.lastMouseX = e.clientX;
        cameraState.lastMouseY = e.clientY;

        // ── Konversi delta pixel ke satuan ruang view ──────────────────────
        //
        // Tujuan: panning terasa 1:1 dengan pergerakan mouse — dunia mengikuti
        // kursor persis seperti "menggenggam dan menarik" peta.
        //
        // Rumus konversi:
        //   Lebar canvas (pixel) ↔ 2 * halfW (world units)
        //   Tinggi canvas (pixel) ↔ 2 * halfH (world units)
        //   halfH = BASE_VIEW_SIZE / zoom
        //
        //   panDelta_x = (dx / canvasW) × (2 × halfW)
        //   panDelta_y = (dy / canvasH) × (2 × halfH) × (-1)   ← Y dibalik
        //
        // Mengapa Y dibalik?
        //   Koordinat screen Y bertambah ke BAWAH (0 di atas, max di bawah).
        //   Koordinat view Y bertambah ke ATAS (konvensi OpenGL).
        //   Jadi dy > 0 (geser ke bawah) → panY harus berkurang.

        const canvasW = canvas.clientWidth;
        const canvasH = canvas.clientHeight;
        const aspect  = canvasW / canvasH;
        const halfH   = BASE_VIEW_SIZE / cameraState.zoom;
        const halfW   = halfH * aspect;

        // Delta panning dalam satuan world units (terskala ke ukuran view)
        const panDeltaX =  (dx / canvasW) * (2.0 * halfW);
        const panDeltaY = -(dy / canvasH) * (2.0 * halfH); // Y dibalik

        // Akumulasikan perubahan pan
        cameraState.panX += panDeltaX;
        cameraState.panY += panDeltaY;

        // Tandai kamera kotor — matriks VP perlu dihitung ulang
        cameraState.isDirty = true;
    });


    // ──────────────────────────────────────────────────────────────────────
    // MOUSE UP — Akhiri Sesi Panning
    // ──────────────────────────────────────────────────────────────────────
    canvas.addEventListener('mouseup', function (e) {
        if (e.button === 0) {
            cameraState.isDragging = false;
            canvas.style.cursor    = 'grab';
        }
    });


    // ──────────────────────────────────────────────────────────────────────
    // MOUSE LEAVE — Paksa Akhiri Drag jika Kursor Keluar Canvas
    // ──────────────────────────────────────────────────────────────────────
    // Tanpa ini, jika pengguna melepaskan mouse di LUAR canvas saat dragging,
    // engine tidak menerima event 'mouseup', sehingga isDragging tetap true.
    // Hasilnya: saat kursor masuk kembali ke canvas, peta "melompat" tiba-tiba.
    canvas.addEventListener('mouseleave', function () {
        cameraState.isDragging = false;
        canvas.style.cursor    = 'grab';
    });

    // Kursor default: grab hand menunjukkan canvas bisa dipan
    canvas.style.cursor = 'grab';
}

// =============================================================================
// BAGIAN 5: INISIALISASI WEBGL UTAMA
// =============================================================================

/**
 * Menginisialisasi seluruh WebGL engine dan mengembalikan objek engine siap pakai.
 *
 * Fungsi ini adalah entry point utama — panggil ini dari main.js untuk
 * mendapatkan semua yang diperlukan untuk rendering.
 *
 * Urutan proses inisialisasi:
 * 1. Ambil elemen canvas dari DOM berdasarkan ID
 * 2. Ambil konteks WebGL 1.0
 * 3. Sinkronisasi ukuran canvas (CSS size vs framebuffer size)
 * 4. Set viewport, clear color, dan state rendering
 * 5. Kompilasi shader program
 * 6. Ambil lokasi attribute dan uniform
 * 7. Buat state kamera default
 * 8. Hitung matriks kamera awal
 * 9. Upload matriks ke GPU
 * 10. Pasang kontrol kamera mouse
 * 11. Daftarkan ResizeObserver untuk handling resize window
 *
 * @param {string} canvasId  ID elemen HTML canvas (contoh: 'gameCanvas')
 * @returns {Object|null}    Objek engine siap pakai, atau null jika inisialisasi gagal
 */
export function initWebGL(canvasId) {

    // ── Ambil Elemen Canvas dari DOM ──────────────────────────────────────
    const canvas = document.getElementById(canvasId);

    if (!canvas) {
        console.error(`[engine.js] GAGAL: Elemen canvas dengan ID "${canvasId}" tidak ditemukan di DOM.`);
        console.error('[engine.js] Pastikan HTML memiliki: <canvas id="' + canvasId + '"></canvas>');
        return null;
    }

    // ── Ambil Konteks WebGL 1.0 ───────────────────────────────────────────
    //
    // Menggunakan WebGL 1.0 (bukan WebGL 2.0) karena:
    // - Kompatibilitas lebih luas di hardware lama dan GPU terintegrasi
    // - Cukup untuk kebutuhan rendering 2.5D isometric ini
    // - Hindari fitur WebGL2 yang tidak diperlukan (UBO, MSAA, dll)
    //
    // Opsi konteks:
    // - antialias: false → matikan anti-aliasing bawaan
    //   (untuk peta tile/piksel, AA justru mengaburkan tepi tile)
    // - depth: true → aktifkan depth buffer untuk depth testing
    // - alpha: false → canvas tidak transparan, hemat memori
    const gl = canvas.getContext('webgl', {
        antialias: false,
        depth:     true,
        alpha:     false
    });

    if (!gl) {
        console.error('[engine.js] GAGAL: WebGL tidak tersedia.');
        console.error('[engine.js] Kemungkinan penyebab:');
        console.error('  - Browser tidak mendukung WebGL (update browser Anda)');
        console.error('  - Driver GPU tidak kompatibel atau perlu update');
        console.error('  - WebGL dinonaktifkan di pengaturan browser');
        console.error('  - Hardware terlalu lama (sangat jarang)');
        return null;
    }

    // Tampilkan info GPU untuk debugging
    const renderer = gl.getParameter(gl.RENDERER);
    const vendor   = gl.getParameter(gl.VENDOR);
    console.log(`[engine.js] WebGL berhasil diinisialisasi.`);
    console.log(`[engine.js] GPU Renderer : ${renderer}`);
    console.log(`[engine.js] GPU Vendor   : ${vendor}`);

    // ── Sinkronisasi Ukuran Canvas ────────────────────────────────────────
    //
    // canvas.clientWidth/clientHeight = ukuran elemen di CSS (tampilan)
    // canvas.width/height             = resolusi framebuffer (piksel nyata)
    // Keduanya harus sama agar tidak terjadi stretching/blurring
    canvas.width  = canvas.clientWidth  || 800;
    canvas.height = canvas.clientHeight || 600;

    // Viewport mendefinisikan area piksel pada canvas yang digunakan WebGL
    gl.viewport(0, 0, canvas.width, canvas.height);

    // ── Clear Color: Hijau Rumput Medieval ────────────────────────────────
    // RGB(34, 85, 34) = warna hijau gelap seperti rumput/tanah untuk latar
    // peta medieval. Dinormalisasi ke [0.0, 1.0] untuk WebGL.
    // Formula: nilai_asli / 255
    //   34/255 ≈ 0.133  (R)
    //   85/255 ≈ 0.333  (G)
    //   34/255 ≈ 0.133  (B)
    gl.clearColor(0.133, 0.333, 0.133, 1.0);

    // ── Aktifkan Depth Test ───────────────────────────────────────────────
    //
    // Depth test memungkinkan WebGL menentukan objek mana yang berada
    // "di depan" dengan membandingkan nilai kedalaman (depth/Z).
    // Ini PENTING untuk rendering 2.5D isometric agar:
    //   - Bangunan/pohon di depan menutup objek di belakangnya
    //   - Tile lantai tidak menimpa bangunan di atasnya
    //
    // gl.LEQUAL: fragment yang memiliki depth LEBIH KECIL ATAU SAMA
    // dengan nilai di depth buffer akan digambar.
    // Dipilih dibanding gl.LESS karena tile di ketinggian yang sama
    // perlu bisa di-redraw tanpa z-fighting.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // ── Aktifkan Alpha Blending ────────────────────────────────────────────
    // Untuk sprite dengan piksel transparan (PNG dengan alpha channel).
    // Formula: output = src_alpha × src_color + (1 - src_alpha) × dst_color
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // ── Kompilasi dan Link Shader Program ────────────────────────────────
    const shaderProgram = createShaderProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);

    if (!shaderProgram) {
        console.error('[engine.js] GAGAL: Inisialisasi engine dibatalkan karena shader program tidak bisa dibuat.');
        return null;
    }

    // Aktifkan shader program sebagai program rendering yang sedang digunakan
    gl.useProgram(shaderProgram);
    console.log('[engine.js] Shader program berhasil dikompilasi dan di-link.');

    // ── Ambil Lokasi Attribute dan Uniform ───────────────────────────────
    //
    // Attribute: data yang berbeda per-vertex (posisi, warna, UV coords)
    //   Diambil dengan getAttribLocation() → mengembalikan integer index
    //   Nilai -1 berarti nama attribute tidak ditemukan di shader
    //
    // Uniform: data yang sama untuk semua vertex/fragment dalam satu draw call
    //   Diambil dengan getUniformLocation() → mengembalikan WebGLUniformLocation
    //   Nilai null berarti nama uniform tidak ditemukan di shader
    const locations = {
        // Attribute untuk posisi vertex 3D
        aPosition: gl.getAttribLocation(shaderProgram, 'aPosition'),

        // Uniform untuk matriks View-Projection kamera isometric
        uViewProjectionMatrix: gl.getUniformLocation(shaderProgram, 'uViewProjectionMatrix'),

        // Uniform untuk warna fill objek (RGBA)
        uColor: gl.getUniformLocation(shaderProgram, 'uColor')
    };

    // Validasi lokasi — log peringatan jika ada yang hilang
    if (locations.aPosition < 0) {
        console.warn('[engine.js] Peringatan: Attribute "aPosition" tidak ditemukan di vertex shader.');
        console.warn('[engine.js] Pastikan shader mengandung: attribute vec3 aPosition;');
    }
    if (!locations.uViewProjectionMatrix) {
        console.warn('[engine.js] Peringatan: Uniform "uViewProjectionMatrix" tidak ditemukan di shader.');
    }
    if (!locations.uColor) {
        console.warn('[engine.js] Peringatan: Uniform "uColor" tidak ditemukan di fragment shader.');
    }

    // Set warna default: putih solid
    gl.uniform4f(locations.uColor, 1.0, 1.0, 1.0, 1.0);

    // ── Buat State Kamera Default ─────────────────────────────────────────
    const cameraState = createCameraState();

    // Hitung matriks kamera awal (isDirty dimulai true)
    updateCameraMatrix(gl, cameraState, canvas.width, canvas.height);

    // Upload matriks awal ke GPU
    // false = tidak transpose (matriks sudah dalam format column-major)
    gl.uniformMatrix4fv(
        locations.uViewProjectionMatrix,
        false,
        cameraState.viewProjectionMatrix
    );

    // ── Pasang Kontrol Kamera Mouse ───────────────────────────────────────
    setupCameraControls(canvas, cameraState);

    // ── Handle Perubahan Ukuran Window (ResizeObserver) ───────────────────
    //
    // Saat browser di-resize, ukuran elemen canvas bisa berubah.
    // Tanpa handling ini, rendering akan terdistorsi (stretch/squish).
    // ResizeObserver lebih efisien dari window.onresize karena hanya
    // memantau elemen canvas spesifik, bukan seluruh window.
    const resizeObserver = new ResizeObserver(function () {
        const newW = canvas.clientWidth;
        const newH = canvas.clientHeight;

        // Hanya update jika ukuran benar-benar berubah
        if (newW !== canvas.width || newH !== canvas.height) {
            canvas.width  = newW;
            canvas.height = newH;

            // Sync viewport WebGL ke ukuran canvas baru
            gl.viewport(0, 0, canvas.width, canvas.height);

            // Tandai kamera dirty karena aspek rasio mungkin berubah
            cameraState.isDirty = true;

            console.log(`[engine.js] Canvas di-resize ke ${newW}×${newH}px`);
        }
    });
    resizeObserver.observe(canvas);

    console.log('[engine.js] Engine siap. Canvas:', canvas.width, '×', canvas.height, 'px');

    // ── Kembalikan Objek Engine ───────────────────────────────────────────
    //
    // Objek ini adalah "pegangan" ke seluruh engine dari file lain.
    // Simpan referensi ke objek ini di main.js untuk akses ke:
    //   - engine.gl           → untuk draw calls WebGL
    //   - engine.canvas       → untuk ukuran, event, dll
    //   - engine.shaderProgram → untuk useProgram jika ada multi-shader
    //   - engine.cameraState  → untuk baca/tulis state kamera
    //   - engine.locations    → untuk kirim data ke shader
    //   - engine.resizeObserver.disconnect() → cleanup jika diperlukan
    return {
        canvas,
        gl,
        shaderProgram,
        cameraState,
        locations,
        resizeObserver
    };
}

// =============================================================================
// BAGIAN 6: FUNGSI RENDER FRAME DASAR
// =============================================================================

/**
 * Memulai frame rendering baru: clear canvas dan update matriks kamera.
 *
 * Panggil fungsi ini di AWAL setiap iterasi render loop, sebelum draw calls.
 *
 * POLA PENGGUNAAN YANG BENAR (di main.js):
 * ─────────────────────────────────────────────────────────────────────────────
 * function renderLoop() {
 * beginFrame(engine.gl, engine.cameraState, engine.locations,
 * engine.canvas.width, engine.canvas.height);
 *
 * // --- Draw calls di sini ---
 * // gl.bindBuffer(...), gl.drawArrays(...), dll
 *
 * requestAnimationFrame(renderLoop);
 * }
 * renderLoop();
 *
 * DETAIL OPTIMASI DIRTY FLAG:
 * ─────────────────────────────────────────────────────────────────────────────
 * Matriks VP mengandung 3 perkalian matriks 4×4 (masing-masing 64 operasi
 * floating-point). Total: ~192 operasi FP per update matriks.
 *
 * Pada 60 FPS dengan kamera diam:
 * - Tanpa dirty flag : 192 × 60 = 11.520 op/detik (tidak perlu)
 * - Dengan dirty flag: 192 × 0  = 0 op/detik saat kamera diam ✓
 *
 * Saat kamera bergerak (misalnya drag selama 1 detik pada 60 FPS):
 * - Dengan dirty flag: 192 × 60 = 11.520 op (hanya saat perlu) ✓
 *
 * @param {WebGLRenderingContext} gl  Konteks WebGL
 * @param {Object} cameraState        State kamera isometric
 * @param {Object} locations          Objek berisi lokasi uniform/attribute shader
 * @param {number} canvasWidth        Lebar canvas saat ini (piksel)
 * @param {number} canvasHeight       Tinggi canvas saat ini (piksel)
 */
export function beginFrame(gl, cameraState, locations, canvasWidth, canvasHeight) {
    // ── Clear Buffer ──────────────────────────────────────────────────────
    //
    // Hapus color buffer → isi ulang dengan clearColor (hijau rumput)
    // Hapus depth buffer → reset semua nilai kedalaman ke 1.0 (max)
    // Keduanya HARUS di-clear setiap frame agar tidak ada "ghost" dari frame lalu
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // ── Update Matriks Kamera (hanya jika dirty) ──────────────────────────
    //
    // Cek isDirty SEBELUM memanggil updateCameraMatrix — ini adalah gatekeeper
    // optimasi dirty flag. Jika kamera tidak berubah sejak frame terakhir,
    // seluruh blok ini di-skip dan matriks lama di GPU tetap valid.
    if (cameraState.isDirty) {
        // Hitung ulang matriks VP berdasarkan state kamera terkini
        // (isDirty akan di-set false di dalam fungsi ini)
        updateCameraMatrix(gl, cameraState, canvasWidth, canvasHeight);

        // Upload matriks baru ke GPU shader uniform
        // Parameter false = jangan transpose (sudah column-major, sesuai WebGL)
        gl.uniformMatrix4fv(
            locations.uViewProjectionMatrix,
            false,
            cameraState.viewProjectionMatrix
        );
    }
    // Jika !isDirty: matriks di GPU masih valid dari frame sebelumnya.
    // Tidak perlu upload ulang — ini menghemat bandwidth CPU→GPU.
}

/**
 * Mengatur warna fill untuk draw call berikutnya.
 *
 * Fungsi helper yang menyederhanakan pengiriman warna ke fragment shader.
 * Panggil sebelum draw call jika ingin mengubah warna objek.
 *
 * Contoh penggunaan:
 * setColor(gl, locations, 0.8, 0.2, 0.1, 1.0); // merah brick medieval
 * gl.drawArrays(gl.TRIANGLES, 0, 3);            // gambar segitiga merah
 *
 * @param {WebGLRenderingContext} gl Konteks WebGL
 * @param {Object} locations         Objek lokasi uniform
 * @param {number} r  Komponen merah  [0.0 – 1.0]
 * @param {number} g  Komponen hijau  [0.0 – 1.0]
 * @param {number} b  Komponen biru   [0.0 – 1.0]
 * @param {number} [a=1.0] Komponen alpha [0.0 – 1.0] (1.0 = opak penuh)
 */
export function setColor(gl, locations, r, g, b, a = 1.0) {
    gl.uniform4f(locations.uColor, r, g, b, a);
}
