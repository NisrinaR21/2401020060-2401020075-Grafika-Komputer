/**
 * Nama: Nisrina Retnosari
 * NIM: 2401020060
 * Kontribusi: Gerak visual kereta pada jalur kurva, tangent arah, frame animasi, bobbing, squash-stretch, shadow, dan day-night progress.
 *
 * Nama: Dhiya Zarifa Putri Marzuki
 * NIM: 2401020075
 * Kontribusi: Road graph, validasi konektivitas, Branch and Bound, randomisasi start/target, marker dinamis, dan camera follow.
 */

"use strict";

// ================================================================
// BAGIAN 1 — KONSTANTA ANIMASI DAN PATH
// ================================================================
// Konstanta dasar untuk kecepatan kereta, animasi visual, sampling jalur, dan pathfinding.

const CARRIAGE_SPEED = 112;
const BOB_FREQUENCY = 8.0;
const BOB_AMPLITUDE = 1.25;
const SQUASH_STRETCH_FACTOR = 0.024;

const WALK_FRAME_DURATION = 0.22;
const CAMERA_FOLLOW_STIFFNESS = 5.8;

const DEFAULT_EDGE_CURVE_STRENGTH = 34;
const EDGE_SAMPLE_SEGMENTS = 28;
const MAX_BRANCH_AND_BOUND_ITERATIONS = 9000;

const SHADOW_OFFSET_X = 6;
const SHADOW_OFFSET_Y = 5;

const DEFAULT_MIN_NODE_DEGREE = 2;
const DEFAULT_MIN_START_TARGET_DISTANCE = 580;

const EPSILON = 1e-6;

// ================================================================
// BAGIAN 2 — PUBLIC STATE FACTORY
// ================================================================
// Kontribusi bersama: state menggabungkan data visual kereta, graph, marker, dan day-night.

export function createAnimationState(mapData) {
  const graph = _buildGraph(mapData);
  const validation = _validateBuiltGraph(graph, mapData);
  graph.validation = validation;

  if (!validation.isConnected) {
    console.warn(
      "[animation.js] roadGraph belum fully connected. Cek map_variant karena ini berisiko melanggar aturan project.",
      validation,
    );
  }

  if (validation.deadEndNodeIds.length > 0) {
    console.warn(
      "[animation.js] Ada node buntu. Node ini tidak akan dipakai untuk Acak Posisi:",
      validation.deadEndNodeIds,
    );
  }

  const randomConfig = _resolveRandomizationConfig(mapData);
  const startNode = _resolveInitialStartNode(graph, mapData, randomConfig);
  const targetNode = _resolveInitialTargetNode(
    graph,
    mapData,
    randomConfig,
    startNode,
  );

  const dayNightConfig = mapData?.dayNight || {};
  const startHour = Number.isFinite(dayNightConfig.startHour)
    ? dayNightConfig.startHour
    : 12;
  const finishHour = Number.isFinite(dayNightConfig.finishHour)
    ? dayNightConfig.finishHour
    : 20;

  const state = {
    time: 0,
    isRunning: false,

    atlasData: mapData?.atlasData || {},
    atlasSize: mapData?.atlasSize || 2048,

    graph,
    graphValidation: validation,
    randomization: randomConfig,

    currentNodeId: startNode?.id || null,
    startNodeId: startNode?.id || null,
    targetNodeId: targetNode?.id || null,

    carriage: {
      x: startNode ? startNode.x : 0,
      y: startNode ? startNode.y : 0,
      rotation: 0,
      tangentX: 1,
      tangentY: 0,

      scaleX: 1.0,
      scaleY: 1.0,
      bobOffsetY: 0,

      directionKey: "kanan",
      frameIndex: 0,
      frameTimer: 0,
      spriteType: "kereta_kanan_01",
      atlasKey: "kereta_kanan_01",
      flipX: false,

      shadow: {
        x: 0,
        y: 0,
        scaleX: 1.3,
        scaleY: 0.4,
        skewX: 0.2,
        alpha: 0.34,
      },
    },

    route: _createEmptyRoute(),

    routeMarkers: {
      startFlag: _createMarkerTemplate(mapData, "start"),
      targetFlag: _createMarkerTemplate(mapData, "target"),
    },

    cameraFollow: {
      enabled: true,
      manualOverride: false,
    },

    dayNight: {
      enabled: dayNightConfig.enabled !== false,
      progress: 0,
      label: dayNightConfig.startLabel || "Siang",
      hour: startHour,
      startHour,
      finishHour,
      startLabel: dayNightConfig.startLabel || "Siang",
      midLabel: dayNightConfig.midLabel || "Sore",
      finishLabel: dayNightConfig.finishLabel || "Malam",
      timestamp: _formatHour(startHour),
    },

    pathfindingStats: {
      lastAlgorithm: "Branch and Bound",
      lastNodesExplored: 0,
      lastCost: 0,
      lastStatus: "Siaga",
      lastRouteNodeIds: [],
      lastRouteEdgeIds: [],
    },

    _rawMapData: mapData,
  };

  // Alias marker agar main.js dapat membaca start dan target secara langsung.
  state.startFlag = state.routeMarkers.startFlag;
  state.targetFlag = state.routeMarkers.targetFlag;

  _syncMarkersToNodes(state);
  _updateShadow(state);
  _updateCarriageSprite(state, 1, 0);
  _updateDayNight(state);

  if (
    state.startNodeId &&
    state.targetNodeId &&
    state.startNodeId !== state.targetNodeId
  ) {
    requestRouteToNode(state, state.targetNodeId, {
      keepRunning: false,
      resetCarriageToCurrentNode: true,
    });
  }

  return state;
}

// ================================================================
// BAGIAN 3 — UPDATE LOOP
// ================================================================
// Kontribusi Nisrina: update loop untuk gerak visual kereta dan perubahan waktu simulasi.

export function updateAnimations(simulationState, deltaTime) {
  if (!simulationState) return;

  const dt = Math.max(0, Math.min(Number(deltaTime) || 0, 0.05));
  simulationState.time += dt;

  if (simulationState.isRunning) {
    _updateCarriageMovement(simulationState, dt);
    _updateBobbingEffect(simulationState);
    _updateWalkFrame(simulationState, dt);
  } else {
    _relaxCarriagePose(simulationState);
  }

  _updateShadow(simulationState);
  _updateDayNight(simulationState);
}

// ================================================================
// BAGIAN 4 — START / PAUSE / TOGGLE
// ================================================================
// Kontribusi Dea: kontrol status simulasi yang digunakan oleh tombol Start/Pause.

export function startTrack(simulationState) {
  if (!simulationState) return false;

  if (
    !simulationState.route ||
    simulationState.route.nodes.length < 2 ||
    simulationState.route.completed
  ) {
    const targetId = simulationState.targetNodeId;
    if (targetId) {
      requestRouteToNode(simulationState, targetId, {
        keepRunning: false,
        resetCarriageToCurrentNode: true,
      });
    }
  }

  if (
    !simulationState.route ||
    simulationState.route.nodes.length < 2 ||
    simulationState.route.completed
  ) {
    simulationState.isRunning = false;
    simulationState.pathfindingStats.lastStatus = "Rute tidak tersedia";
    return false;
  }

  simulationState.isRunning = true;
  simulationState.pathfindingStats.lastStatus = "Berjalan";
  return true;
}

export function pauseTrack(simulationState) {
  if (!simulationState) return;
  simulationState.isRunning = false;
  if (simulationState.pathfindingStats) {
    simulationState.pathfindingStats.lastStatus = simulationState.route
      ?.completed
      ? "Selesai di Finish"
      : "Pause";
  }
}

export function toggleTrack(simulationState) {
  if (!simulationState) return false;

  if (simulationState.isRunning) {
    pauseTrack(simulationState);
    return false;
  }

  return startTrack(simulationState);
}

// ================================================================
// BAGIAN 5 — ACAK POSISI DAN ACAK TUJUAN
// ================================================================
// Kontribusi Dea: randomisasi node start dan target tanpa mengganti map aktif.

export function randomizeCarriagePosition(simulationState) {
  if (!simulationState?.graph) return false;

  const graph = simulationState.graph;
  const randomConfig =
    simulationState.randomization ||
    _resolveRandomizationConfig(simulationState._rawMapData);
  const candidates = _getRandomCandidateNodeIds(graph, randomConfig, "start");

  if (candidates.length < 2) {
    console.warn(
      "[randomizeCarriagePosition] Kandidat node valid kurang dari 2. Tidak bisa mengacak asal dan tujuan.",
    );
    simulationState.pathfindingStats.lastStatus = "Gagal Acak Posisi";
    return false;
  }

  const startId = _pickRandomFromArray(candidates);
  const startNode = graph.nodes.get(startId);

  const targetCandidates = _filterTargetCandidatesByDistance(
    graph,
    _getRandomCandidateNodeIds(graph, randomConfig, "target"),
    startNode,
    randomConfig.minStartTargetDistance,
  ).filter((id) => id !== startId);

  const finalTargetCandidates =
    targetCandidates.length > 0
      ? targetCandidates
      : candidates.filter((id) => id !== startId);

  if (finalTargetCandidates.length === 0) {
    console.warn(
      "[randomizeCarriagePosition] Tidak ada target berbeda dari start.",
    );
    simulationState.pathfindingStats.lastStatus = "Gagal Acak Posisi";
    return false;
  }

  const targetId = _pickRandomFromArray(finalTargetCandidates);

  simulationState.isRunning = false;
  simulationState.startNodeId = startId;
  simulationState.currentNodeId = startId;
  simulationState.targetNodeId = targetId;

  _moveCarriageToNode(simulationState, startId);
  _syncMarkersToNodes(simulationState);

  const ok = requestRouteToNode(simulationState, targetId, {
    keepRunning: false,
    resetCarriageToCurrentNode: true,
  });

  simulationState.pathfindingStats.lastStatus = ok
    ? "Posisi dan Tujuan Diacak"
    : "Rute Acak Gagal";
  return ok;
}

export function randomizeTargetPosition(simulationState) {
  if (!simulationState?.graph || !simulationState.currentNodeId) return false;

  const graph = simulationState.graph;
  const currentNode = graph.nodes.get(simulationState.currentNodeId);
  if (!currentNode) return false;

  const randomConfig =
    simulationState.randomization ||
    _resolveRandomizationConfig(simulationState._rawMapData);
  const candidates = _filterTargetCandidatesByDistance(
    graph,
    _getRandomCandidateNodeIds(graph, randomConfig, "target"),
    currentNode,
    randomConfig.minStartTargetDistance,
  ).filter((id) => id !== simulationState.currentNodeId);

  const fallbackCandidates = _getRandomCandidateNodeIds(
    graph,
    randomConfig,
    "target",
  ).filter((id) => id !== simulationState.currentNodeId);

  const finalCandidates =
    candidates.length > 0 ? candidates : fallbackCandidates;

  if (finalCandidates.length === 0) {
    console.warn("[randomizeTargetPosition] Tidak ada kandidat target valid.");
    simulationState.pathfindingStats.lastStatus = "Gagal Acak Tujuan";
    return false;
  }

  const targetId = _pickRandomFromArray(finalCandidates);
  const wasRunning = simulationState.isRunning;

  const ok = requestRouteToNode(simulationState, targetId, {
    keepRunning: wasRunning,
    resetCarriageToCurrentNode: true,
  });

  simulationState.pathfindingStats.lastStatus = ok
    ? "Tujuan Diacak"
    : "Rute Tujuan Gagal";
  return ok;
}

// ================================================================
// BAGIAN 6 — REQUEST ROUTE PUBLIC
// ================================================================
// Kontribusi Dea: permintaan rute dari node atau objek menuju target pada road graph.

export function requestRouteToNode(
  simulationState,
  targetNodeId,
  options = {},
) {
  if (!simulationState?.graph || !targetNodeId) return false;

  const graph = simulationState.graph;
  const startId = simulationState.currentNodeId || simulationState.startNodeId;

  if (!startId || !graph.nodes.has(startId) || !graph.nodes.has(targetNodeId)) {
    console.warn(
      `[requestRouteToNode] Start/target tidak valid: ${startId} → ${targetNodeId}`,
    );
    simulationState.pathfindingStats.lastStatus = "Start/Target Tidak Valid";
    return false;
  }

  if (startId === targetNodeId) {
    console.warn(
      "[requestRouteToNode] Start dan target sama. Rute tidak dibuat.",
    );
    simulationState.pathfindingStats.lastStatus = "Start dan Target Sama";
    return false;
  }

  const result = _branchAndBoundPathfind(graph, startId, targetNodeId);

  simulationState.pathfindingStats.lastAlgorithm = "Branch and Bound";
  simulationState.pathfindingStats.lastNodesExplored = result.nodesExplored;
  simulationState.pathfindingStats.lastCost = result.cost;

  if (!result.success) {
    simulationState.route = _createEmptyRoute();
    simulationState.isRunning = false;
    simulationState.pathfindingStats.lastStatus = "Rute Tidak Ditemukan";
    console.warn(
      `[requestRouteToNode] Branch and Bound gagal menemukan rute ${startId} → ${targetNodeId}.`,
    );
    return false;
  }

  simulationState.targetNodeId = targetNodeId;
  simulationState.route = _buildRouteFromPath(
    simulationState,
    result.nodeIds,
    result.edgeIds,
  );

  simulationState.pathfindingStats.lastRouteNodeIds = result.nodeIds.slice();
  simulationState.pathfindingStats.lastRouteEdgeIds = result.edgeIds.slice();
  simulationState.pathfindingStats.lastStatus = "Rute Siap";

  _syncMarkersToNodes(simulationState);

  if (options.resetCarriageToCurrentNode !== false) {
    _moveCarriageToNode(simulationState, startId);
  }

  _updateDayNight(simulationState);

  if (options.keepRunning === true) {
    startTrack(simulationState);
  } else {
    simulationState.isRunning = false;
  }

  return true;
}

export function requestRouteToBuilding(simulationState, buildingId) {
  if (!simulationState?._rawMapData || !buildingId) return false;

  const objects = _normalizeObjectList(simulationState._rawMapData);
  const targetObject = objects.find((obj) => obj?.id === buildingId);

  if (!targetObject) {
    console.warn(
      `[requestRouteToBuilding] Objek tidak ditemukan: ${buildingId}`,
    );
    return false;
  }

  let targetNodeId = targetObject.nearestNodeId || targetObject.nodeId || null;

  if (
    !targetNodeId &&
    Number.isFinite(targetObject.x) &&
    Number.isFinite(targetObject.y)
  ) {
    const nearest = _findNearestNode(
      simulationState.graph,
      targetObject.x,
      targetObject.y,
    );
    targetNodeId = nearest?.id || null;
  }

  if (!targetNodeId) {
    console.warn(
      `[requestRouteToBuilding] Objek tidak punya nearestNodeId: ${buildingId}`,
    );
    return false;
  }

  return requestRouteToNode(simulationState, targetNodeId, {
    keepRunning: simulationState.isRunning,
    resetCarriageToCurrentNode: true,
  });
}

// ================================================================
// BAGIAN 7 — CAMERA FOLLOW
// ================================================================
// Kontribusi Dea: kamera mengikuti posisi kereta dan dapat dimatikan saat user mengontrol kamera manual.

export function updateCameraFollow(simulationState, cameraState, deltaTime) {
  if (
    !simulationState?.cameraFollow?.enabled ||
    !cameraState ||
    !simulationState.carriage
  )
    return;

  const dt = Math.max(0, Math.min(Number(deltaTime) || 0, 0.05));
  const c = simulationState.carriage;

  const zoom = Math.max(0.01, Number(cameraState.zoom) || 1);
  const canvasWidth =
    Number(cameraState.canvasWidth) ||
    Number(cameraState._lastCanvasWidth) ||
    1;
  const canvasHeight =
    Number(cameraState.canvasHeight) ||
    Number(cameraState._lastCanvasHeight) ||
    1;

  const targetPanX = (canvasWidth * 0.5) / zoom - c.x;
  const targetPanY = (canvasHeight * 0.5) / zoom - c.y;

  const alpha = 1 - Math.exp(-CAMERA_FOLLOW_STIFFNESS * dt);

  cameraState.panX += (targetPanX - cameraState.panX) * alpha;
  cameraState.panY += (targetPanY - cameraState.panY) * alpha;
  cameraState.isDirty = true;
}

export function breakCameraFollow(simulationState) {
  if (!simulationState?.cameraFollow) return;
  simulationState.cameraFollow.enabled = false;
  simulationState.cameraFollow.manualOverride = true;
}

export function enableCameraFollow(simulationState) {
  if (!simulationState?.cameraFollow) return;
  simulationState.cameraFollow.enabled = true;
  simulationState.cameraFollow.manualOverride = false;
}

// ================================================================
// BAGIAN 8 — MARKER DINAMIS UNTUK MAIN.JS
// ================================================================
// Kontribusi Dea: marker start dan finish dibuat dinamis mengikuti node yang sedang aktif.

export function getDynamicRouteMarkerObjects(simulationState) {
  if (!simulationState?.routeMarkers) return [];

  const items = [];
  if (simulationState.routeMarkers.startFlag)
    items.push({ ...simulationState.routeMarkers.startFlag });
  if (simulationState.routeMarkers.targetFlag)
    items.push({ ...simulationState.routeMarkers.targetFlag });
  return items;
}

// ================================================================
// BAGIAN 9 — VALIDATOR ROADGRAPH PUBLIC
// ================================================================
// Kontribusi Dea: validasi konektivitas road graph sebelum peta digunakan untuk rute kereta.

export function validateRoadGraph(mapData) {
  const graph = _buildGraph(mapData);
  return _validateBuiltGraph(graph, mapData);
}

// ================================================================
// BAGIAN 10 — INTERNAL: GERAK KERETA DI ATAS KURVA
// ================================================================
// Kontribusi Nisrina: sampling posisi, tangent arah, frame kereta, bobbing, squash-stretch, dan shadow.

function _updateCarriageMovement(state, dt) {
  const route = state.route;

  if (!route || route.completed || route.segments.length === 0) {
    _onRouteCompleted(state);
    return;
  }

  let remainingDistance = route.speed * dt;

  while (remainingDistance > EPSILON && !route.completed) {
    const segment = route.segments[route.currentSegmentIndex];

    if (!segment) {
      _onRouteCompleted(state);
      return;
    }

    const distanceLeft = segment.length - route.distanceOnSegment;

    if (remainingDistance >= distanceLeft) {
      route.completedLength += Math.max(0, distanceLeft);
      remainingDistance -= Math.max(0, distanceLeft);
      route.currentSegmentIndex += 1;
      route.distanceOnSegment = 0;
      route.progress = 0;

      const arrivedNodeId = segment.toId;
      if (arrivedNodeId) state.currentNodeId = arrivedNodeId;

      if (route.currentSegmentIndex >= route.segments.length) {
        _onRouteCompleted(state);
        return;
      }
    } else {
      route.distanceOnSegment += remainingDistance;
      route.completedLength += remainingDistance;
      remainingDistance = 0;
    }
  }

  const activeSegment = route.segments[route.currentSegmentIndex];
  if (!activeSegment) {
    _onRouteCompleted(state);
    return;
  }

  const sample = _sampleRouteSegmentAtDistance(
    activeSegment,
    route.distanceOnSegment,
  );

  state.carriage.x = sample.x;
  state.carriage.y = sample.y;
  state.carriage.tangentX = sample.tangentX;
  state.carriage.tangentY = sample.tangentY;
  state.carriage.rotation = Math.atan2(sample.tangentY, sample.tangentX);

  route.progress =
    activeSegment.length > 0
      ? Math.max(0, Math.min(1, route.distanceOnSegment / activeSegment.length))
      : 1;

  _updateCarriageSprite(state, sample.tangentX, sample.tangentY);
}

function _onRouteCompleted(state) {
  const route = state.route;

  if (!route || route.completed) {
    if (state) state.isRunning = false;
    return;
  }

  const finalNodeId =
    state.targetNodeId || route.nodeIds[route.nodeIds.length - 1];
  const finalNode = finalNodeId ? state.graph.nodes.get(finalNodeId) : null;

  if (finalNode) {
    state.carriage.x = finalNode.x;
    state.carriage.y = finalNode.y;
    state.currentNodeId = finalNode.id;
  }

  route.currentSegmentIndex = route.segments.length;
  route.distanceOnSegment = 0;
  route.progress = 1;
  route.completed = true;
  route.completedLength = route.totalLength;

  state.isRunning = false;
  state.pathfindingStats.lastStatus = "Selesai di Finish";

  if (state.dayNight) {
    state.dayNight.progress = 1;
    state.dayNight.hour = state.dayNight.finishHour;
    state.dayNight.label = state.dayNight.finishLabel || "Malam";
    state.dayNight.timestamp = _formatHour(state.dayNight.hour);
  }
}

function _updateBobbingEffect(state) {
  const route = state.route;
  const isMoving = Boolean(
    state.isRunning && route && route.segments.length > 0 && !route.completed,
  );

  if (!isMoving) {
    _relaxCarriagePose(state);
    return;
  }

  const wave = Math.sin(state.time * BOB_FREQUENCY);

  state.carriage.bobOffsetY = wave * BOB_AMPLITUDE;
  state.carriage.scaleX = 1.0 + wave * SQUASH_STRETCH_FACTOR;
  state.carriage.scaleY = 1.0 - wave * SQUASH_STRETCH_FACTOR;
}

function _relaxCarriagePose(state) {
  if (!state?.carriage) return;

  const c = state.carriage;
  c.bobOffsetY *= 0.82;
  c.scaleX += (1.0 - c.scaleX) * 0.18;
  c.scaleY += (1.0 - c.scaleY) * 0.18;
}

function _updateWalkFrame(state, dt) {
  const c = state.carriage;
  if (!c) return;

  c.frameTimer += dt;

  if (c.frameTimer >= WALK_FRAME_DURATION) {
    c.frameTimer = 0;
    c.frameIndex = c.frameIndex === 0 ? 1 : 0;
  }

  _updateCarriageSprite(state, c.tangentX || 1, c.tangentY || 0);
}

function _updateCarriageSprite(state, tangentX, tangentY) {
  const c = state.carriage;
  if (!c) return;

  const tx = Number.isFinite(tangentX) ? tangentX : 1;
  const ty = Number.isFinite(tangentY) ? tangentY : 0;

  const absY = Math.abs(ty);
  const absX = Math.abs(tx);

  let baseDirection = "kanan";

  if (absY > absX * 0.42) {
    baseDirection = ty < 0 ? "kanan_atas" : "kanan_bawah";
  }

  const flipX = tx < 0;
  const frameSuffix = c.frameIndex === 0 ? "01" : "02";

  c.directionKey = flipX
    ? baseDirection.replace("kanan", "kiri")
    : baseDirection;
  c.spriteType = `kereta_${baseDirection}_${frameSuffix}`;
  c.atlasKey = c.spriteType;
  c.flipX = flipX;
}

function _updateShadow(state) {
  if (!state?.carriage) return;

  const c = state.carriage;
  const sh = c.shadow || (c.shadow = {});

  sh.x = c.x + SHADOW_OFFSET_X;
  sh.y = c.y + SHADOW_OFFSET_Y;

  const normalizedBob = BOB_AMPLITUDE > 0 ? c.bobOffsetY / BOB_AMPLITUDE : 0;
  const groundFactor = Math.max(0.35, 1.0 - normalizedBob * 0.12);

  sh.scaleX = 1.18 * groundFactor;
  sh.scaleY = 0.3 * groundFactor;
  sh.alpha = 0.24 * Math.max(0.45, groundFactor);
  sh.skewX = 0.12;
}

// ================================================================
// BAGIAN 11 — DAY / NIGHT PROGRESS
// ================================================================
// Kontribusi Nisrina: progres siang-malam mengikuti perjalanan kereta untuk efek visual renderer.

function _updateDayNight(state) {
  const dn = state.dayNight;
  if (!dn || dn.enabled === false) return;

  let progress = 0;

  if (state.route && state.route.totalLength > 0) {
    progress = state.route.completedLength / state.route.totalLength;
  }

  progress = Math.max(0, Math.min(1, progress));

  if (state.route?.completed) progress = 1;

  dn.progress = progress;
  dn.hour = dn.startHour + (dn.finishHour - dn.startHour) * progress;

  if (progress >= 0.72) {
    dn.label = dn.finishLabel || "Malam";
  } else if (progress >= 0.42) {
    dn.label = dn.midLabel || "Sore";
  } else {
    dn.label = dn.startLabel || "Siang";
  }

  dn.timestamp = _formatHour(dn.hour);
}

function _formatHour(hourValue) {
  const totalMinutes = Math.round((Number(hourValue) || 0) * 60);
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// ================================================================
// BAGIAN 12 — GRAPH BUILDING DAN VALIDASI
// ================================================================
// Kontribusi Dea: konversi node-edge map JSON menjadi road graph yang siap dipakai pathfinding.

function _buildGraph(mapData) {
  const nodes = new Map();
  const edges = [];
  const adjacency = new Map();
  const degree = new Map();

  const rawNodes = mapData?.roadGraph?.nodes || mapData?.rute_jalan || [];
  const rawEdges = mapData?.roadGraph?.edges || [];

  for (const node of rawNodes) {
    if (!node || !node.id) continue;

    const normalized = {
      ...node,
      id: String(node.id),
      x: Number(node.x) || 0,
      y: Number(node.y) || 0,
      label: node.label || String(node.id),
      canBeStart: node.canBeStart !== false,
      canBeTarget: node.canBeTarget !== false,
    };

    nodes.set(normalized.id, normalized);
    adjacency.set(normalized.id, []);
    degree.set(normalized.id, 0);
  }

  if (rawEdges.length > 0) {
    for (const edge of rawEdges) {
      if (!edge || !edge.id || !edge.from || !edge.to) continue;
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;

      const fromNode = nodes.get(edge.from);
      const toNode = nodes.get(edge.to);
      const geometricLength = _distance2D(fromNode, toNode);
      const weight = Number.isFinite(edge.weight)
        ? Math.max(0.01, Number(edge.weight))
        : 1;

      const normalizedEdge = {
        ...edge,
        id: String(edge.id),
        from: String(edge.from),
        to: String(edge.to),
        oneWay: edge.oneWay === true,
        weight,
        cost: geometricLength * weight,
        length: geometricLength,
      };

      edges.push(normalizedEdge);
      _addAdjacency(
        adjacency,
        normalizedEdge.from,
        normalizedEdge.to,
        normalizedEdge,
        normalizedEdge.cost,
      );
      degree.set(
        normalizedEdge.from,
        (degree.get(normalizedEdge.from) || 0) + 1,
      );
      degree.set(normalizedEdge.to, (degree.get(normalizedEdge.to) || 0) + 1);

      if (!normalizedEdge.oneWay) {
        _addAdjacency(
          adjacency,
          normalizedEdge.to,
          normalizedEdge.from,
          normalizedEdge,
          normalizedEdge.cost,
        );
      }
    }
  } else {
    // Fallback rute_jalan: bentuk loop agar jalur tetap terhubung.
    const nodeList = Array.from(nodes.values());
    for (let i = 0; i < nodeList.length; i++) {
      const a = nodeList[i];
      const b = nodeList[(i + 1) % nodeList.length];
      if (!a || !b || a.id === b.id) continue;

      const fallbackEdge = {
        id: `fallback_edge_${String(i + 1).padStart(2, "0")}`,
        from: a.id,
        to: b.id,
        terrain: "dirt",
        category: "main",
        width: 80,
        oneWay: false,
        weight: 1,
        cost: _distance2D(a, b),
        length: _distance2D(a, b),
      };

      edges.push(fallbackEdge);
      _addAdjacency(adjacency, a.id, b.id, fallbackEdge, fallbackEdge.cost);
      _addAdjacency(adjacency, b.id, a.id, fallbackEdge, fallbackEdge.cost);
      degree.set(a.id, (degree.get(a.id) || 0) + 1);
      degree.set(b.id, (degree.get(b.id) || 0) + 1);
    }
  }

  return {
    nodes,
    edges,
    adjacency,
    degree,
    mapData,
  };
}

function _addAdjacency(adjacency, from, to, edge, cost) {
  if (!adjacency.has(from)) adjacency.set(from, []);
  adjacency.get(from).push({ to, edge, cost });
}

function _validateBuiltGraph(graph, mapData) {
  const nodeIds = Array.from(graph.nodes.keys());
  const edgeIds = graph.edges.map((edge) => edge.id);
  const missingReferenceEdges = [];
  const deadEndNodeIds = [];
  const isolatedNodeIds = [];

  for (const edge of mapData?.roadGraph?.edges || []) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) {
      missingReferenceEdges.push(edge.id || `${edge.from}->${edge.to}`);
    }
  }

  for (const nodeId of nodeIds) {
    const d = graph.degree.get(nodeId) || 0;
    if (d === 0) isolatedNodeIds.push(nodeId);
    if (d === 1) deadEndNodeIds.push(nodeId);
  }

  const reachable = _collectReachableNodeIds(graph, nodeIds[0]);
  const unreachableNodeIds = nodeIds.filter((id) => !reachable.has(id));

  const isConnected =
    nodeIds.length === 0 ? false : unreachableNodeIds.length === 0;
  const noDeadEnds =
    deadEndNodeIds.length === 0 && isolatedNodeIds.length === 0;

  return {
    nodeCount: nodeIds.length,
    edgeCount: edgeIds.length,
    isConnected,
    noDeadEnds,
    isStrictlyValid:
      isConnected && noDeadEnds && missingReferenceEdges.length === 0,
    isolatedNodeIds,
    deadEndNodeIds,
    unreachableNodeIds,
    missingReferenceEdges,
  };
}

function _collectReachableNodeIds(graph, startId) {
  const visited = new Set();
  if (!startId || !graph.nodes.has(startId)) return visited;

  const stack = [startId];
  visited.add(startId);

  while (stack.length > 0) {
    const current = stack.pop();
    const neighbors = graph.adjacency.get(current) || [];

    for (const entry of neighbors) {
      if (!visited.has(entry.to)) {
        visited.add(entry.to);
        stack.push(entry.to);
      }
    }
  }

  return visited;
}

// ================================================================
// BAGIAN 13 — BRANCH AND BOUND PATHFINDING
// ================================================================
// Kontribusi Dea: pencarian rute berbasis cost dari node start menuju node target.

function _branchAndBoundPathfind(graph, startId, targetId) {
  const start = graph.nodes.get(startId);
  const target = graph.nodes.get(targetId);

  if (!start || !target) {
    return {
      success: false,
      nodeIds: [],
      edgeIds: [],
      cost: Infinity,
      nodesExplored: 0,
    };
  }

  let bestCost = Infinity;
  let bestNodePath = null;
  let bestEdgePath = null;
  let nodesExplored = 0;

  const queue = [
    {
      nodeId: startId,
      cost: 0,
      estimate: _distance2D(start, target),
      nodePath: [startId],
      edgePath: [],
      visited: new Set([startId]),
    },
  ];

  while (queue.length > 0 && nodesExplored < MAX_BRANCH_AND_BOUND_ITERATIONS) {
    queue.sort((a, b) => a.estimate - b.estimate);
    const current = queue.shift();
    nodesExplored += 1;

    if (!current || current.cost >= bestCost) continue;

    if (current.nodeId === targetId) {
      bestCost = current.cost;
      bestNodePath = current.nodePath;
      bestEdgePath = current.edgePath;
      continue;
    }

    const neighbors = graph.adjacency.get(current.nodeId) || [];

    for (const entry of neighbors) {
      if (!entry || !entry.to || current.visited.has(entry.to)) continue;

      const nextCost = current.cost + entry.cost;
      if (nextCost >= bestCost) continue;

      const nextNode = graph.nodes.get(entry.to);
      if (!nextNode) continue;

      const nextVisited = new Set(current.visited);
      nextVisited.add(entry.to);

      const heuristic = _distance2D(nextNode, target) * 0.001;

      queue.push({
        nodeId: entry.to,
        cost: nextCost,
        estimate: nextCost + heuristic,
        nodePath: current.nodePath.concat(entry.to),
        edgePath: current.edgePath.concat(entry.edge.id),
        visited: nextVisited,
      });
    }
  }

  return {
    success: Array.isArray(bestNodePath) && bestNodePath.length >= 2,
    nodeIds: bestNodePath || [],
    edgeIds: bestEdgePath || [],
    cost: Number.isFinite(bestCost) ? bestCost : Infinity,
    nodesExplored,
  };
}

// ================================================================
// BAGIAN 14 — ROUTE SAMPLING BERBASIS BÉZIER
// ================================================================
// Kontribusi Nisrina: route hasil pathfinding diubah menjadi sampel kurva untuk gerak kereta.

function _buildRouteFromPath(state, nodeIds, edgeIds) {
  const route = _createEmptyRoute();

  route.nodeIds = nodeIds.slice();
  route.edgeIds = edgeIds.slice();
  route.nodes = nodeIds.map((id) => state.graph.nodes.get(id)).filter(Boolean);
  route.edges = edgeIds
    .map((id) => state.graph.edges.find((edge) => edge.id === id))
    .filter(Boolean);

  for (let i = 0; i < edgeIds.length; i++) {
    const edge = state.graph.edges.find((item) => item.id === edgeIds[i]);
    const fromId = nodeIds[i];
    const toId = nodeIds[i + 1];

    if (!edge || !fromId || !toId) continue;

    const segment = _sampleEdgeForTraversal(state.graph, edge, fromId, toId);
    if (segment && segment.length > EPSILON) {
      route.segments.push(segment);
      route.segmentLengths.push(segment.length);
      route.totalLength += segment.length;
    }
  }

  route.currentSegmentIndex = 0;
  route.distanceOnSegment = 0;
  route.completedLength = 0;
  route.progress = 0;
  route.completed = route.segments.length === 0;

  return route;
}

function _createEmptyRoute() {
  return {
    nodeIds: [],
    edgeIds: [],
    nodes: [],
    edges: [],
    segments: [],
    currentSegmentIndex: 0,
    distanceOnSegment: 0,
    progress: 0,
    speed: CARRIAGE_SPEED,
    completed: false,
    totalLength: 0,
    completedLength: 0,
    segmentLengths: [],
  };
}

function _sampleEdgeForTraversal(graph, edge, traversalFromId, traversalToId) {
  const baseFrom = graph.nodes.get(edge.from);
  const baseTo = graph.nodes.get(edge.to);

  if (!baseFrom || !baseTo) return null;

  const controls = _resolveBezierControls(baseFrom, baseTo, edge);
  const forwardSamples = [];

  for (let i = 0; i <= EDGE_SAMPLE_SEGMENTS; i++) {
    const t = i / EDGE_SAMPLE_SEGMENTS;
    const p = _cubicBezierPoint(
      controls.P0,
      controls.P1,
      controls.P2,
      controls.P3,
      t,
    );
    const tangent = _cubicBezierTangent(
      controls.P0,
      controls.P1,
      controls.P2,
      controls.P3,
      t,
    );

    forwardSamples.push({
      x: p.x,
      y: p.y,
      tangentX: tangent.x,
      tangentY: tangent.y,
      cumulative: 0,
    });
  }

  const samples =
    traversalFromId === edge.from && traversalToId === edge.to
      ? forwardSamples
      : forwardSamples
          .slice()
          .reverse()
          .map((sample) => ({
            ...sample,
            tangentX: -sample.tangentX,
            tangentY: -sample.tangentY,
            cumulative: 0,
          }));

  let cumulative = 0;
  samples[0].cumulative = 0;

  for (let i = 1; i < samples.length; i++) {
    cumulative += _distance2D(samples[i - 1], samples[i]);
    samples[i].cumulative = cumulative;
  }

  return {
    edgeId: edge.id,
    fromId: traversalFromId,
    toId: traversalToId,
    samples,
    length: cumulative,
  };
}

function _sampleRouteSegmentAtDistance(segment, distance) {
  const samples = segment.samples || [];
  if (samples.length === 0) return { x: 0, y: 0, tangentX: 1, tangentY: 0 };
  if (samples.length === 1) return samples[0];

  const d = Math.max(0, Math.min(distance, segment.length));

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];

    if (d <= curr.cumulative) {
      const span = curr.cumulative - prev.cumulative;
      const localT = span > EPSILON ? (d - prev.cumulative) / span : 0;

      const x = prev.x + (curr.x - prev.x) * localT;
      const y = prev.y + (curr.y - prev.y) * localT;
      const tangent = _normalize2D(curr.x - prev.x, curr.y - prev.y);

      return {
        x,
        y,
        tangentX: tangent.x,
        tangentY: tangent.y,
      };
    }
  }

  const last = samples[samples.length - 1];
  const prev = samples[samples.length - 2];
  const tangent = _normalize2D(last.x - prev.x, last.y - prev.y);

  return {
    x: last.x,
    y: last.y,
    tangentX: tangent.x,
    tangentY: tangent.y,
  };
}

function _resolveBezierControls(a, b, edge) {
  if (edge?.curve?.p1 && edge?.curve?.p2) {
    return {
      P0: a,
      P1: { x: Number(edge.curve.p1.x) || 0, y: Number(edge.curve.p1.y) || 0 },
      P2: { x: Number(edge.curve.p2.x) || 0, y: Number(edge.curve.p2.y) || 0 },
      P3: b,
    };
  }

  return _makeCurvedControls(a, b, edge?.id || `${a.id}_${b.id}`);
}

function _makeCurvedControls(
  a,
  b,
  edgeId,
  curveStrength = DEFAULT_EDGE_CURVE_STRENGTH,
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  const nx = -dy / len;
  const ny = dx / len;

  const hash = _stableHash01(edgeId || `${a.id}_${b.id}`);
  const direction = hash < 0.5 ? -1 : 1;
  const bend = Math.min(len * 0.22, curveStrength) * direction;

  return {
    P0: a,
    P1: { x: a.x + dx * 0.33 + nx * bend, y: a.y + dy * 0.33 + ny * bend },
    P2: { x: a.x + dx * 0.66 + nx * bend, y: a.y + dy * 0.66 + ny * bend },
    P3: b,
  };
}

function _cubicBezierPoint(P0, P1, P2, P3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * P0.x + 3 * mt2 * t * P1.x + 3 * mt * t2 * P2.x + t3 * P3.x,
    y: mt3 * P0.y + 3 * mt2 * t * P1.y + 3 * mt * t2 * P2.y + t3 * P3.y,
  };
}

function _cubicBezierTangent(P0, P1, P2, P3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  const x =
    3 * mt2 * (P1.x - P0.x) +
    6 * mt * t * (P2.x - P1.x) +
    3 * t2 * (P3.x - P2.x);

  const y =
    3 * mt2 * (P1.y - P0.y) +
    6 * mt * t * (P2.y - P1.y) +
    3 * t2 * (P3.y - P2.y);

  return _normalize2D(x, y);
}

// ================================================================
// BAGIAN 15 — MARKER DAN NODE UTILITY
// ================================================================
// Kontribusi Dea: utilitas node untuk marker, randomisasi, dan pencarian node terdekat.

function _createMarkerTemplate(mapData, kind) {
  const routeMarkerConfig = mapData?.penanda_rute || {};
  const source =
    kind === "start"
      ? routeMarkerConfig.startFlag
      : routeMarkerConfig.targetFlag;

  return {
    id: kind === "start" ? "dynamic_start_flag" : "dynamic_target_flag",
    type: source?.type || (kind === "start" ? "start_flag" : "target_flag"),
    x: Number(source?.x) || 0,
    y: Number(source?.y) || 0,
    offsetX: Number.isFinite(source?.offsetX)
      ? source.offsetX
      : kind === "start"
        ? -22
        : 22,
    offsetY: Number.isFinite(source?.offsetY) ? source.offsetY : -34,
    scale: Number.isFinite(source?.scale) ? source.scale : 0.42,
    layer: Number.isFinite(source?.layer) ? source.layer : 3,
    sortOffsetY: Number.isFinite(source?.sortOffsetY)
      ? source.sortOffsetY
      : -18,
  };
}

function _syncMarkersToNodes(state) {
  if (!state?.graph || !state.routeMarkers) return;

  const startNode = state.startNodeId
    ? state.graph.nodes.get(state.startNodeId)
    : null;
  const targetNode = state.targetNodeId
    ? state.graph.nodes.get(state.targetNodeId)
    : null;

  if (startNode && state.routeMarkers.startFlag) {
    const flag = state.routeMarkers.startFlag;
    flag.x = startNode.x + (flag.offsetX || 0);
    flag.y = startNode.y + (flag.offsetY || 0);
    flag.nearestNodeId = startNode.id;
  }

  if (targetNode && state.routeMarkers.targetFlag) {
    const flag = state.routeMarkers.targetFlag;
    flag.x = targetNode.x + (flag.offsetX || 0);
    flag.y = targetNode.y + (flag.offsetY || 0);
    flag.nearestNodeId = targetNode.id;
  }

  state.startFlag = state.routeMarkers.startFlag;
  state.targetFlag = state.routeMarkers.targetFlag;
}

function _moveCarriageToNode(state, nodeId) {
  const node = state.graph.nodes.get(nodeId);
  if (!node) return false;

  state.carriage.x = node.x;
  state.carriage.y = node.y;
  state.carriage.bobOffsetY = 0;
  state.carriage.scaleX = 1;
  state.carriage.scaleY = 1;
  state.currentNodeId = node.id;

  _updateShadow(state);
  _updateCarriageSprite(
    state,
    state.carriage.tangentX || 1,
    state.carriage.tangentY || 0,
  );
  return true;
}

function _resolveInitialStartNode(graph, mapData, randomConfig) {
  const requestedId = mapData?.penanda_rute?.startNodeId;

  if (_isNodeValidForRandom(graph, requestedId, randomConfig, "start")) {
    return graph.nodes.get(requestedId);
  }

  const candidates = _getRandomCandidateNodeIds(graph, randomConfig, "start");
  return (
    graph.nodes.get(candidates[0]) ||
    Array.from(graph.nodes.values())[0] ||
    null
  );
}

function _resolveInitialTargetNode(graph, mapData, randomConfig, startNode) {
  const requestedId = mapData?.penanda_rute?.targetNodeId;

  if (
    requestedId &&
    requestedId !== startNode?.id &&
    _isNodeValidForRandom(graph, requestedId, randomConfig, "target")
  ) {
    return graph.nodes.get(requestedId);
  }

  const candidates = _filterTargetCandidatesByDistance(
    graph,
    _getRandomCandidateNodeIds(graph, randomConfig, "target"),
    startNode,
    randomConfig.minStartTargetDistance,
  ).filter((id) => id !== startNode?.id);

  const fallback = _getRandomCandidateNodeIds(
    graph,
    randomConfig,
    "target",
  ).filter((id) => id !== startNode?.id);

  const finalCandidates = candidates.length > 0 ? candidates : fallback;
  return graph.nodes.get(finalCandidates[0]) || null;
}

function _resolveRandomizationConfig(mapData) {
  const cfg = mapData?.randomization || {};

  return {
    allowRandomStart: cfg.allowRandomStart !== false,
    allowRandomTarget: cfg.allowRandomTarget !== false,
    minNodeDegree: Number.isFinite(cfg.minNodeDegree)
      ? cfg.minNodeDegree
      : DEFAULT_MIN_NODE_DEGREE,
    minStartTargetDistance: Number.isFinite(cfg.minStartTargetDistance)
      ? cfg.minStartTargetDistance
      : DEFAULT_MIN_START_TARGET_DISTANCE,
    excludeNodeIds: Array.isArray(cfg.excludeNodeIds)
      ? cfg.excludeNodeIds.map(String)
      : [],
    preferredStartNodes: Array.isArray(cfg.preferredStartNodes)
      ? cfg.preferredStartNodes.map(String)
      : [],
    preferredTargetNodes: Array.isArray(cfg.preferredTargetNodes)
      ? cfg.preferredTargetNodes.map(String)
      : [],
  };
}

function _getRandomCandidateNodeIds(graph, randomConfig, mode) {
  const preferred =
    mode === "start"
      ? randomConfig.preferredStartNodes
      : randomConfig.preferredTargetNodes;

  const preferredValid = preferred.filter((id) =>
    _isNodeValidForRandom(graph, id, randomConfig, mode),
  );
  if (preferredValid.length > 0) return preferredValid;

  return Array.from(graph.nodes.keys()).filter((id) =>
    _isNodeValidForRandom(graph, id, randomConfig, mode),
  );
}

function _isNodeValidForRandom(graph, nodeId, randomConfig, mode) {
  if (!nodeId || !graph.nodes.has(nodeId)) return false;
  if (randomConfig.excludeNodeIds.includes(nodeId)) return false;

  const node = graph.nodes.get(nodeId);
  const degree = graph.degree.get(nodeId) || 0;

  if (degree < randomConfig.minNodeDegree) return false;
  if (mode === "start" && node.canBeStart === false) return false;
  if (mode === "target" && node.canBeTarget === false) return false;

  return true;
}

function _filterTargetCandidatesByDistance(
  graph,
  candidateIds,
  startNode,
  minDistance,
) {
  if (!startNode) return candidateIds.slice();

  return candidateIds.filter((id) => {
    const node = graph.nodes.get(id);
    if (!node) return false;
    return _distance2D(startNode, node) >= minDistance;
  });
}

function _findNearestNode(graph, x, y) {
  let best = null;
  let bestDist = Infinity;

  for (const node of graph.nodes.values()) {
    const dist = _distance2D({ x, y }, node);
    if (dist < bestDist) {
      bestDist = dist;
      best = node;
    }
  }

  return best;
}

function _normalizeObjectList(mapData) {
  if (Array.isArray(mapData?.objek_statis)) return mapData.objek_statis;
  if (Array.isArray(mapData?.buildings)) return mapData.buildings;
  if (Array.isArray(mapData?.objects)) return mapData.objects;
  if (Array.isArray(mapData?.sprites)) return mapData.sprites;
  return [];
}

// ================================================================
// BAGIAN 16 — MATH UTILITY
// ================================================================
// Fungsi matematika pendukung untuk jarak, normalisasi, hash stabil, dan pemilihan acak.

function _distance2D(a, b) {
  const dx = (Number(b?.x) || 0) - (Number(a?.x) || 0);
  const dy = (Number(b?.y) || 0) - (Number(a?.y) || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function _normalize2D(x, y) {
  const len = Math.sqrt(x * x + y * y);
  if (len < EPSILON) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
}

function _stableHash01(text) {
  let h = 2166136261;
  const s = String(text);

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }

  return ((h >>> 0) % 1000) / 1000;
}

function _pickRandomFromArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
