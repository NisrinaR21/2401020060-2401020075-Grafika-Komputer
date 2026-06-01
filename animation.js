// ================================================================
// animation.js
// Modul Animasi Kereta Kuda — Medieval Spatial Mapping
// WebGL 1.0 Pure | ES6 Modules | Tanpa Library Eksternal
//
// Cara pakai:
//   import {
//     createAnimationState, updateAnimations,
//     startTrack, pauseTrack, toggleTrack,
//     randomizeCarriagePosition, randomizeTargetPosition,
//     requestRouteToNode, requestRouteToBuilding,
//     updateCameraFollow, breakCameraFollow, enableCameraFollow
//   } from './animation.js';
//
// Dibuat sebagai file baru — tidak mengubah engine.js atau
// renderer.js secara destruktif. Semua interaksi lewat objek
// yang di-pass sebagai parameter (data coupling, bukan global state).
// ================================================================

'use strict';

// ╔══════════════════════════════════════════════════════════╗
// ║  KONSTANTA ANIMASI                                       ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Kecepatan gerak kereta kuda dalam pixel/detik (world space).
 * Sesuaikan dengan skala tile di project kamu.
 * Tile 64px → nilai 80 berarti kereta menempuh ~1.25 tile per detik.
 */
const CARRIAGE_SPEED = 80;

/**
 * Frekuensi bobbing dalam Hz (siklus sinus per detik).
 *
 * [AKADEMIS]
 * Mengapa sinus cocok untuk animasi periodik?
 * Fungsi sin(t) adalah solusi natural dari persamaan gerak harmonik
 * sederhana: d²x/dt² = −ω²x, di mana ω adalah frekuensi sudut.
 * Gerakan ini identik dengan pegas atau pendulum — yang merupakan
 * aproksimasi fisik dari "langkah kuda" di bidang vertikal.
 * Nilai 2.5 ≈ 2.5 siklus/detik → terasa seperti "trot" (lari pelan).
 */
const BOB_FREQUENCY = 2.5;

/**
 * Amplitudo bobbing dalam pixel.
 * Nilai kecil (3–5px) lebih realistis untuk perspektif isometric 2.5D.
 */
const BOB_AMPLITUDE = 4;

/**
 * Faktor squash-stretch (perubahan skala per siklus, tanpa satuan).
 *
 * [AKADEMIS]
 * Squash-stretch adalah salah satu dari "12 Prinsip Animasi Disney"
 * (Johnston & Thomas, 1981). Prinsip ini menyatakan bahwa objek berbobot
 * akan berdeformasi saat bergerak: menjadi pipih (squash) saat absorb
 * benturan, dan memanjang (stretch) saat meluncur. Efek ini memberi kesan
 * massa dan elastisitas tanpa butuh simulasi fisika penuh.
 *
 * Untuk kereta: saat "turun" (bob negatif) → scaleX melebar, scaleY memendek.
 * Saat "naik" (bob positif) → sebaliknya. Efek halus 3% sudah cukup.
 */
const SQUASH_STRETCH_FACTOR = 0.03;

/**
 * Faktor smoothing Lerp kamera (0.0 = tidak bergerak, 1.0 = snap instan).
 * Nilai 0.08 → kamera "mencapai" kereta dalam ~2 detik (ease-out).
 */
const CAMERA_SMOOTHING = 0.08;

/** Batas iterasi pathfinding untuk mencegah infinite loop */
const MAX_PATHFIND_ITERATIONS = 5000;

/**
 * Offset sumber cahaya isometric (medieval: cahaya dari barat-laut).
 * Shadow akan bergeser ke kanan-bawah relatif terhadap sprite.
 */
const SHADOW_OFFSET_X = 10;
const SHADOW_OFFSET_Y = 14;


// ╔══════════════════════════════════════════════════════════╗
// ║  SECTION 1 — ANIMATION STATE                            ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Membuat objek state simulasi animasi dari data map_grafika.json.
 *
 * Fungsi ini hanya boleh dipanggil SEKALI saat inisialisasi,
 * bukan di dalam render loop. Membangun graph dari data peta
 * adalah operasi mahal — lakukan sekali, pakai berkali-kali.
 *
 * @param {Object} mapData - Parsed content dari map_grafika.json
 * @returns {Object} simulationState - State lengkap simulasi
 *
 * [AKADEMIS — STATE MACHINE]
 * Memisahkan "state data" dari "logika update" adalah pola desain
 * Entity-Component atau FSM (Finite State Machine). Render loop hanya
 * perlu membaca state ini — ia tidak perlu tahu algoritma di baliknya.
 * Ini memungkinkan unit testing dan hot-reload yang lebih mudah.
 */
export function createAnimationState(mapData) {
    // Bangun graph internal dari data peta (sekali saja)
    const graph = _buildGraph(mapData);

    // Ambil node pertama sebagai posisi awal kereta
    const startNode = _getFirstNode(graph, mapData);

    return {
        // ── Waktu simulasi (detik, selalu bertambah saat running) ──
        time: 0,

        // ── Status simulasi ───────────────────────────────────────
        /** true = animasi aktif berjalan */
        isRunning: false,

        // ── Data kereta kuda ──────────────────────────────────────
        carriage: {
            /** Posisi X di world space (pixel) */
            x: startNode ? startNode.x : 0,
            /** Posisi Y di world space (pixel) */
            y: startNode ? startNode.y : 0,
            /**
             * Rotasi dalam radian.
             * Digunakan untuk menentukan apakah sprite harus di-flip.
             * (WebGL 1.0: gunakan scaleX negatif untuk mirror, bukan rotasi penuh)
             */
            rotation: 0,
            /** Skala X — berubah akibat squash-stretch */
            scaleX: 1.0,
            /** Skala Y — berubah akibat squash-stretch */
            scaleY: 1.0,
            /**
             * Offset Y dari efek bobbing (pixel, bisa negatif/positif).
             * Renderer menambahkan nilai ini ke posisi Y saat menggambar.
             */
            bobOffsetY: 0,
            /**
             * Data transform bayangan palsu (fake drop shadow).
             * Renderer.js membaca properti ini untuk menggambar shadow
             * SEBELUM menggambar sprite kereta.
             *
             * [CATATAN RENDERER]
             * Shadow bukan object WebGL terpisah. Renderer cukup:
             * 1. Gambar quad dengan texture sama (atau solid gelap)
             * 2. Apply transform dari shadow ini (x, y, scaleX, scaleY, skewX)
             * 3. Set gl.uniform4f warna ke (0, 0, 0, alpha) — hitam transparan
             * 4. Gambar di bawah sprite kereta (draw order!)
             */
            shadow: {
                x:      0,
                y:      0,
                scaleX: 1.4,   // Shadow lebih lebar dari sprite
                scaleY: 0.45,  // Shadow pipih (proyeksi isometric)
                skewX:  0.25,  // Miring ke kanan (sumber cahaya kiri atas)
                alpha:  0.40,  // Transparansi shadow
            },
        },

        // ── Data route (jalur yang sedang diikuti) ────────────────
        route: {
            /**
             * Array node {id, x, y} yang membentuk jalur.
             * Diisi oleh requestRouteToNode() / requestRouteToBuilding().
             */
            nodes: [],
            /**
             * Index node TUJUAN saat ini dalam array nodes.
             * Kereta bergerak dari nodes[currentIndex-1] ke nodes[currentIndex].
             * Mulai dari 1 (segmen pertama adalah nodes[0] → nodes[1]).
             */
            currentIndex: 1,
            /** Progress 0.0–1.0 dalam segmen saat ini */
            progress: 0,
            /** Kecepatan kereta dalam pixel/detik */
            speed: CARRIAGE_SPEED,
        },

        // ── Camera follow state ───────────────────────────────────
        cameraFollow: {
            /** true = kamera mengikuti kereta secara otomatis */
            enabled: true,
        },

        // ── Graph jalan (dibangun dari roadGraph atau rute_jalan) ──
        /**
         * { nodes: Map<id, {id,x,y}>, adjacency: Map<id, [{to,cost}]> }
         * null jika data peta tidak memuat informasi jalan.
         */
        graph,

        /**
         * ID node jalan tempat kereta berada saat ini.
         * null = posisi kereta di luar node terdekat yang diketahui.
         */
        currentNodeId: startNode ? startNode.id : null,

        /** ID node tujuan terakhir (untuk re-request setelah randomize) */
        targetNodeId: null,

        /**
         * Referensi ke mapData asli.
         * Dipakai untuk fallback jika graph tidak lengkap.
         * Prefiks underscore = "private, jangan diakses dari luar modul ini".
         */
        _rawMapData: mapData,
    };
}


// ╔══════════════════════════════════════════════════════════╗
// ║  SECTION 2 — UPDATE LOOP                                ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Fungsi utama update — dipanggil setiap frame dari render loop di main.js.
 *
 * FUNGSI INI TIDAK MELAKUKAN PATHFINDING.
 * Pathfinding hanya terjadi di requestRouteToNode() / randomizeTargetPosition()
 * yang dipanggil secara event-driven (bukan per-frame).
 *
 * @param {Object} simulationState - State dari createAnimationState()
 * @param {number} deltaTime - Selisih waktu sejak frame terakhir (detik)
 *
 * [AKADEMIS — UPDATE/RENDER SEPARATION]
 * Pemisahan update() dari render() adalah pola arsitektur game loop
 * standar (lihat: "Game Programming Patterns" — Bob Nystrom, 2014).
 * Keuntungannya: logika animasi tidak bergantung pada frame rate GPU.
 * Dengan deltaTime, simulasi berjalan identik di 30 FPS dan 120 FPS.
 *
 * [AKADEMIS — DELTATIME CLAMPING]
 * deltaTime dikunci maksimum 50ms untuk mencegah "spiral of death":
 * jika browser tab tidak aktif lalu kembali, deltaTime bisa 5+ detik,
 * membuat objek melompat posisi drastis. Clamping mencegah hal itu.
 */
export function updateAnimations(simulationState, deltaTime) {
    // Guard: jika state tidak ada, abaikan
    if (!simulationState) return;
    // Guard: jika pause, tidak ada yang di-update
    if (!simulationState.isRunning) return;

    // Clamp deltaTime: maksimum 50ms per frame
    const dt = Math.min(deltaTime, 0.05);

    // Tambah waktu simulasi kumulatif
    simulationState.time += dt;

    // Update posisi kereta mengikuti route
    _updateCarriageMovement(simulationState, dt);

    // Update efek visual (bobbing, squash-stretch)
    _updateBobbingEffect(simulationState);

    // Sinkronisasi posisi shadow dengan kereta
    _updateShadow(simulationState);
}


// ── Internal: gerak kereta mengikuti route ──────────────────────

/**
 * Menggerakkan kereta dari node ke node mengikuti route.
 * Menggunakan linear interpolation (LERP) antar dua node.
 *
 * [AKADEMIS — LINEAR INTERPOLATION]
 * LERP: P(t) = P0 + (P1 - P0) × t, di mana t ∈ [0, 1]
 * Properti LERP: t=0 → P0, t=1 → P1, t=0.5 → titik tengah.
 * Kecepatan konstan karena progress per frame = speed × dt / panjang_segmen.
 * Ini berbeda dengan easing (Bezier, Catmull-Rom) yang variabel kecepatannya,
 * tetapi untuk game isometric dengan path grid, kecepatan konstan lebih natural.
 *
 * @param {Object} state - simulationState
 * @param {number} dt - deltaTime dalam detik
 */
function _updateCarriageMovement(state, dt) {
    const route = state.route;

    // Tidak ada route → diam
    if (!route.nodes || route.nodes.length < 2) return;

    const idx = route.currentIndex;

    // Sudah melewati node terakhir → route selesai
    if (idx >= route.nodes.length) {
        _onRouteCompleted(state);
        return;
    }

    const prev = route.nodes[idx - 1];
    const curr = route.nodes[idx];

    if (!prev || !curr) return;

    // Vektor dari node sebelumnya ke node saat ini
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const segmentLength = Math.sqrt(dx * dx + dy * dy);

    // Guard: hindari pembagian dengan nol jika dua node berimpit
    if (segmentLength < 0.001) {
        route.currentIndex++;
        route.progress = 0;
        return;
    }

    // Hitung penambahan progress: berapa jauh dalam 1 frame?
    // deltaProgress = (pixel/detik × detik) / panjang_segmen
    const deltaProgress = (route.speed * dt) / segmentLength;
    route.progress += deltaProgress;

    if (route.progress >= 1.0) {
        // Sampai di node berikutnya → snap ke posisi eksak node
        route.progress = 0;
        route.currentIndex++;

        state.carriage.x = curr.x;
        state.carriage.y = curr.y;

        // Update ID node posisi kereta saat ini
        if (curr.id) {
            state.currentNodeId = curr.id;
        }

    } else {
        // Interpolasi linear posisi
        // x = x1 + (x2 - x1) × t
        // y = y1 + (y2 - y1) × t
        state.carriage.x = prev.x + dx * route.progress;
        state.carriage.y = prev.y + dy * route.progress;

        // Hitung arah gerak untuk rotasi sprite
        // atan2 mengembalikan sudut (-π sampai +π) terhadap sumbu X positif
        state.carriage.rotation = Math.atan2(dy, dx);
    }
}


// ── Internal: bobbing dan squash-stretch ────────────────────────

/**
 * Menghasilkan ilusi animasi dari gambar statis menggunakan fungsi sinus.
 *
 * [AKADEMIS — MENGAPA SINUS UNTUK ANIMASI PERIODIK?]
 *
 * Fungsi sin(ωt) adalah solusi dari persamaan diferensial gerak harmonik
 * sederhana, yang merupakan model matematika paling dasar dari gerakan
 * berulang di alam (langkah, pernapasan, gelombang, pendulum).
 *
 * Dalam konteks animasi game:
 * - sin(t) memberikan transisi halus dari +1 ke -1 dan kembali
 * - Tidak ada "lompatan" nilai (fungsi kontinu)
 * - Tidak perlu menyimpan state keyframe sebelumnya
 * - Satu parameter (time) cukup untuk menentukan seluruh siklus animasi
 *
 * [AKADEMIS — SQUASH-STRETCH DAN ILLUSION OF WEIGHT]
 *
 * Squash-stretch bekerja karena otak manusia terbiasa melihat deformasi
 * pada objek berbobot saat bergerak. Tanpa deformasi, objek terasa "kaku"
 * dan "tidak bernyawa" — inilah perbedaan antara animasi kaku dan animasi
 * yang terasa hidup ("alive").
 *
 * Implementasi dengan sinus:
 * - scaleX = 1 + sin(t) × f  (melebar saat turun)
 * - scaleY = 1 - sin(t) × f  (memendek saat turun)
 * - Fase berlawanan → volume total relatif terjaga (conservation of volume)
 *
 * [AKADEMIS — EFISIENSI UNTUK WebGL 1.0]
 * Tanpa pendekatan ini, kita butuh spritesheet animasi (~8-12 frame per arah
 * = 32-48 texture regions). Dengan pendekatan ini: hanya 1 gambar + 3 float
 * yang dikirim ke uniform shader setiap frame. Tidak ada texture atlas
 * tambahan, tidak ada draw call ekstra. Biaya GPU = hampir nol.
 *
 * @param {Object} state - simulationState
 */
function _updateBobbingEffect(state) {
    // Tentukan apakah kereta sedang bergerak
    const isMoving = (
        state.isRunning &&
        state.route.nodes.length >= 2 &&
        state.route.currentIndex < state.route.nodes.length
    );

    if (!isMoving) {
        // Kereta diam → kembalikan ke posisi netral dengan decay halus
        // Multiplicative decay: nilai mendekati 0 secara eksponensial
        state.carriage.bobOffsetY   *= 0.85;
        state.carriage.scaleX       += (1.0 - state.carriage.scaleX) * 0.2;
        state.carriage.scaleY       += (1.0 - state.carriage.scaleY) * 0.2;
        return;
    }

    const t      = state.time;
    const sinVal = Math.sin(t * BOB_FREQUENCY); // nilai -1 sampai +1

    // Bobbing vertikal
    state.carriage.bobOffsetY = sinVal * BOB_AMPLITUDE;

    // Squash-stretch (X dan Y berlawanan fase)
    state.carriage.scaleX = 1.0 + sinVal * SQUASH_STRETCH_FACTOR;
    state.carriage.scaleY = 1.0 - sinVal * SQUASH_STRETCH_FACTOR;
}


// ── Internal: update shadow ──────────────────────────────────────

/**
 * Menyinkronisasi data transform bayangan dengan posisi kereta.
 * Shadow mengikuti kereta tetapi dengan offset isometric.
 *
 * Sumber cahaya diasumsikan dari kiri atas (northwest) sesuai
 * konvensi seni isometric medieval. Bayangan jatuh ke kanan-bawah.
 *
 * @param {Object} state - simulationState
 */
function _updateShadow(state) {
    const c  = state.carriage;
    const sh = c.shadow;

    // Posisi shadow = posisi kereta + offset isometric
    sh.x = c.x + SHADOW_OFFSET_X;
    sh.y = c.y + SHADOW_OFFSET_Y;

    // Shadow "menyempit" saat kereta naik (bobbing atas)
    // dan "melebar" saat kereta turun — memberi kesan jarak ke tanah
    const normalizedBob = (BOB_AMPLITUDE > 0)
        ? (c.bobOffsetY / BOB_AMPLITUDE) // -1 sampai +1
        : 0;

    const groundFactor = 1.0 - normalizedBob * 0.15; // range 0.85 – 1.15

    sh.scaleX = 1.4 * groundFactor;
    sh.scaleY = 0.45 * Math.max(0.3, groundFactor); // minimum 0.3 agar tidak nol
    sh.alpha  = 0.40 * Math.max(0.4, groundFactor);
}


// ── Internal: callback saat route selesai ───────────────────────

/**
 * Dipanggil saat kereta mencapai node terakhir dalam route.
 * Secara otomatis meminta tujuan baru agar simulasi terus berjalan.
 *
 * @param {Object} state - simulationState
 */
function _onRouteCompleted(state) {
    // Bersihkan route yang sudah selesai
    state.route.nodes        = [];
    state.route.currentIndex = 1;
    state.route.progress     = 0;

    // Minta tujuan baru secara acak
    randomizeTargetPosition(state);
}


// ╔══════════════════════════════════════════════════════════╗
// ║  SECTION 3 — START / PAUSE / TOGGLE                     ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Mulai atau lanjutkan simulasi animasi kereta kuda.
 * Route yang ada TIDAK dihapus → kereta melanjutkan dari progress terakhir.
 *
 * @param {Object} simulationState
 */
export function startTrack(simulationState) {
    if (!simulationState) return;
    simulationState.isRunning = true;

    // Jika belum ada route, minta route baru
    if (!simulationState.route.nodes || simulationState.route.nodes.length < 2) {
        randomizeTargetPosition(simulationState);
    }
}

/**
 * Pause simulasi animasi.
 * DESAIN PENTING: Route TIDAK dihapus saat pause.
 * Saat start kembali, kereta melanjutkan dari progress terakhir.
 * Ini mengikuti prinsip "pause = freeze, bukan reset".
 *
 * @param {Object} simulationState
 */
export function pauseTrack(simulationState) {
    if (!simulationState) return;
    simulationState.isRunning = false;
    // Sengaja TIDAK membersihkan route.nodes, route.progress,
    // atau currentNodeId — state harus terjaga untuk resume.
}

/**
 * Toggle antara running dan pause.
 *
 * @param {Object} simulationState
 */
export function toggleTrack(simulationState) {
    if (!simulationState) return;
    if (simulationState.isRunning) {
        pauseTrack(simulationState);
    } else {
        startTrack(simulationState);
    }
}


// ╔══════════════════════════════════════════════════════════╗
// ║  SECTION 4 — ACAK POSISI / TUJUAN                       ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Teleportasikan kereta ke node jalan acak yang valid.
 * Route yang ada dihapus, pathfinding diminta ulang dari posisi baru.
 *
 * @param {Object} simulationState
 */
export function randomizeCarriagePosition(simulationState) {
    if (!simulationState) return;

    const nodeIds = _getValidNodeIds(simulationState);
    if (nodeIds.length === 0) return;

    // Pilih node acak yang berbeda dari target saat ini
    const chosen = _pickRandomId(nodeIds, simulationState.targetNodeId);
    const node   = simulationState.graph && simulationState.graph.nodes.get(chosen);

    if (node) {
        simulationState.carriage.x = node.x;
        simulationState.carriage.y = node.y;
        simulationState.currentNodeId = chosen;
    }

    // Reset route
    simulationState.route.nodes        = [];
    simulationState.route.currentIndex = 1;
    simulationState.route.progress     = 0;

    // Re-request route ke target yang sudah ada, atau minta tujuan baru
    if (simulationState.targetNodeId) {
        requestRouteToNode(simulationState, simulationState.targetNodeId);
    } else {
        randomizeTargetPosition(simulationState);
    }
}

/**
 * Pilih node tujuan baru secara acak dan minta pathfinding.
 * Target dijamin berbeda dari posisi kereta saat ini.
 *
 * @param {Object} simulationState
 */
export function randomizeTargetPosition(simulationState) {
    if (!simulationState) return;

    const nodeIds = _getValidNodeIds(simulationState);
    if (nodeIds.length < 2) return;

    // Pilih node acak yang berbeda dari current position
    const chosen = _pickRandomId(nodeIds, simulationState.currentNodeId);
    simulationState.targetNodeId = chosen;
    requestRouteToNode(simulationState, chosen);
}

// ── Helper: kumpulkan ID node yang valid ────────────────────────

function _getValidNodeIds(state) {
    if (state.graph && state.graph.nodes && state.graph.nodes.size > 0) {
        return Array.from(state.graph.nodes.keys());
    }
    // Fallback: dari rute_jalan
    const rute = state._rawMapData && state._rawMapData.rute_jalan;
    if (rute && rute.length > 0) {
        return rute.map((_, i) => `rj_${i}`);
    }
    return [];
}

function _pickRandomId(ids, excludeId) {
    if (ids.length === 0) return null;
    if (ids.length === 1) return ids[0];

    let chosen;
    let attempts = 0;
    do {
        chosen = ids[Math.floor(Math.random() * ids.length)];
        attempts++;
    } while (chosen === excludeId && attempts < 20);

    return chosen;
}


// ╔══════════════════════════════════════════════════════════╗
// ║  SECTION 5 — BRANCH AND BOUND PATHFINDING               ║
// ╚══════════════════════════════════════════════════════════╝

// ─── MinHeap (Priority Queue Manual) ────────────────────────────

/**
 * MinHeap — implementasi priority queue tanpa library eksternal.
 *
 * [AKADEMIS — MENGAPA MinHEAP?]
 * MinHeap adalah struktur data pohon biner lengkap (complete binary tree)
 * yang memenuhi properti heap: setiap parent.cost ≤ kedua anaknya.
 * Akibatnya, elemen minimum selalu berada di root (index 0).
 *
 * Kompleksitas operasi:
 * - insert()     : O(log n)  — bubble up dari daun ke root
 * - extractMin() : O(log n)  — sink down dari root ke daun
 * - peek()       : O(1)      — langsung akses index 0
 * - Array biasa  : find-min O(n), insert O(1) — tidak efisien untuk besar
 *
 * Representasi array: node i memiliki
 * - parent : floor((i-1) / 2)
 * - left   : 2i + 1
 * - right  : 2i + 2
 * Representasi ini efisien memori (tidak butuh pointer node seperti linked list).
 */
class MinHeap {
    constructor() {
        /** Array internal yang mewakili pohon heap */
        this._data = [];
    }

    /** Jumlah elemen dalam heap */
    get size() { return this._data.length; }

    /** Cek apakah heap kosong */
    isEmpty() { return this._data.length === 0; }

    /**
     * Masukkan elemen baru. Elemen HARUS punya properti `cost` (number).
     * O(log n)
     * @param {Object} element - { cost: number, ...data }
     */
    insert(element) {
        this._data.push(element);
        this._bubbleUp(this._data.length - 1);
    }

    /**
     * Ambil dan hapus elemen dengan cost terkecil (root).
     * O(log n)
     * @returns {Object|null}
     */
    extractMin() {
        if (this.isEmpty()) return null;

        const min  = this._data[0];
        const last = this._data.pop();

        // Jika masih ada elemen, taruh last di root lalu sink down
        if (!this.isEmpty()) {
            this._data[0] = last;
            this._sinkDown(0);
        }

        return min;
    }

    /**
     * Lihat elemen terkecil tanpa menghapus.
     * O(1)
     */
    peek() {
        return this._data[0] || null;
    }

    // ── Private: operasi heap internal ──────────────────────────

    /**
     * Naik ke atas sampai properti heap terpenuhi.
     * Dipanggil setelah insert (elemen baru ada di ujung array).
     */
    _bubbleUp(idx) {
        while (idx > 0) {
            const parentIdx = Math.floor((idx - 1) / 2);
            if (this._data[parentIdx].cost <= this._data[idx].cost) break;
            // Tukar parent dan anak yang lebih kecil
            [this._data[parentIdx], this._data[idx]] =
                [this._data[idx],     this._data[parentIdx]];
            idx = parentIdx;
        }
    }

    /**
     * Turun ke bawah sampai properti heap terpenuhi.
     * Dipanggil setelah extractMin (root diganti elemen terakhir).
     */
    _sinkDown(idx) {
        const n = this._data.length;
        while (true) {
            let smallest = idx;
            const left   = 2 * idx + 1;
            const right  = 2 * idx + 2;

            if (left  < n && this._data[left].cost  < this._data[smallest].cost) smallest = left;
            if (right < n && this._data[right].cost < this._data[smallest].cost) smallest = right;

            if (smallest === idx) break; // Sudah di posisi yang benar

            [this._data[smallest], this._data[idx]] =
                [this._data[idx],     this._data[smallest]];
            idx = smallest;
        }
    }
}


// ─── Heuristic: Jarak Euclidean ─────────────────────────────────

/**
 * Heuristic admissible: jarak Euclidean antara dua titik.
 * Digunakan sebagai lower bound biaya tersisa ke tujuan.
 *
 * [AKADEMIS — ADMISSIBLE HEURISTIC]
 * Sebuah heuristic h(n) disebut admissible jika h(n) ≤ h*(n),
 * di mana h*(n) adalah biaya sebenarnya dari n ke tujuan.
 * Jarak lurus (Euclidean) selalu ≤ panjang rute sebenarnya
 * (karena rute tidak bisa lebih pendek dari garis lurus — segitiga inequality).
 * Dengan heuristic admissible, Branch and Bound MENJAMIN menemukan
 * jalur optimal jika ada. Ini tidak berlaku untuk heuristic non-admissible.
 *
 * @param {{x:number, y:number}} nodeA
 * @param {{x:number, y:number}} nodeB
 * @returns {number} jarak Euclidean
 */
function _heuristic(nodeA, nodeB) {
    const dx = nodeB.x - nodeA.x;
    const dy = nodeB.y - nodeA.y;
    return Math.sqrt(dx * dx + dy * dy);
}


// ─── Algoritma Branch and Bound ─────────────────────────────────

/**
 * Mencari jalur optimal dari startId ke goalId menggunakan
 * Branch and Bound dengan lower bound Euclidean.
 *
 * SIFAT EVENT-DRIVEN: Fungsi ini TIDAK dipanggil dari update loop.
 * Ia hanya dipanggil saat target berubah (dari requestRouteToNode).
 * Hasil (array node path) disimpan di state.route.nodes dan
 * hanya dibaca—tidak dihitung ulang—oleh _updateCarriageMovement.
 *
 * [AKADEMIS — BRANCH AND BOUND DENGAN LEAST COST]
 *
 * Algoritma B&B untuk optimasi:
 * 1. BRANCHING: Ekspansi node aktif → semua tetangga = cabang baru.
 * 2. BOUNDING: Hitung lower bound f(n) = g(n) + h(n) untuk tiap cabang.
 *    - g(n) = biaya aktual accumulated dari start ke n
 *    - h(n) = lower bound estimasi sisa biaya ke goal (Euclidean)
 * 3. PRUNING: Buang cabang di mana f(n) ≥ best_known_cost.
 *    Karena h admissible, pruning tidak akan membuang solusi optimal.
 * 4. Ulangi: ambil node dengan f(n) terkecil dari priority queue (MinHeap).
 * 5. Goal test: jika node yang diekstrak adalah goal → catat solusi,
 *    update best_known_cost, lanjutkan (mungkin ada jalur lebih murah).
 * 6. Termination: ketika priority queue kosong atau semua f(n) ≥ bound.
 *
 * Implementasi ini adalah B&B best-first (LC-FIFO branch and bound),
 * yang setara dengan A* untuk kasus graph dengan non-negatif edge weights.
 * Perbedaan: A* biasanya berhenti di first goal extraction (jika h admissible),
 * B&B explisit menyimpan upper bound dan melanjutkan eksplorasi.
 *
 * Kompleksitas: O((V + E) log V) dengan binary heap.
 *
 * @param {{ nodes: Map, adjacency: Map }} graph
 * @param {string} startId
 * @param {string} goalId
 * @returns {Array<{id:string, x:number, y:number}>} path dari start ke goal
 */
function _branchAndBoundPathfind(graph, startId, goalId) {
    // Validasi input
    if (!graph || !graph.nodes || !graph.adjacency) return [];
    if (!startId || !goalId)                        return [];
    if (startId === goalId) {
        const n = graph.nodes.get(startId);
        return n ? [n] : [];
    }

    const startNode = graph.nodes.get(startId);
    const goalNode  = graph.nodes.get(goalId);
    if (!startNode || !goalNode) return [];

    // ── Inisialisasi ───────────────────────────────────────────
    const openSet   = new MinHeap();    // Priority queue
    const bestGCost = new Map();        // Map<nodeId, best g(n)>
    const cameFrom  = new Map();        // Map<nodeId, parentId>

    // Masukkan titik awal
    const initH = _heuristic(startNode, goalNode);
    openSet.insert({ nodeId: startId, g: 0, cost: initH });
    bestGCost.set(startId, 0);
    cameFrom.set(startId, null);

    // Upper bound: biaya solusi terbaik yang diketahui (untuk pruning)
    let bestSolutionCost = Infinity;

    // ── Loop Branch and Bound ──────────────────────────────────
    let iterations = 0;

    while (!openSet.isEmpty() && iterations < MAX_PATHFIND_ITERATIONS) {
        iterations++;
        const current = openSet.extractMin();
        const { nodeId, g } = current;

        // PRUNE: lower bound sudah melebihi solusi terbaik
        if (current.cost >= bestSolutionCost) continue;

        // PRUNE: sudah ada jalur lebih murah ke node ini
        const knownG = bestGCost.get(nodeId);
        if (knownG !== undefined && g > knownG + 0.001) continue;

        // GOAL TEST: update upper bound jika lebih murah
        if (nodeId === goalId) {
            if (g < bestSolutionCost) {
                bestSolutionCost = g;
                // cameFrom sudah ter-update — rekonstruksi dilakukan di akhir
            }
            // Lanjutkan (mungkin ada jalur lebih murah dari cabang lain)
            continue;
        }

        // BRANCHING: ekspansi ke semua tetangga
        const neighbors = graph.adjacency.get(nodeId) || [];

        for (const edge of neighbors) {
            const neighborId   = edge.to;
            const neighborNode = graph.nodes.get(neighborId);
            if (!neighborNode) continue;

            // Hitung biaya edge
            const edgeCost = (edge.cost !== undefined && edge.cost > 0)
                ? edge.cost
                : _heuristic(graph.nodes.get(nodeId), neighborNode);

            const newG = g + edgeCost;

            // PRUNE: tidak lebih baik dari solusi yang diketahui
            if (newG >= bestSolutionCost) continue;
            if (newG >= (bestGCost.get(neighborId) ?? Infinity)) continue;

            // Update biaya terbaik ke neighbor
            bestGCost.set(neighborId, newG);
            cameFrom.set(neighborId, nodeId);

            // Hitung lower bound dan masukkan ke antrian
            const h = _heuristic(neighborNode, goalNode);
            openSet.insert({ nodeId: neighborId, g: newG, cost: newG + h });
        }
    }

    // ── Rekonstruksi jalur ──────────────────────────────────────
    if (!cameFrom.has(goalId)) {
        // Tidak ada jalur → fallback garis lurus (dua node)
        console.warn(`[animation.js] Tidak ada jalur dari ${startId} ke ${goalId}. Fallback garis lurus.`);
        return [startNode, goalNode];
    }

    const path = [];
    let cur = goalId;

    // Trace balik dari goal ke start via cameFrom
    while (cur !== null && cur !== undefined) {
        const node = graph.nodes.get(cur);
        if (node) path.unshift(node);
        cur = cameFrom.get(cur);
        // Safeguard: deteksi cycle (seharusnya tidak terjadi di DAG yang benar)
        if (path.length > graph.nodes.size + 2) {
            console.warn('[animation.js] Deteksi cycle saat rekonstruksi path. Hentikan.');
            break;
        }
    }

    return path;
}


// ─── Public: request route ──────────────────────────────────────

/**
 * Minta pathfinding dari posisi kereta saat ini ke node tertentu.
 * EVENT-DRIVEN: hanya panggil saat target berubah, BUKAN setiap frame.
 *
 * @param {Object} simulationState
 * @param {string} targetNodeId - ID node tujuan dari roadGraph.nodes
 */
export function requestRouteToNode(simulationState, targetNodeId) {
    if (!simulationState || !targetNodeId) return;

    simulationState.targetNodeId = targetNodeId;

    const graph  = simulationState.graph;
    const fromId = simulationState.currentNodeId;

    // Jika graph tidak valid → fallback ke rute_jalan
    if (!graph || !graph.nodes || graph.nodes.size === 0) {
        _applyFallbackRoute(simulationState);
        return;
    }

    // Jika posisi kereta tidak diketahui → pakai node pertama di graph
    const startId = fromId || _getFirstNodeId(graph);
    if (!startId) {
        _applyFallbackRoute(simulationState);
        return;
    }

    // Jalankan Branch and Bound
    const path = _branchAndBoundPathfind(graph, startId, targetNodeId);

    if (path && path.length > 0) {
        simulationState.route.nodes        = path;
        simulationState.route.currentIndex = 1;      // Mulai dari segmen nodes[0]→nodes[1]
        simulationState.route.progress     = 0;

        // Snap posisi kereta ke titik awal path
        if (path[0]) {
            simulationState.carriage.x = path[0].x;
            simulationState.carriage.y = path[0].y;
        }
    }
}

/**
 * Minta pathfinding ke node terdekat dengan sebuah bangunan.
 * Mencari building di objek_statis berdasarkan id atau nama,
 * lalu menentukan node jalan terdekatnya.
 *
 * @param {Object} simulationState
 * @param {string} buildingId - id atau nama dari objek_statis
 */
export function requestRouteToBuilding(simulationState, buildingId) {
    if (!simulationState || !buildingId) return;

    const mapData = simulationState._rawMapData;
    if (!mapData) return;

    // Cari bangunan di objek_statis (support nama properti lama dan baru)
    const buildings = mapData.objek_statis || mapData.buildings || [];
    const building  = buildings.find(b =>
        b.id === buildingId || b.nama === buildingId || b.name === buildingId
    );
    if (!building) {
        console.warn(`[animation.js] Bangunan '${buildingId}' tidak ditemukan di objek_statis.`);
        return;
    }

    // Jika bangunan sudah menyimpan referensi node, langsung gunakan
    if (building.nearestNodeId) {
        requestRouteToNode(simulationState, building.nearestNodeId);
        return;
    }

    // Hitung posisi bangunan dalam world space
    // Support format: {x, y} atau {col, row} (tile-based)
    const bx = building.x !== undefined ? building.x : (building.col || 0) * 64;
    const by = building.y !== undefined ? building.y : (building.row || 0) * 32;

    // Cari node jalan terdekat dengan posisi bangunan
    const nearestId = _findNearestNodeId(simulationState.graph, bx, by);
    if (nearestId) {
        requestRouteToNode(simulationState, nearestId);
    }
}


// ── Helper: utlitas graph ────────────────────────────────────────

function _getFirstNodeId(graph) {
    if (!graph || !graph.nodes || graph.nodes.size === 0) return null;
    return graph.nodes.keys().next().value;
}

function _findNearestNodeId(graph, wx, wy) {
    if (!graph || !graph.nodes) return null;
    let bestId   = null;
    let bestDist = Infinity;

    for (const [id, node] of graph.nodes.entries()) {
        const dx = node.x - wx;
        const dy = node.y - wy;
        const d2 = dx * dx + dy * dy; // kuadrat jarak, hindari sqrt yang mahal
        if (d2 < bestDist) {
            bestDist = d2;
            bestId   = id;
        }
    }
    return bestId;
}

/**
 * Fallback route jika graph belum tersedia.
 * Membuat jalur linear dari semua titik di rute_jalan.
 */
function _applyFallbackRoute(state) {
    const rute = state._rawMapData && state._rawMapData.rute_jalan;
    if (!rute || rute.length === 0) {
        console.warn('[animation.js] Tidak ada rute_jalan maupun roadGraph. Kereta tidak bergerak.');
        return;
    }

    // Konversi rute_jalan ke format node internal
    const path = rute.map((r, i) => ({
        id: `rj_${i}`,
        x:  r.x   !== undefined ? r.x   : (r.col || 0) * 64,
        y:  r.y   !== undefined ? r.y   : (r.row || 0) * 32,
    }));

    state.route.nodes        = path;
    state.route.currentIndex = 1;
    state.route.progress     = 0;

    if (path[0]) {
        state.carriage.x = path[0].x;
        state.carriage.y = path[0].y;
    }
}


// ╔══════════════════════════════════════════════════════════╗
// ║  SECTION 6 — GRAPH BUILDER                              ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Membangun graph adjacency list dari data map_grafika.json.
 * Mendukung dua format:
 * 1. Format baru: mapData.roadGraph (lebih ekspresif, support percabangan)
 * 2. Format lama: mapData.rute_jalan (fallback, dibuat linear graph)
 *
 * [AKADEMIS — ADJACENCY LIST VS ADJACENCY MATRIX]
 * Graph kota jalan biasanya sparse (jarang): setiap persimpangan
 * terhubung hanya ke 2–4 jalan. Adjacency list O(V + E) lebih
 * hemat memori vs adjacency matrix O(V²) yang mengalokasikan
 * seluruh V×V slot meskipun kebanyakan kosong.
 * Untuk V=50 node, matrix = 2500 entri; list = ~100-200 entri.
 *
 * @param {Object|null} mapData
 * @returns {{ nodes: Map, adjacency: Map }}
 */
function _buildGraph(mapData) {
    const nodes     = new Map(); // Map<id, {id, x, y, label?}>
    const adjacency = new Map(); // Map<id, Array<{to, cost}>>

    if (!mapData) return { nodes, adjacency };

    // ── Prioritas: gunakan roadGraph jika tersedia ─────────────
    if (mapData.roadGraph) {
        const rg = mapData.roadGraph;

        // Daftarkan semua node
        for (const node of (rg.nodes || [])) {
            if (!node.id) continue;
            nodes.set(node.id, {
                id:    node.id,
                x:     node.x || 0,
                y:     node.y || 0,
                label: node.label || node.nama || '',
            });
            adjacency.set(node.id, []);
        }

        // Daftarkan semua edge (bidirectional kecuali ditentukan one-way)
        for (const edge of (rg.edges || [])) {
            const nodeA = nodes.get(edge.from);
            const nodeB = nodes.get(edge.to);
            if (!nodeA || !nodeB) continue;

            // Biaya = jarak geometri × weight
            const dist = _heuristic(nodeA, nodeB);
            const cost = dist * Math.max(0.01, edge.weight || 1.0);

            adjacency.get(edge.from).push({ to: edge.to,   cost });

            // Bidirectional kecuali edge.oneWay === true
            if (!edge.oneWay) {
                adjacency.get(edge.to).push({ to: edge.from, cost });
            }
        }

        return { nodes, adjacency };
    }

    // ── Fallback: bangun graph linear dari rute_jalan ───────────
    // Semua titik rute_jalan dihubungkan berurutan: 0→1→2→...→n
    // Ini membatasi kereta hanya bisa bergerak di satu jalur lurus,
    // tetapi animasi tetap bisa berjalan tanpa format baru.
    const rute = mapData.rute_jalan || [];

    for (let i = 0; i < rute.length; i++) {
        const r  = rute[i];
        const id = `rj_${i}`;
        const x  = r.x   !== undefined ? r.x   : (r.col || 0) * 64;
        const y  = r.y   !== undefined ? r.y   : (r.row || 0) * 32;
        nodes.set(id, { id, x, y, label: r.nama || r.label || `Titik ${i}` });
        adjacency.set(id, []);
    }

    // Hubungkan berurutan (bidirectional linear path)
    for (let i = 0; i < rute.length - 1; i++) {
        const aId = `rj_${i}`;
        const bId = `rj_${i + 1}`;
        const a   = nodes.get(aId);
        const b   = nodes.get(bId);
        if (!a || !b) continue;
        const cost = _heuristic(a, b);
        adjacency.get(aId).push({ to: bId, cost });
        adjacency.get(bId).push({ to: aId, cost });
    }

    return { nodes, adjacency };
}

function _getFirstNode(graph, mapData) {
    if (graph && graph.nodes && graph.nodes.size > 0) {
        return graph.nodes.values().next().value;
    }
    const rute = mapData && mapData.rute_jalan;
    if (rute && rute.length > 0) {
        const r = rute[0];
        return {
            id: 'rj_0',
            x: r.x !== undefined ? r.x : (r.col || 0) * 64,
            y: r.y !== undefined ? r.y : (r.row || 0) * 32,
        };
    }
    return null;
}


// ╔══════════════════════════════════════════════════════════╗
// ║  SECTION 7 — CAMERA AUTO-FOLLOW                         ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Update posisi kamera agar mengikuti kereta kuda secara halus.
 *
 * Fungsi ini TIDAK memodifikasi engine.js secara langsung.
 * Ia hanya mengubah cameraState.panX / panY — yang merupakan
 * properti yang sudah dibaca engine.js untuk view matrix.
 * Ini adalah "data coupling" yang aman dan non-destruktif.
 *
 * @param {Object} simulationState
 * @param {Object} cameraState - { panX, panY, zoom, canvasWidth, canvasHeight }
 * @param {number} _deltaTime - Disimpan untuk kompatibilitas, tidak dipakai (Lerp tidak time-dependent)
 *
 * [AKADEMIS — SMOOTH CAMERA FOLLOW DENGAN LERP EKSPONENSIAL]
 *
 * Rumus: current = current + (target - current) × smoothing
 *
 * Ini disebut "exponential moving average" atau "Lerp per frame".
 * Sifatnya: setiap frame, sisa jarak ke target berkurang dengan faktor
 * (1 - smoothing). Setelah n frame, sisa jarak = (1-smooth)^n × jarak_awal.
 *
 * Contoh: smooth=0.08, jarak_awal=200px
 * - Frame 1: sisa = 0.92 × 200 = 184px
 * - Frame 10: sisa = 0.92^10 × 200 ≈ 85px
 * - Frame 30: sisa = 0.92^30 × 200 ≈ 16px  (kamera hampir tiba)
 *
 * Perhatian: ini time-dependent (bergantung FPS) untuk nilai smoothing konstan.
 * Untuk benar-benar time-independent, gunakan: smooth = 1 - exp(-k × dt).
 * Namun untuk WebGL 1.0 isometric yang target 60fps, perbedaannya kecil.
 */
export function updateCameraFollow(simulationState, cameraState, _deltaTime) {
    if (!simulationState || !cameraState) return;
    if (!simulationState.cameraFollow.enabled) return;

    const carX = simulationState.carriage.x;
    const carY = simulationState.carriage.y + simulationState.carriage.bobOffsetY;

    // Hitung target pan agar kereta berada di tengah canvas
    const halfW = (cameraState.canvasWidth  || 800) * 0.5;
    const halfH = (cameraState.canvasHeight || 600) * 0.5;
    const zoom  = cameraState.zoom || 1.0;

    // Dalam koordinat world: kamera harus bergeser sejauh ini
    // agar titik (carX, carY) muncul di tengah layar.
    const targetPanX = halfW / zoom - carX;
    const targetPanY = halfH / zoom - carY;

    // Lerp eksponensial menuju target (smooth follow)
    cameraState.panX += (targetPanX - cameraState.panX) * CAMERA_SMOOTHING;
    cameraState.panY += (targetPanY - cameraState.panY) * CAMERA_SMOOTHING;
}

/**
 * Matikan auto-follow. Dipanggil saat user melakukan input manual.
 * Lihat patch main.js untuk cara menyambungkan ke event listener.
 *
 * @param {Object} simulationState
 */
export function breakCameraFollow(simulationState) {
    if (!simulationState) return;
    simulationState.cameraFollow.enabled = false;
}

/**
 * Nyalakan kembali auto-follow. Bisa dipanggil dari tombol "Kembali ke Kereta".
 *
 * @param {Object} simulationState
 */
export function enableCameraFollow(simulationState) {
    if (!simulationState) return;
    simulationState.cameraFollow.enabled = true;
}
