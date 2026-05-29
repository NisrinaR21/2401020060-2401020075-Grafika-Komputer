/**
 * ============================================================
 * main.js
 * Simulasi Tata Kota 2.5D Isometric Medieval
 * Grafika Komputer — WebGL | ES6 Modules | Vanilla JavaScript
 * ============================================================
 *
 * File ini berperan sebagai ENTRY POINT dan GAME LOOP CONTROLLER
 * dari seluruh aplikasi. Semua modul dihubungkan di sini, namun
 * detail implementasi masing-masing modul TIDAK ditulis di file ini.
 *
 * Prinsip Separation of Concerns:
 * engine.js     → inisialisasi WebGL, kamera, matriks, shader
 * renderer.js   → texture, buffer geometri, draw call
 * animation.js  → logika pergerakan dan animasi objek dinamis
 * main.js       → orkestrasi, game loop, state global, UI
 *
 * Mengapa main.js tidak mencampur logika shader, matriks, renderer,
 * dan animasi secara langsung?
 * Agar setiap modul dapat diuji, diperbaiki, dan dijelaskan
 * secara independen tanpa merusak modul lain. Ini adalah praktik
 * arsitektur perangkat lunak yang dikenal sebagai "modular design"
 * — setiap modul memiliki satu tanggung jawab yang jelas.
 */


// ============================================================
// BAGIAN 1: IMPORT MODUL
// ============================================================
// main.js hanya mengimpor dan memanggil fungsi dari modul lain.
// Tidak ada implementasi detail di dalam file ini.

// Dari engine.js:
//   initWebGL  → membuat context WebGL, mengkompilasi shader,
//                mengatur kamera orthographic-isometric, dan
//                mengembalikan objek dengan seluruh state engine.
//   beginFrame → membersihkan color buffer dan depth buffer,
//                lalu mengatur ulang matriks kamera di setiap frame.
import { initWebGL, beginFrame } from './engine.js';

// Dari renderer.js:
//   setupTexture        → membuat WebGL texture dari HTMLImageElement spritesheet
//   setupRoadGeometry   → membangun vertex buffer geometri jalan dari data JSON
//   setupSpriteGeometry → membangun vertex buffer sprite/bangunan dari data JSON
//   drawRoads           → mengirim draw call untuk semua geometri jalan ke GPU
//   drawSprites         → mengirim draw call untuk semua sprite dan bangunan ke GPU
//
// ASUMSI: Nama fungsi ini disepakati antara main.js dan renderer.js.
//         Jika nama berbeda di renderer.js, cukup sesuaikan nama impor di baris ini
//         tanpa mengubah logika di dalam main.js.
import {
    setupTexture,
    setupRoadGeometry,
    setupSpriteGeometry,
    drawRoads,
    drawSprites
} from './renderer.js';

// Dari animation.js:
//   updateAnimations → memperbarui posisi dan state semua objek bergerak
//                      berdasarkan delta time yang dihitung di main.js.
//                      Detail algoritma pergerakan sepenuhnya ada di animation.js.
//
// ASUMSI: Nama fungsi dapat juga berupa updateSimulation di animation.js.
//         Sesuaikan nama impor jika disepakati berbeda.
import { updateAnimations } from './animation.js';


// ============================================================
// BAGIAN 2: KONSTANTA KONFIGURASI GLOBAL
// ============================================================
// Semua nilai yang berpotensi berubah (ID elemen, path file)
// dikumpulkan sebagai konstanta di satu tempat agar mudah diganti
// tanpa harus mencari ke seluruh kode.

/** ID elemen <canvas> di HTML tempat WebGL merender output */
const CANVAS_ID = 'glCanvas';

/** Path relatif ke file data peta JSON */
const DATA_URL = './assets/data.json';

/** Path relatif ke file spritesheet PNG */
const SPRITESHEET_URL = './assets/spritesheet.png';

/** ID tombol Start/Pause di HTML */
const START_PAUSE_BUTTON_ID = 'btnStartPause';

/** ID tombol Acak Map di HTML */
const RANDOMIZE_MAP_BUTTON_ID = 'btnRandomizeMap';

/**
 * Batas maksimal delta time dalam satuan detik.
 * Mencegah "time jump" besar ketika tab browser sempat tidak aktif
 * lalu kembali aktif, yang bisa menyebabkan objek melompat jauh.
 * Nilai 0.1 berarti maksimum 100ms per frame dihitung oleh animasi.
 */
const MAX_DELTA_TIME = 0.1;


// ============================================================
// BAGIAN 3: FUNGSI ASSET LOADING ASYNCHRONOUS
// ============================================================
// Asset WAJIB dimuat sepenuhnya SEBELUM render loop dimulai.
//
// Mengapa tidak memuat asset di dalam render loop?
//   - Membuat texture WebGL baru setiap frame membuang memori GPU.
//   - fetch() di dalam loop akan mengirim permintaan jaringan berulang.
//   - Draw call yang dijalankan sebelum texture/data siap akan menghasilkan
//     artefak visual atau crash.
//   - Pada GPU terintegrasi seperti Intel Core i5-10310U, operasi
//     overhead harus diminimalkan agar performa tetap stabil.

/**
 * Memuat file JSON dari URL yang diberikan secara asynchronous.
 * Menggunakan fetch() karena mendukung async/await dan error handling
 * yang lebih informatif dibanding XMLHttpRequest.
 *
 * @param {string} url - URL atau path file JSON yang akan dimuat
 * @returns {Promise<Object>} Objek JavaScript hasil parsing JSON
 * @throws {Error} Jika permintaan HTTP gagal atau JSON tidak valid
 */
async function loadJSON(url) {
    try {
        const response = await fetch(url);

        // HTTP 200 OK bukan jaminan konten valid; status harus dicek eksplisit
        if (!response.ok) {
            throw new Error(
                `Permintaan HTTP gagal: "${url}" — Status ${response.status} (${response.statusText})`
            );
        }

        const data = await response.json();
        console.log(`[Asset] JSON berhasil dimuat: ${url}`);
        return data;

    } catch (error) {
        // Lempar ulang agar loadAssets() dapat menangkap dan menghentikan
        // seluruh proses inisialisasi jika JSON tidak dapat dimuat
        console.error(`[Asset] GAGAL memuat JSON dari "${url}":`, error);
        throw error;
    }
}

/**
 * Memuat file gambar (PNG/JPG) dari URL yang diberikan secara asynchronous.
 * Menggunakan objek Image() karena WebGL membutuhkan HTMLImageElement
 * — bukan ArrayBuffer atau Blob — untuk membuat texture melalui texImage2D().
 *
 * @param {string} url - URL atau path file gambar yang akan dimuat
 * @returns {Promise<HTMLImageElement>} Elemen gambar yang sudah ter-load sepenuhnya
 * @throws {Error} Jika gambar tidak dapat dimuat (file tidak ada, format tidak didukung)
 */
function loadImage(url) {
    // Membungkus event berbasis callback (onload/onerror) ke dalam Promise
    // agar dapat digunakan bersama async/await secara konsisten
    return new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = () => {
            console.log(`[Asset] Gambar berhasil dimuat: ${url} (${img.width}x${img.height}px)`);
            resolve(img);
        };

        img.onerror = () => {
            const err = new Error(`Gagal memuat gambar: "${url}" — File tidak ditemukan atau format tidak didukung.`);
            console.error(`[Asset] GAGAL memuat gambar "${url}":`, err);
            reject(err);
        };

        // Menetapkan src SETELAH handler terpasang agar tidak ada race condition
        img.src = url;
    });
}

/**
 * Memuat semua asset yang dibutuhkan aplikasi secara paralel.
 * Menggunakan Promise.all agar data.json dan spritesheet.png dimuat
 * secara bersamaan — lebih cepat daripada menunggu satu per satu.
 *
 * @returns {Promise<{mapData: Object, spritesheet: HTMLImageElement}>}
 * Objek berisi data peta dan elemen gambar spritesheet
 * @throws {Error} Jika salah satu atau kedua asset gagal dimuat
 */
async function loadAssets() {
    console.log('[Asset] Memulai proses loading semua asset secara paralel...');

    try {
        // Promise.all menjalankan kedua fetch/load secara bersamaan.
        // Jika salah satu gagal, seluruh Promise.all langsung reject (fail-fast).
        const [mapData, spritesheet] = await Promise.all([
            loadJSON(DATA_URL),
            loadImage(SPRITESHEET_URL)
        ]);

        console.log('[Asset] Semua asset berhasil dimuat dan siap digunakan.');
        return { mapData, spritesheet };

    } catch (error) {
        // Gagalkan proses loading secara keseluruhan agar aplikasi tidak
        // melanjutkan inisialisasi dengan data yang tidak lengkap
        console.error('[Asset] Proses loading GAGAL. Inisialisasi aplikasi dihentikan.', error);
        throw error;
    }
}


// ============================================================
// BAGIAN 4: DEKLARASI STATE UTAMA APLIKASI
// ============================================================
// State dikelola sebagai object literal sederhana (bukan class besar)
// agar mudah dibaca, di-debug, dan dijelaskan dalam laporan akademis.
//
// Tiga state utama dengan tanggung jawab yang berbeda:

/**
 * appState: Kondisi keseluruhan aplikasi.
 * Mengontrol apakah simulasi berjalan, status loading, dan mode debug.
 * Diinisialisasi sebelum runApp() dan diperbarui sepanjang siklus hidup aplikasi.
 */
let appState = {
    isRunning: false,       // true jika simulasi aktif; false saat pause
    lastFrameTime: 0,       // timestamp frame terakhir dalam milidetik (dari rAF)
    assetsLoaded: false,    // true setelah loadAssets() berhasil
    debug: false            // true untuk output debug tambahan di console
};

/**
 * rendererState: Data visual yang dihasilkan oleh renderer.
 * Menyimpan hasil return dari setupTexture, setupRoadGeometry, dan
 * setupSpriteGeometry — berisi buffer WebGL, texture handle, dan metadata geometri.
 * Struktur detail bergantung pada implementasi renderer.js.
 */
let rendererState = {};

/**
 * simulationState: Data dinamis untuk animasi dan simulasi.
 * Menyimpan daftar objek bergerak, waktu simulasi, dan data lain
 * yang dibutuhkan animation.js. Struktur bergantung pada desain
 * animation.js dan isi data.json.
 *
 * Catatan untuk laporan: simulationState dipisah dari rendererState karena
 * data simulasi berubah setiap frame (diupdate oleh animation.js),
 * sedangkan data visual jarang berubah kecuali map diacak ulang.
 */
let simulationState = {
    // Properti awal; akan diperluas sesuai data dari data.json dan animation.js
    // Contoh properti yang mungkin dibutuhkan:
    // movingObjects : [],   // array objek bergerak (kendaraan, NPC, dsb.)
    // elapsedTime   : 0,    // akumula si waktu simulasi berjalan (dalam detik)
};


// ============================================================
// BAGIAN 5: REFERENSI STATE ENGINE
// ============================================================
// Variabel ini diisi oleh runApp() setelah initWebGL() berhasil,
// dan digunakan oleh renderLoop() setiap frame.
// Dideklarasikan di scope modul (bukan di dalam fungsi) agar
// renderLoop() dapat mengaksesnya tanpa parameter yang panjang.

/** Context rendering WebGL yang digunakan untuk semua operasi GPU */
let gl = null;

/** Referensi ke elemen <canvas> HTML untuk membaca lebar dan tinggi viewport */
let canvas = null;

/** State kamera (matriks view-projection, posisi kamera, zoom) dari engine.js */
let cameraState = null;

/** Lokasi uniform dan attribute shader yang di-resolve oleh engine.js */
let locations = null;


// ============================================================
// BAGIAN 6: RENDER LOOP — GAME LOOP UTAMA
// ============================================================
// renderLoop adalah inti dari aplikasi real-time ini.
// Dipanggil oleh browser setiap kali layar siap menampilkan frame baru.
//
// Mengapa requestAnimationFrame dan BUKAN setInterval?
//   1. requestAnimationFrame sinkron dengan refresh rate monitor (vsync),
//      sehingga tidak ada "sobek gambar" (screen tearing).
//   2. Otomatis berhenti saat tab browser tidak aktif — menghemat daya baterai
//      dan mengurangi beban CPU/GPU yang tidak perlu.
//   3. Lebih akurat secara timing dan lebih efisien dibanding setInterval
//      yang tidak dijamin berjalan tepat waktu.

/**
 * renderLoop(time)
 * Fungsi game loop utama yang dipanggil setiap frame oleh browser
 * melalui mekanisme requestAnimationFrame.
 *
 * @param {DOMHighResTimeStamp} time - Waktu saat ini dalam milidetik,
 * disediakan otomatis oleh browser dengan presisi sub-milidetik.
 */
function renderLoop(time) {

    // ----------------------------------------------------------
    // LANGKAH 1: HITUNG DELTA TIME
    // ----------------------------------------------------------
    // Delta time (Δt) adalah selisih waktu antara frame saat ini
    // dan frame sebelumnya, dikonversi ke satuan DETIK.
    //
    // Mengapa delta time dibutuhkan?
    //   Tanpa delta time, kecepatan objek bergantung pada FPS:
    //   - Di komputer ber-FPS tinggi (120 FPS) → objek bergerak cepat
    //   - Di GPU terintegrasi Intel i5-10310U (mungkin 30 FPS) → objek lambat
    //
    //   Dengan mengalikan kecepatan × deltaTime:
    //   - 120 FPS: deltaTime ≈ 0.0083 detik → jarak kecil per frame
    //   - 30 FPS: deltaTime ≈ 0.033 detik → jarak lebih besar per frame
    //   → Total jarak per detik SAMA di semua perangkat. Animasi menjadi
    //     "frame-rate independent" atau "time-based animation".
    //
    // Rumus: deltaTime = (waktuSekarang - waktuFrameSebelumnya) / 1000
    //        (dibagi 1000 untuk mengkonversi milidetik → detik)

    let deltaTime = (time - appState.lastFrameTime) / 1000;

    // Pembatasan nilai maksimal delta time.
    // Ketika pengguna berpindah tab dan kembali, "time - lastFrameTime"
    // bisa bernilai sangat besar (misalnya 5 detik). Tanpa batas ini,
    // semua objek akan melompat jauh sekaligus dalam satu frame.
    // Dengan MAX_DELTA_TIME = 0.1 detik, loncatan dibatasi secara aman.
    if (deltaTime > MAX_DELTA_TIME) {
        deltaTime = MAX_DELTA_TIME;
    }

    // Simpan waktu frame ini untuk digunakan sebagai referensi di frame berikutnya
    appState.lastFrameTime = time;

    // ----------------------------------------------------------
    // LANGKAH 2: BERSIHKAN LAYAR DAN SIAPKAN KAMERA
    // ----------------------------------------------------------
    // beginFrame membersihkan color buffer dan depth buffer dari frame
    // sebelumnya, lalu mengirim matriks view-projection kamera ke shader.
    // Tanpa ini, gambar frame sebelumnya akan terlihat "tertinggal" di layar.
    // Semua detail operasi ini ada di engine.js — main.js hanya memanggilnya.
    beginFrame(gl, cameraState, locations, canvas.width, canvas.height);

    // ----------------------------------------------------------
    // LANGKAH 3: UPDATE ANIMASI (jika simulasi aktif)
    // ----------------------------------------------------------
    // Pembaruan animasi hanya dilakukan saat appState.isRunning === true.
    // Ini adalah mekanisme fitur "Pause":
    //   - render loop tetap berjalan setiap frame (layar tidak blank)
    //   - tetapi posisi objek tidak diperbarui → objek tampak beku
    //
    // Dengan cara ini, efek pause dapat diimplementasikan tanpa
    // menghentikan loop atau membuat flag di dalam animation.js.
    if (appState.isRunning) {
        // Detail logika pergerakan dan animasi sepenuhnya ada di animation.js.
        // main.js hanya meneruskan state dan delta time.
        updateAnimations(simulationState, deltaTime);
    }

    // ----------------------------------------------------------
    // LANGKAH 4: DRAW CALL — GAMBAR JALAN DAN SPRITE
    // ----------------------------------------------------------
    // Urutan draw call penting dalam rendering isometric:
    //   1. Jalan digambar lebih dahulu (lapisan paling bawah/belakang)
    //   2. Sprite dan bangunan digambar di atasnya (lapisan depan)
    //
    // Urutan ini mensimulasikan depth (kedalaman) secara visual
    // tanpa memerlukan depth buffer penuh, yang lebih efisien
    // untuk GPU terintegrasi dengan bandwidth memori terbatas.

    // Menggambar seluruh geometri jalan dari data peta
    drawRoads(gl, locations, rendererState, cameraState);

    // Menggambar seluruh sprite, bangunan, dan objek kota di atas jalan
    drawSprites(gl, locations, rendererState, simulationState, cameraState);

    // ----------------------------------------------------------
    // LANGKAH 5: MINTA FRAME BERIKUTNYA
    // ----------------------------------------------------------
    // Memanggil renderLoop kembali untuk iterasi berikutnya.
    // Ini membentuk siklus render tak terbatas yang dikelola browser.
    // Loop akan otomatis terhenti jika tab ditutup atau tidak aktif.
    requestAnimationFrame(renderLoop);
}


// ============================================================
// BAGIAN 7: SETUP EVENT LISTENER TOMBOL UI
// ============================================================
// Tombol HTML dihubungkan ke state aplikasi melalui event listener.
// Pemasangan dilakukan setelah inisialisasi selesai agar pengguna
// tidak dapat menekan tombol sebelum aplikasi benar-benar siap.

/**
 * Memasang event listener ke tombol-tombol UI di halaman HTML.
 * Menggunakan pengecekan eksplisit agar tidak crash jika tombol
 * tidak ditemukan — aplikasi tetap dapat berjalan tanpa UI tombol.
 *
 * @param {Object} engineRefs - Referensi gl, locations, canvas dari engine
 * untuk operasi yang membutuhkan akses WebGL (seperti rebuild geometry)
 */
function setupUIListeners(engineRefs) {

    // ---- Tombol Start / Pause ----
    // Mengubah appState.isRunning dengan cara toggle (bolak-balik).
    // State ini dibaca oleh renderLoop() untuk memutuskan apakah
    // updateAnimations() dipanggil di setiap frame.
    const btnStartPause = document.getElementById(START_PAUSE_BUTTON_ID);
    if (btnStartPause) {
        btnStartPause.addEventListener('click', () => {
            // Toggle: jika sedang jalan → pause, jika pause → jalan
            appState.isRunning = !appState.isRunning;

            // Sinkronkan teks tombol dengan state saat ini agar UI informatif
            btnStartPause.textContent = appState.isRunning ? 'Pause' : 'Start';

            console.log(`[UI] Simulasi ${appState.isRunning ? 'DIMULAI' : 'DIJEDA'}.`);
        });
        console.log(`[UI] Event listener tombol Start/Pause terpasang (ID: "${START_PAUSE_BUTTON_ID}").`);
    } else {
        console.warn(
            `[UI] Peringatan: Tombol dengan ID "${START_PAUSE_BUTTON_ID}" tidak ditemukan di HTML. ` +
            `Fitur Start/Pause tidak akan berfungsi, tetapi render loop tetap berjalan.`
        );
    }

    // ---- Tombol Acak Map ----
    // Mengacak layout peta dan membangun ULANG buffer geometri.
    //
    // PENTING untuk performa: Rebuild geometri HANYA boleh dilakukan
    // saat tombol ini ditekan, BUKAN setiap frame.
    // Membuat buffer WebGL baru setiap frame akan menyebabkan:
    //   1. Fragmentasi memori GPU
    //   2. Penurunan FPS drastis, khususnya pada GPU terintegrasi
    //   3. Kemungkinan memory leak jika buffer lama tidak dibebaskan
    const btnRandomizeMap = document.getElementById(RANDOMIZE_MAP_BUTTON_ID);
    if (btnRandomizeMap) {
        btnRandomizeMap.addEventListener('click', () => {
            console.log('[UI] Tombol Acak Map ditekan. Memulai proses randomisasi peta...');

            // Menggunakan typeof sebagai pengecekan aman (safe guard).
            // Jika fungsi setup geometri belum tersedia (misalnya renderer.js
            // belum mengekspor fungsi randomisasi), tidak akan terjadi crash.
            //
            // Catatan: Algoritma randomisasi peta detail sebaiknya ada di
            // renderer.js atau modul data terpisah — bukan di main.js.
            // main.js hanya bertanggung jawab memanggil fungsi tersebut
            // dengan data peta yang baru.
            if (typeof setupRoadGeometry === 'function' &&
                typeof setupSpriteGeometry === 'function') {

                // Placeholder pemanggilan rebuild geometry.
                // Sesuaikan parameter dan sumber data acak dengan
                // API renderer.js dan format data.json yang sebenarnya.
                //
                // Contoh alur yang diharapkan:
                //   const newMapData = generateRandomMap();         // di renderer/data module
                //   rendererState.roads   = setupRoadGeometry(engineRefs.gl, engineRefs.locations, newMapData.roads);
                //   rendererState.sprites = setupSpriteGeometry(engineRefs.gl, engineRefs.locations, newMapData.buildings);

                console.log('[UI] Acak Map: Silakan implementasikan pemanggilan generateRandomMap() di renderer.js.');
                console.log('[UI] Rebuild geometri selesai dipicu.');
            } else {
                console.warn(
                    '[UI] Fungsi acak map (setupRoadGeometry / setupSpriteGeometry) ' +
                    'tidak tersedia. Pastikan renderer.js mengekspornya.'
                );
            }
        });
        console.log(`[UI] Event listener tombol Acak Map terpasang (ID: "${RANDOMIZE_MAP_BUTTON_ID}").`);
    } else {
        console.warn(
            `[UI] Peringatan: Tombol dengan ID "${RANDOMIZE_MAP_BUTTON_ID}" tidak ditemukan di HTML. ` +
            `Fitur Acak Map tidak akan berfungsi, tetapi render loop tetap berjalan.`
        );
    }
}


// ============================================================
// BAGIAN 8: FUNGSI BOOTSTRAP UTAMA — runApp()
// ============================================================
// Seluruh alur inisialisasi dibungkus dalam satu fungsi async.
//
// Mengapa TIDAK menggunakan top-level await?
//   Top-level await adalah fitur ES2022 yang belum didukung semua
//   lingkungan. Membungkus dalam async function lebih kompatibel
//   dengan spesifikasi ES6 Modules standar dan lebih mudah
//   ditambahkan error handling di tingkat tertinggi.
//
// Urutan eksekusi runApp():
//   1. Muat semua asset (JSON + gambar) secara paralel
//   2. Inisialisasi WebGL melalui engine.js
//   3. Setup texture dari spritesheet
//   4. Setup buffer geometri jalan
//   5. Setup buffer geometri sprite/bangunan
//   6. Inisialisasi state aplikasi
//   7. Pasang event listener tombol UI
//   8. Mulai render loop dengan requestAnimationFrame

/**
 * runApp()
 * Fungsi bootstrap yang mengatur seluruh proses inisialisasi aplikasi
 * secara berurutan sebelum render loop dimulai.
 * Dipanggil satu kali saat aplikasi pertama kali dijalankan.
 */
async function runApp() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Simulasi Tata Kota 2.5D Isometric Medieval      ║');
    console.log('║  Grafika Komputer — WebGL / ES6 Modules          ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('[App] Memulai proses inisialisasi...');

    // ----------------------------------------------------------
    // LANGKAH 1: MUAT SEMUA ASSET
    // ----------------------------------------------------------
    // Asset dimuat SEBELUM WebGL diinisialisasi agar data peta
    // dan texture siap digunakan saat renderer membangun buffer.
    // Jika asset gagal, seluruh proses dihentikan lebih awal (fail-fast)
    // daripada membiarkan aplikasi berjalan dalam kondisi tidak valid.
    let mapData, spritesheet;
    try {
        const assets = await loadAssets();
        mapData = assets.mapData;
        spritesheet = assets.spritesheet;
        appState.assetsLoaded = true;
    } catch (error) {
        console.error('[App] FATAL: Gagal memuat asset. Inisialisasi dihentikan.', error);
        return; // Hentikan seluruh proses — jangan lanjutkan tanpa asset
    }

    // ----------------------------------------------------------
    // LANGKAH 2: INISIALISASI WEBGL
    // ----------------------------------------------------------
    // initWebGL menangani semua setup WebGL tingkat rendah:
    //   - Mengambil elemen canvas dari DOM
    //   - Membuat context WebGL (getContext('webgl'))
    //   - Mengkompilasi vertex shader dan fragment shader
    //   - Membuat shader program
    //   - Mengatur kamera orthographic-isometric
    //   - Me-resolve lokasi uniform dan attribute
    //
    // main.js menerima hasilnya sebagai satu objek — tidak perlu
    // tahu detail implementasinya. Ini adalah prinsip enkapsulasi.
    let engineData;
    try {
        engineData = initWebGL(CANVAS_ID);

        // Validasi minimal: pastikan gl dan canvas tersedia
        if (!engineData || !engineData.gl || !engineData.canvas) {
            throw new Error(
                'initWebGL() mengembalikan data tidak valid. ' +
                'Pastikan engine.js mengembalikan { gl, canvas, cameraState, locations, ... }.'
            );
        }
    } catch (error) {
        console.error('[App] FATAL: Gagal menginisialisasi WebGL.', error);
        return;
    }

    // Salin referensi engine ke variabel modul-level agar dapat
    // diakses oleh renderLoop() tanpa parameter yang panjang.
    //
    // Catatan: Nama properti di bawah disesuaikan dengan nilai return
    // dari initWebGL() di engine.js. Sesuaikan jika nama berbeda.
    gl          = engineData.gl;
    canvas      = engineData.canvas;
    cameraState = engineData.cameraState;
    locations   = engineData.locations;

    console.log('[App] WebGL berhasil diinisialisasi.');
    console.log(`[App] Viewport: ${canvas.width}×${canvas.height}px`);

    // ----------------------------------------------------------
    // LANGKAH 3: SETUP TEXTURE SPRITESHEET
    // ----------------------------------------------------------
    // Mengubah HTMLImageElement menjadi WebGL texture object.
    // Texture dibuat SEKALI — tidak di dalam render loop —
    // agar tidak terjadi alokasi memori GPU berulang setiap frame.
    let textureResult;
    try {
        textureResult = setupTexture(gl, locations, spritesheet);
        if (!textureResult) {
            // Warning, bukan error fatal — renderer mungkin mengelola texture secara internal
            console.warn('[App] setupTexture() mengembalikan nilai falsy. Periksa apakah renderer.js mengelola texture secara internal.');
        }
    } catch (error) {
        console.error('[App] FATAL: Gagal setup texture spritesheet.', error);
        return;
    }

    // ----------------------------------------------------------
    // LANGKAH 4: SETUP GEOMETRI JALAN
    // ----------------------------------------------------------
    // Data koordinat jalan dari data.json dikirim ke renderer
    // untuk dikonversi menjadi vertex buffer WebGL.
    // Buffer dibuat sekali; hanya dibuat ulang saat map diacak.
    //
    // CATATAN tentang struktur data.json:
    //   Properti yang diakses (mapData.roads, mapData.buildings) adalah ASUMSI.
    //   Sesuaikan dengan struktur aktual data.json yang digunakan proyek.
    //   Contoh alternatif: mapData.tiles, mapData.grid, mapData.objects, dsb.
    let roadGeometryResult;
    try {
        // Asumsi: data jalan ada di mapData.roads
        // Fallback ke mapData jika properti roads tidak ada
        const roadData = mapData.roads ?? mapData;
        roadGeometryResult = setupRoadGeometry(gl, locations, roadData);
    } catch (error) {
        console.error('[App] FATAL: Gagal setup geometri jalan.', error);
        return;
    }

    // ----------------------------------------------------------
    // LANGKAH 5: SETUP GEOMETRI SPRITE DAN BANGUNAN
    // ----------------------------------------------------------
    // Data bangunan dari data.json dikirim ke renderer untuk
    // membangun buffer sprite, termasuk posisi isometric dan UV mapping.
    let spriteGeometryResult;
    try {
        // Asumsi: data bangunan ada di mapData.buildings
        const buildingData = mapData.buildings ?? mapData;
        spriteGeometryResult = setupSpriteGeometry(gl, locations, buildingData);
    } catch (error) {
        console.error('[App] FATAL: Gagal setup geometri sprite/bangunan.', error);
        return;
    }

    console.log('[App] Semua geometri renderer berhasil dibangun.');

    // ----------------------------------------------------------
    // LANGKAH 6: INISIALISASI STATE APLIKASI
    // ----------------------------------------------------------
    // State diisi setelah semua setup selesai dengan hasil
    // yang dikembalikan oleh fungsi-fungsi inisialisasi.

    // rendererState: menyimpan handle buffer dan texture dari renderer
    // Struktur bergantung pada nilai return renderer.js
    rendererState = {
        texture  : textureResult,          // WebGL texture handle spritesheet
        roads    : roadGeometryResult,     // buffer dan metadata geometri jalan
        sprites  : spriteGeometryResult,   // buffer dan metadata geometri sprite
        // Tambahkan properti lain sesuai kebutuhan renderer.js
    };

    // simulationState: diinisialisasi dengan data dinamis dari JSON
    // Struktur bergantung pada desain animation.js dan format data.json
    simulationState = {
        // Contoh properti awal yang mungkin dibutuhkan animation.js:
        // movingObjects : mapData.movingObjects ?? [],
        // elapsedTime   : 0,
        // Spread properti simulasi dari JSON jika tersedia
        ...(mapData.simulation != null ? mapData.simulation : {})
    };

    // Inisialisasi lastFrameTime dengan waktu sekarang agar
    // deltaTime frame pertama bernilai mendekati 0, bukan besar.
    appState.lastFrameTime = performance.now();

    // Simulasi langsung berjalan saat aplikasi dimuat
    appState.isRunning = true;

    if (appState.debug) {
        console.log('[Debug] rendererState:', rendererState);
        console.log('[Debug] simulationState:', simulationState);
        console.log('[Debug] appState:', appState);
    }

    console.log('[App] State aplikasi berhasil diinisialisasi.');

    // ----------------------------------------------------------
    // LANGKAH 7: PASANG EVENT LISTENER UI
    // ----------------------------------------------------------
    // Dipasang setelah semua inisialisasi selesai agar pengguna
    // tidak dapat memicu aksi UI sebelum renderer siap.
    setupUIListeners({ gl, locations, canvas, cameraState });

    // ----------------------------------------------------------
    // LANGKAH 8: MULAI RENDER LOOP
    // ----------------------------------------------------------
    // Memanggil renderLoop untuk pertama kali.
    // Setelah ini, renderLoop akan memanggil dirinya sendiri
    // melalui requestAnimationFrame secara terus-menerus.
    console.log('[App] Memulai render loop...');
    requestAnimationFrame(renderLoop);
    console.log('[App] ✓ Aplikasi berjalan. Render loop aktif.');
}


// ============================================================
// BAGIAN 9: ENTRY POINT — TITIK AWAL EKSEKUSI
// ============================================================
// runApp() dipanggil setelah DOM selesai dimuat untuk memastikan
// elemen canvas dan tombol UI sudah ada di halaman.
//
// Catatan: ES6 Modules di-defer secara otomatis oleh browser,
// artinya skrip ini sudah berjalan setelah DOM ter-parse.
// Penggunaan DOMContentLoaded tetap ditambahkan sebagai
// lapisan keamanan ekstra untuk semua skenario loading HTML.
//
// Promise rejection dari runApp() (error yang tidak tertangkap
// di dalam try-catch) akan terlihat di console melalui .catch().

document.addEventListener('DOMContentLoaded', () => {
    console.log('[App] DOM siap. Menjalankan bootstrap aplikasi...');
    runApp().catch((error) => {
        console.error('[App] ✗ FATAL: Aplikasi gagal dijalankan karena error yang tidak tertangkap.', error);
    });
});
