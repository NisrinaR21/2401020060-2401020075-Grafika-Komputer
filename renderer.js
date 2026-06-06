/**
 * Nama: Nisrina Retnosari
 * NIM: 2401020060
 * Kontribusi: Road rendering, kurva Bezier, mesh triangle, vertex buffer jalan, dan shader jalan.
 *
 * Nama: Dhiya Zarifa Putri Marzuki
 * NIM: 2401020075
 * Kontribusi: Texture setup, UV atlas, sprite rendering, z-sorting, occlusion, dan lighting overlay.
 */

"use strict";

// ============================================================
// BAGIAN 1 — KONSTANTA UMUM
// ============================================================
// Konstanta dasar renderer yang dipakai oleh road dan sprite renderer.

const DEFAULT_ATLAS_SIZE = 2048;
const DEFAULT_ROAD_WIDTH = 32;
const DEFAULT_ROAD_SEGMENTS = 18;
const DEFAULT_EDGE_CURVE_STRENGTH = 34;
const ROAD_ENDPOINT_EXTENSION = 0.006;

/** Penutup simpang agar pertemuan beberapa edge tidak tampak putus/berlubang. */
const JUNCTION_CIRCLE_SEGMENTS = 18;

/** Skala dasar kereta. scaleX/scaleY dari animation.js hanya untuk squash-stretch. */
const DEFAULT_CARRIAGE_BASE_SCALE = 0.32;

const _warnedMissingAtlasKeys = new Set();

// ============================================================
// BAGIAN 2 — SHADER HELPER
// ============================================================
// Pendukung umum untuk kompilasi shader, pembuatan program, matrix kamera, dan warna.

function _compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`[renderer.js] Gagal membuat shader: ${label}`);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`[renderer.js] Gagal compile shader ${label}:\n${info}`);
  }

  return shader;
}

function _createProgram(gl, vertSrc, fragSrc, label) {
  const program = gl.createProgram();
  if (!program)
    throw new Error(`[renderer.js] Gagal membuat program: ${label}`);

  const vertShader = _compileShader(
    gl,
    gl.VERTEX_SHADER,
    vertSrc,
    `${label} vertex`,
  );
  const fragShader = _compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    fragSrc,
    `${label} fragment`,
  );

  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);

  gl.deleteShader(vertShader);
  gl.deleteShader(fragShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`[renderer.js] Gagal link program ${label}:\n${info}`);
  }

  return program;
}

function _getViewProjectionMatrix(cameraState) {
  return (
    cameraState?.viewProjectionMatrix ||
    cameraState?.viewMatrix ||
    cameraState?.matrix ||
    cameraState?.projectionMatrix ||
    null
  );
}

function _hexToRgb01(hex, fallback) {
  if (typeof hex !== "string") return fallback;
  const clean = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;

  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

// ============================================================
// BAGIAN 3 — ROAD SHADER DAN ROAD RENDERER
// ============================================================
// Kontribusi Nisrina: shader jalan dan kelas RoadRenderer untuk menggambar mesh jalan di WebGL.

const ROAD_VERT_SRC = `
  attribute vec2 a_position;
  attribute vec2 a_uv;
  attribute vec4 a_roadColor;
  attribute vec4 a_edgeColor;

  uniform mat4 uViewProjectionMatrix;
  uniform float u_time;
  uniform float u_dayNight;

  varying vec2 v_uv;
  varying vec4 v_roadColor;
  varying vec4 v_edgeColor;
  varying float v_time;
  varying float v_dayNight;

  void main() {
    gl_Position = uViewProjectionMatrix * vec4(a_position, 0.0, 1.0);
    v_uv = a_uv;
    v_roadColor = a_roadColor;
    v_edgeColor = a_edgeColor;
    v_time = u_time;
    v_dayNight = u_dayNight;
  }
`;

const ROAD_FRAG_SRC = `
  precision mediump float;
  varying vec2 v_uv;
  varying vec4 v_roadColor;
  varying vec4 v_edgeColor;
  varying float v_time;
  varying float v_dayNight;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    float x = clamp(v_uv.x, 0.0, 1.0);
    float y = v_uv.y;
    float d = min(x, 1.0 - x);

    // Jalan tanah medieval dibuat tipis agar tidak terlihat seperti pipa.
    float feather = smoothstep(0.015, 0.090, d);
    float body = smoothstep(0.075, 0.180, d);
    float center = smoothstep(0.260, 0.460, d);
    float shoulder = smoothstep(0.070, 0.155, d) * (1.0 - smoothstep(0.180, 0.310, d));

    vec3 road = v_roadColor.rgb;
    vec3 edge = v_edgeColor.rgb;
    vec3 packedColor = road * vec3(0.92, 0.84, 0.70);
    vec3 dusty = road * vec3(1.10, 1.03, 0.86);

    vec3 base = mix(edge * 0.92, packedColor, feather);
    base = mix(base, road, body * 0.60);
    base = mix(base, dusty, center * 0.32);
    base = mix(base, edge * 1.04, shoulder * 0.10);

    // Bekas roda dibuat tipis agar tetap sesuai nuansa medieval.
    float rutA = 1.0 - smoothstep(0.014, 0.044, abs(x - 0.36));
    float rutB = 1.0 - smoothstep(0.014, 0.044, abs(x - 0.64));
    float broken = 0.55 + 0.45 * sin(y * 2.0 + sin(y * 0.41));
    float ruts = (rutA + rutB) * 0.5 * broken * body;
    base = mix(base, base * vec3(0.80, 0.73, 0.60), ruts * 0.20);

    // Butiran tanah procedural menjaga detail jalan tetap terlihat saat zoom.
    float grain = sin(y * 14.0 + x * 33.0) * 0.010 + sin(y * 39.0 - x * 17.0) * 0.006;
    grain += (hash21(vec2(floor(x * 38.0), floor(y * 1.0))) - 0.5) * 0.012;
    base += grain * body;

    // Tepi jalan dibuat ringan agar persimpangan tidak terlihat bertumpuk.
    float outer = 1.0 - smoothstep(0.018, 0.075, d);
    base = mix(base, edge * 0.88, outer * 0.20);

    float night = clamp(v_dayNight, 0.0, 1.0);
    float dusk = smoothstep(0.25, 0.62, night) * (1.0 - smoothstep(0.68, 0.92, night));
    base = mix(base, base * vec3(1.06, 0.91, 0.72), dusk * 0.08);
    base = mix(base, base * vec3(0.60, 0.66, 0.83), smoothstep(0.46, 1.0, night) * 0.18);

    gl_FragColor = vec4(base, 1.0);
  }
`;

class RoadRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = _createProgram(
      gl,
      ROAD_VERT_SRC,
      ROAD_FRAG_SRC,
      "RoadRenderer",
    );

    this.aPosition = gl.getAttribLocation(this.program, "a_position");
    this.aUv = gl.getAttribLocation(this.program, "a_uv");
    this.aRoadColor = gl.getAttribLocation(this.program, "a_roadColor");
    this.aEdgeColor = gl.getAttribLocation(this.program, "a_edgeColor");

    this.uCamera = gl.getUniformLocation(this.program, "uViewProjectionMatrix");
    this.uTime = gl.getUniformLocation(this.program, "u_time");
    this.uDayNight = gl.getUniformLocation(this.program, "u_dayNight");

    this.vbo = gl.createBuffer();
  }
}

// ============================================================
// BAGIAN 4 — MATEMATIKA JALAN BÉZIER
// ============================================================
// Kontribusi Nisrina: fungsi Bézier, pembentukan mesh triangle jalan, dan setup vertex buffer jalan.

function _distance2D(a, b) {
  const dx = (b.x || 0) - (a.x || 0);
  const dy = (b.y || 0) - (a.y || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function _normalize2D(x, y) {
  const len = Math.sqrt(x * x + y * y);
  if (len < 1e-6) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
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

function _stableHash01(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return ((h >>> 0) % 1000) / 1000;
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

  const tx = dx / len;
  const ty = dy / len;

  const nx = -ty;
  const ny = tx;

  const hash = _stableHash01(edgeId || `${a.id}_${b.id}`);
  const direction = hash < 0.5 ? -1 : 1;

  // Kurva dibuat proporsional terhadap panjang edge agar jalan tidak tampak seperti grid kaku.
  const bend = Math.min(len * 0.22, curveStrength) * direction;

  return {
    P0: a,
    P1: {
      x: a.x + dx * 0.33 + nx * bend,
      y: a.y + dy * 0.33 + ny * bend,
    },
    P2: {
      x: a.x + dx * 0.66 + nx * bend,
      y: a.y + dy * 0.66 + ny * bend,
    },
    P3: b,
  };
}

function _terrainColors(edge, roadStyle) {
  const fallbackRoad = _hexToRgb01(roadStyle?.roadColor, [0.82, 0.67, 0.42]);
  const fallbackEdge = _hexToRgb01(roadStyle?.edgeColor, [0.54, 0.4, 0.24]);
  switch (edge?.terrain) {
    case "bridge":
      return { road: [0.64, 0.43, 0.24, 1.0], edge: [0.36, 0.22, 0.12, 1.0] };
    case "stone":
      return { road: [0.66, 0.61, 0.51, 1.0], edge: [0.43, 0.38, 0.3, 1.0] };
    case "mud":
      return { road: [0.63, 0.49, 0.3, 1.0], edge: [0.42, 0.3, 0.17, 1.0] };
    case "dirt":
    default:
      return { road: [...fallbackRoad, 1.0], edge: [...fallbackEdge, 1.0] };
  }
}

function _pushRoadVertex(buffer, x, y, u, v, roadColor, edgeColor) {
  // Layout: x,y,u,v, road rgba, edge rgba = 12 float.
  buffer.push(
    x,
    y,
    u,
    v,
    roadColor[0],
    roadColor[1],
    roadColor[2],
    roadColor[3],
    edgeColor[0],
    edgeColor[1],
    edgeColor[2],
    edgeColor[3],
  );
}

function _pushRoadQuad(
  buffer,
  leftA,
  rightA,
  leftB,
  rightB,
  v0,
  v1,
  roadColor,
  edgeColor,
) {
  _pushRoadVertex(buffer, leftA.x, leftA.y, 0.0, v0, roadColor, edgeColor);
  _pushRoadVertex(buffer, rightA.x, rightA.y, 1.0, v0, roadColor, edgeColor);
  _pushRoadVertex(buffer, leftB.x, leftB.y, 0.0, v1, roadColor, edgeColor);

  _pushRoadVertex(buffer, leftB.x, leftB.y, 0.0, v1, roadColor, edgeColor);
  _pushRoadVertex(buffer, rightA.x, rightA.y, 1.0, v0, roadColor, edgeColor);
  _pushRoadVertex(buffer, rightB.x, rightB.y, 1.0, v1, roadColor, edgeColor);
}

function _resolveEdgeWidth(edge, roadStyle) {
  if (Number.isFinite(edge?.width) && edge.width > 0) return edge.width;

  switch (edge?.category) {
    case "main":
      return roadStyle?.mainWidth ?? 78;
    case "secondary":
      return roadStyle?.secondaryWidth ?? 60;
    case "branch":
      return roadStyle?.branchWidth ?? 46;
    default:
      return roadStyle?.defaultWidth ?? DEFAULT_ROAD_WIDTH;
  }
}

function _appendBezierRoadEdge(out, a, b, edge, segments, roadStyle) {
  const roadWidth = _resolveEdgeWidth(edge, roadStyle);
  const colors = _terrainColors(edge, roadStyle);

  const controls =
    edge?.curve?.p1 && edge?.curve?.p2
      ? {
          P0: a,
          P1: edge.curve.p1,
          P2: edge.curve.p2,
          P3: b,
        }
      : _makeCurvedControls(a, b, edge?.id || `${a.id}_${b.id}`);

  const half = roadWidth * 0.5;

  let prevLeft = null;
  let prevRight = null;
  let prevPoint = null;
  let distanceAccum = 0;

  for (let i = 0; i <= segments; i++) {
    const rawT = i / segments;
    const t =
      -ROAD_ENDPOINT_EXTENSION + rawT * (1.0 + ROAD_ENDPOINT_EXTENSION * 2.0);
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

    const nx = -tangent.y;
    const ny = tangent.x;

    const left = { x: p.x + nx * half, y: p.y + ny * half };
    const right = { x: p.x - nx * half, y: p.y - ny * half };

    if (prevPoint) {
      const stepLen = _distance2D(prevPoint, p);
      const v0 = distanceAccum / Math.max(roadWidth, 1);
      distanceAccum += stepLen;
      const v1 = distanceAccum / Math.max(roadWidth, 1);

      _pushRoadQuad(
        out,
        prevLeft,
        prevRight,
        left,
        right,
        v0,
        v1,
        colors.road,
        colors.edge,
      );
    }

    prevPoint = p;
    prevLeft = left;
    prevRight = right;
  }
}

function _buildNodeJunctionCircles(out, nodeMap, edges, roadStyle) {
  const nodeMaxWidth = new Map();
  const nodeTerrain = new Map();

  for (const edge of edges || []) {
    if (!edge) continue;

    const width = _resolveEdgeWidth(edge, roadStyle);
    const terrain = edge.terrain || "dirt";

    for (const nodeId of [edge.from, edge.to]) {
      if (!nodeMap.has(nodeId)) continue;

      const currentWidth = nodeMaxWidth.get(nodeId) || 0;
      if (width > currentWidth) {
        nodeMaxWidth.set(nodeId, width);
        nodeTerrain.set(nodeId, terrain);
      }
    }
  }

  for (const [nodeId, maxWidth] of nodeMaxWidth) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    const terrain = nodeTerrain.get(nodeId) || "dirt";
    const colors = _terrainColors({ terrain }, roadStyle);
    const radius = maxWidth * (roadStyle?.junctionRadiusMultiplier ?? 0.58);

    for (let i = 0; i < JUNCTION_CIRCLE_SEGMENTS; i++) {
      const a0 = (i / JUNCTION_CIRCLE_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / JUNCTION_CIRCLE_SEGMENTS) * Math.PI * 2;

      _pushRoadVertex(out, node.x, node.y, 0.5, 0.5, colors.road, colors.road);
      _pushRoadVertex(
        out,
        node.x + Math.cos(a0) * radius,
        node.y + Math.sin(a0) * radius,
        0.5,
        0.5,
        colors.road,
        colors.road,
      );
      _pushRoadVertex(
        out,
        node.x + Math.cos(a1) * radius,
        node.y + Math.sin(a1) * radius,
        0.5,
        0.5,
        colors.road,
        colors.road,
      );
    }
  }
}

function _normalizeRoadInput(roadData) {
  if (Array.isArray(roadData)) {
    return {
      rute_jalan: roadData,
      roadGraph: null,
      roadStyle: null,
    };
  }

  if (!roadData || typeof roadData !== "object") {
    return {
      rute_jalan: [],
      roadGraph: null,
      roadStyle: null,
    };
  }

  return {
    rute_jalan:
      roadData.rute_jalan || roadData.roads || roadData.waypoints || [],
    roadGraph: roadData.roadGraph || null,
    roadStyle: roadData.roadStyle || null,
  };
}

function _generateRoadNetworkTriangles(
  roadData,
  segments = DEFAULT_ROAD_SEGMENTS,
) {
  const normalized = _normalizeRoadInput(roadData);
  const vertices = [];
  const roadStyle = normalized.roadStyle || {};

  if (
    normalized.roadGraph &&
    Array.isArray(normalized.roadGraph.nodes) &&
    Array.isArray(normalized.roadGraph.edges)
  ) {
    const nodeMap = new Map();

    for (const node of normalized.roadGraph.nodes) {
      if (!node || !node.id) continue;
      nodeMap.set(node.id, {
        id: node.id,
        x: Number(node.x) || 0,
        y: Number(node.y) || 0,
      });
    }

    for (let i = 0; i < normalized.roadGraph.edges.length; i++) {
      const edge = normalized.roadGraph.edges[i];
      const a = nodeMap.get(edge.from);
      const b = nodeMap.get(edge.to);

      if (!a || !b) {
        console.warn(
          `[setupRoadGeometry] Edge diabaikan karena node tidak valid: ${edge.from} → ${edge.to}`,
        );
        continue;
      }

      _appendBezierRoadEdge(
        vertices,
        a,
        b,
        { ...edge, id: edge.id || `${edge.from}_${edge.to}_${i}` },
        segments,
        roadStyle,
      );
    }
    // Ujung edge sedikit diperpanjang agar sambungan jalan tertutup tanpa lingkaran tambahan di persimpangan.

    return {
      vertices: new Float32Array(vertices),
      vertexCount: vertices.length / 12,
      stride: 12 * Float32Array.BYTES_PER_ELEMENT,
      drawMode: "TRIANGLES",
    };
  }

  const route = normalized.rute_jalan;
  for (let i = 0; i < route.length - 1; i++) {
    const a = {
      id: route[i].id || `rj_${i}`,
      x: Number(route[i].x) || 0,
      y: Number(route[i].y) || 0,
    };
    const b = {
      id: route[i + 1].id || `rj_${i + 1}`,
      x: Number(route[i + 1].x) || 0,
      y: Number(route[i + 1].y) || 0,
    };

    _appendBezierRoadEdge(
      vertices,
      a,
      b,
      { id: `${a.id}_${b.id}_${i}`, terrain: "dirt" },
      segments,
      roadStyle,
    );
  }

  return {
    vertices: new Float32Array(vertices),
    vertexCount: vertices.length / 12,
    stride: 12 * Float32Array.BYTES_PER_ELEMENT,
    drawMode: "TRIANGLES",
  };
}

export function generateBezierRoad(
  waypoints,
  segments = DEFAULT_ROAD_SEGMENTS,
  roadWidth = DEFAULT_ROAD_WIDTH,
) {
  const networkData = {
    roadStyle: {
      defaultWidth: roadWidth,
    },
    roadGraph: {
      nodes: waypoints || [],
      edges: [],
    },
  };

  if (Array.isArray(waypoints)) {
    for (let i = 0; i < waypoints.length - 1; i++) {
      networkData.roadGraph.edges.push({
        from: waypoints[i].id ?? `route_${i}`,
        to: waypoints[i + 1].id ?? `route_${i + 1}`,
        weight: 1.0,
        terrain: "dirt",
        width: roadWidth,
      });
    }
  }

  return _generateRoadNetworkTriangles(networkData, segments);
}

export function setupRoadGeometry(gl, locations, roadData) {
  void locations;

  const road = _generateRoadNetworkTriangles(roadData, DEFAULT_ROAD_SEGMENTS);

  if (!road || road.vertexCount === 0) {
    console.warn("[setupRoadGeometry] Data jalan kosong atau tidak valid.");
    return null;
  }

  const rendererInstance = new RoadRenderer(gl);
  gl.bindBuffer(gl.ARRAY_BUFFER, rendererInstance.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, road.vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  console.log(
    `[setupRoadGeometry] Geometri jalan siap (${road.vertexCount} vertex).`,
  );

  return {
    rendererInstance,
    vertexCount: road.vertexCount,
    stride: road.stride,
    drawMode: gl.TRIANGLES,
  };
}

export function drawRoads(gl, locations, rendererState, cameraState) {
  void locations;

  const road = rendererState?.roads;
  const renderer = road?.rendererInstance;
  const matrix = _getViewProjectionMatrix(cameraState);

  if (!road || !renderer || !renderer.vbo) return;

  if (!matrix || matrix.length !== 16) {
    console.warn("[drawRoads] cameraState.viewProjectionMatrix tidak valid.");
    return;
  }

  const FLOAT_SIZE = Float32Array.BYTES_PER_ELEMENT;

  gl.useProgram(renderer.program);

  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.vbo);

  gl.enableVertexAttribArray(renderer.aPosition);
  gl.vertexAttribPointer(
    renderer.aPosition,
    2,
    gl.FLOAT,
    false,
    road.stride,
    0,
  );

  gl.enableVertexAttribArray(renderer.aUv);
  gl.vertexAttribPointer(
    renderer.aUv,
    2,
    gl.FLOAT,
    false,
    road.stride,
    2 * FLOAT_SIZE,
  );

  gl.enableVertexAttribArray(renderer.aRoadColor);
  gl.vertexAttribPointer(
    renderer.aRoadColor,
    4,
    gl.FLOAT,
    false,
    road.stride,
    4 * FLOAT_SIZE,
  );

  gl.enableVertexAttribArray(renderer.aEdgeColor);
  gl.vertexAttribPointer(
    renderer.aEdgeColor,
    4,
    gl.FLOAT,
    false,
    road.stride,
    8 * FLOAT_SIZE,
  );

  gl.uniformMatrix4fv(renderer.uCamera, false, matrix);
  gl.uniform1f(renderer.uTime, rendererState?.simulationTime || 0.0);
  gl.uniform1f(renderer.uDayNight, rendererState?.dayNightProgress || 0.0);

  gl.drawArrays(gl.TRIANGLES, 0, road.vertexCount);

  gl.disableVertexAttribArray(renderer.aPosition);
  gl.disableVertexAttribArray(renderer.aUv);
  gl.disableVertexAttribArray(renderer.aRoadColor);
  gl.disableVertexAttribArray(renderer.aEdgeColor);

  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

// ============================================================
// BAGIAN 5 — TEXTURE SETUP
// ============================================================
// Kontribusi Dea: setup texture spritesheet sebagai sumber gambar seluruh sprite medieval.

export function setupTexture(gl, locations, image) {
  void locations;

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  texture._imageWidth = image.width;
  texture._imageHeight = image.height;

  gl.bindTexture(gl.TEXTURE_2D, null);

  console.log(
    `[setupTexture] Texture spritesheet siap (${image.width}x${image.height}).`,
  );
  return texture;
}

// ============================================================
// BAGIAN 6 — SPRITE SHADER DAN SPRITE RENDERER
// ============================================================
// Kontribusi Dea: sprite shader, UV mapping, atlas lookup, batching sprite, z-sorting, occlusion, dan sprite kereta.

const SPRITE_VERT_SRC = `
  attribute vec2 a_position;
  attribute vec2 a_uv;
  attribute vec4 a_color;
  attribute float a_effect;

  uniform mat4 uViewProjectionMatrix;

  varying vec2 v_uv;
  varying vec4 v_color;
  varying float v_effect;

  void main() {
    gl_Position = uViewProjectionMatrix * vec4(a_position, 0.0, 1.0);
    v_uv = a_uv;
    v_color = a_color;
    v_effect = a_effect;
  }
`;

const SPRITE_FRAG_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  uniform float u_time;
  uniform float u_dayNight;

  varying vec2 v_uv;
  varying vec4 v_color;
  varying float v_effect;

  void main() {
    vec4 texColor = texture2D(u_texture, v_uv);
    if (texColor.a < 0.02) discard;

    vec3 rgb = texColor.rgb;

    // Efek parit air mengalir berbasis u_time.
    if (v_effect > 0.5) {
      float waveA = sin(v_uv.x * 92.0 + v_uv.y * 38.0 + u_time * 6.0);
      float waveB = sin(v_uv.x * 27.0 - v_uv.y * 73.0 - u_time * 3.8);
      float wave = waveA * 0.026 + waveB * 0.018;
      rgb += vec3(0.0, 0.065, 0.085) + wave * 1.8;
    }

    float night = clamp(u_dayNight, 0.0, 1.0);
    float dusk = smoothstep(0.25, 0.65, night) * (1.0 - smoothstep(0.70, 1.0, night));

    vec3 duskTint = vec3(1.08, 0.86, 0.62);
    vec3 nightTint = vec3(0.45, 0.55, 0.78);

    rgb = mix(rgb, rgb * duskTint, dusk * 0.18);
    rgb = mix(rgb, rgb * nightTint, smoothstep(0.45, 1.0, night) * 0.42);

    gl_FragColor = vec4(rgb * v_color.rgb, texColor.a * v_color.a);
  }
`;

export class SpriteRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = _createProgram(
      gl,
      SPRITE_VERT_SRC,
      SPRITE_FRAG_SRC,
      "SpriteRenderer",
    );

    this.aPosition = gl.getAttribLocation(this.program, "a_position");
    this.aUv = gl.getAttribLocation(this.program, "a_uv");
    this.aColor = gl.getAttribLocation(this.program, "a_color");
    this.aEffect = gl.getAttribLocation(this.program, "a_effect");

    this.uCamera = gl.getUniformLocation(this.program, "uViewProjectionMatrix");
    this.uTexture = gl.getUniformLocation(this.program, "u_texture");
    this.uTime = gl.getUniformLocation(this.program, "u_time");
    this.uDayNight = gl.getUniformLocation(this.program, "u_dayNight");

    this.vbo = gl.createBuffer();

    // 1 sprite = 6 vertex. Per vertex = 9 float: x,y,u,v,r,g,b,a,effect.
    this._maxSprites = 4096;
    this._vertexData = new Float32Array(this._maxSprites * 6 * 9);
  }

  _ensureCapacity(count) {
    if (count <= this._maxSprites) return;

    this._maxSprites = Math.max(count * 2, this._maxSprites * 2);
    this._vertexData = new Float32Array(this._maxSprites * 6 * 9);
    console.warn(
      `[SpriteRenderer] Buffer sprite diperluas ke ${this._maxSprites} sprite.`,
    );
  }
}

function _normalizeSpriteObjects(objects) {
  if (Array.isArray(objects)) return objects;

  if (objects && Array.isArray(objects.objek_statis))
    return objects.objek_statis;
  if (objects && Array.isArray(objects.buildings)) return objects.buildings;
  if (objects && Array.isArray(objects.objects)) return objects.objects;
  if (objects && Array.isArray(objects.sprites)) return objects.sprites;

  return [];
}

function _getSpriteType(obj) {
  return (
    obj?.type ||
    obj?.tipe ||
    obj?.sprite ||
    obj?.spriteId ||
    obj?.atlasKey ||
    obj?.name
  );
}

function _resolveAtlas(rendererState, simulationState) {
  return (
    simulationState?.atlasData ||
    simulationState?._rawMapData?.atlasData ||
    rendererState?.atlasData ||
    rendererState?.spriteAtlas ||
    {}
  );
}

function _resolveAtlasSize(rendererState, simulationState, texture) {
  return (
    simulationState?.atlasSize ||
    simulationState?.spritesheetSize ||
    simulationState?._rawMapData?.atlasSize ||
    rendererState?.atlasSize ||
    texture?._imageWidth ||
    DEFAULT_ATLAS_SIZE
  );
}

function _pushSpriteVertex(buf, ptr, x, y, u, v, color, effect) {
  buf[ptr++] = x;
  buf[ptr++] = y;
  buf[ptr++] = u;
  buf[ptr++] = v;
  buf[ptr++] = color[0];
  buf[ptr++] = color[1];
  buf[ptr++] = color[2];
  buf[ptr++] = color[3];
  buf[ptr++] = effect || 0.0;
  return ptr;
}

function _pushTexturedQuad(buf, ptr, rect, uv, color, effect = 0.0) {
  const x0 = rect.x0;
  const y0 = rect.y0;
  const x1 = rect.x1;
  const y1 = rect.y1;

  const u0 = rect.flipX ? uv.u1 : uv.u0;
  const u1 = rect.flipX ? uv.u0 : uv.u1;
  const v0 = uv.v0;
  const v1 = uv.v1;

  ptr = _pushSpriteVertex(buf, ptr, x0, y0, u0, v0, color, effect);
  ptr = _pushSpriteVertex(buf, ptr, x0, y1, u0, v1, color, effect);
  ptr = _pushSpriteVertex(buf, ptr, x1, y0, u1, v0, color, effect);

  ptr = _pushSpriteVertex(buf, ptr, x1, y0, u1, v0, color, effect);
  ptr = _pushSpriteVertex(buf, ptr, x0, y1, u0, v1, color, effect);
  ptr = _pushSpriteVertex(buf, ptr, x1, y1, u1, v1, color, effect);

  return ptr;
}

function _makeAtlasUv(meta, atlasSize) {
  const inv = 1 / atlasSize;
  const half = 0.5 * inv;

  return {
    u0: meta.x * inv + half,
    v0: meta.y * inv + half,
    u1: (meta.x + meta.w) * inv - half,
    v1: (meta.y + meta.h) * inv - half,
  };
}

function _makeStaticSpriteDrawItem(obj, atlas) {
  const type = _getSpriteType(obj);
  const meta = atlas[type];

  if (!type || !meta) {
    if (!_warnedMissingAtlasKeys.has(type)) {
      console.warn(
        `[drawSprites] Sprite tidak ditemukan di atlasData: "${type}"`,
      );
      _warnedMissingAtlasKeys.add(type);
    }
    return null;
  }

  const x = Number(obj.x) || 0;
  const y = Number(obj.y) || 0;
  const scale = obj.scale ?? 1.0;

  const w = (obj.w || obj.width || meta.renderW || meta.w) * scale;
  const h = (obj.h || obj.height || meta.renderH || meta.h) * scale;

  // x/y pada JSON diperlakukan sebagai titik pijakan sprite, bukan pojok kiri atas.
  const anchorX = obj.anchorX ?? meta.anchorX ?? 0.5;
  const anchorY = obj.anchorY ?? meta.anchorY ?? 1.0;

  const x0 = x - w * anchorX;
  const y0 = y - h * anchorY;

  const layer = obj.layer ?? meta.layer ?? 2;
  const effect =
    obj.effect === "water" || meta.effect === "water" || type === "parit_air"
      ? 1.0
      : 0.0;

  return {
    type,
    meta,
    x0,
    y0,
    x1: x0 + w,
    y1: y0 + h,
    flipX: Boolean(obj.flipX),
    color: [1, 1, 1, obj.alpha ?? 1],
    sortY: y + (obj.sortOffsetY || meta.sortOffsetY || 14),
    layer,
    effect,
  };
}

function _makeCarriageItems(simulationState, atlas) {
  const c = simulationState?.carriage;
  if (!c) return [];

  const requestedType = c.spriteType || c.atlasKey || c.type || "kereta_kuda";
  const meta = atlas[requestedType] || atlas.kereta_kuda;

  if (!meta) {
    if (!_warnedMissingAtlasKeys.has(requestedType)) {
      console.warn(
        `[drawSprites] Sprite kereta tidak ditemukan di atlasData: "${requestedType}"`,
      );
      _warnedMissingAtlasKeys.add(requestedType);
    }
    return [];
  }

  const items = [];

  const baseW = meta.renderW || meta.w;
  const baseH = meta.renderH || meta.h;

  const rotationBasedFlip = Math.cos(c.rotation || 0) < 0;
  const flipX = c.flipX ?? rotationBasedFlip;

  // baseScale mengatur ukuran kereta, sedangkan scaleX/scaleY dipakai untuk squash-stretch.
  const baseScale =
    c.baseScale ??
    c.renderScale ??
    c.scale ??
    meta.defaultScale ??
    DEFAULT_CARRIAGE_BASE_SCALE;
  const poseScaleX = c.scaleX ?? 1.0;
  const poseScaleY = c.scaleY ?? 1.0;

  const w = baseW * baseScale * Math.abs(poseScaleX);
  const h = baseH * baseScale * Math.abs(poseScaleY);

  const cx = Number(c.x) || 0;
  const cy = (Number(c.y) || 0) + (Number(c.bobOffsetY) || 0);

  const sh = c.shadow || {};
  const shadowScaleX = sh.scaleX ?? 1.35;
  const shadowScaleY = sh.scaleY ?? 0.42;

  const shadowW = baseW * baseScale * shadowScaleX;
  const shadowH = baseH * baseScale * shadowScaleY;
  const shadowCx = Number(sh.x) || cx + 6;
  const shadowCy = Number(sh.y) || cy + 7;
  const skewX = Number(sh.skewX) || 0;

  items.push({
    type: requestedType,
    meta,
    x0: shadowCx - shadowW * 0.5 + skewX * shadowH,
    y0: shadowCy - shadowH * 0.5,
    x1: shadowCx + shadowW * 0.5 + skewX * shadowH,
    y1: shadowCy + shadowH * 0.5,
    flipX,
    color: [0, 0, 0, sh.alpha ?? 0.35],
    sortY: shadowCy - 1,
    layer: c.layer ?? meta.layer ?? 2,
    effect: 0.0,
  });

  const anchorX = c.anchorX ?? meta.anchorX ?? 0.5;
  const anchorY = c.anchorY ?? meta.anchorY ?? 0.95;
  const x0 = cx - w * anchorX;
  const y0 = cy - h * anchorY;

  items.push({
    type: requestedType,
    meta,
    x0,
    y0,
    x1: x0 + w,
    y1: y0 + h,
    flipX,
    color: [1, 1, 1, c.alpha ?? 1],
    sortY: c.y + (c.sortOffsetY ?? -12),
    layer: c.layer ?? meta.layer ?? 2,
    effect: 0.0,
  });

  return items;
}

export function setupSpriteGeometry(gl, locations, buildingData) {
  void locations;

  const rendererInstance = new SpriteRenderer(gl);

  return {
    rendererInstance,
    objects: _normalizeSpriteObjects(buildingData),
  };
}

export function drawSprites(
  gl,
  locations,
  rendererState,
  simulationState,
  cameraState,
) {
  void locations;

  const spriteState = rendererState?.sprites;
  const renderer = spriteState?.rendererInstance;
  const texture = rendererState?.texture;
  const matrix = _getViewProjectionMatrix(cameraState);
  const atlas = _resolveAtlas(rendererState, simulationState);
  const atlasSize = _resolveAtlasSize(rendererState, simulationState, texture);

  if (!renderer || !spriteState) return;

  if (!texture) {
    console.warn("[drawSprites] rendererState.texture belum tersedia.");
    return;
  }

  if (!matrix || matrix.length !== 16) {
    console.warn("[drawSprites] cameraState.viewProjectionMatrix tidak valid.");
    return;
  }

  const staticObjects = _normalizeSpriteObjects(spriteState.objects);
  const drawItems = [];

  for (const obj of staticObjects) {
    const item = _makeStaticSpriteDrawItem(obj, atlas);
    if (item) drawItems.push(item);
  }

  for (const item of _makeCarriageItems(simulationState, atlas)) {
    drawItems.push(item);
  }

  if (drawItems.length === 0) return;

  // Layer dan sortY menentukan urutan gambar agar occlusion isometric terlihat natural.
  drawItems.sort((a, b) => a.layer - b.layer || a.sortY - b.sortY);

  renderer._ensureCapacity(drawItems.length);

  const buf = renderer._vertexData;
  let ptr = 0;

  for (const item of drawItems) {
    const uv = _makeAtlasUv(item.meta, atlasSize);

    ptr = _pushTexturedQuad(
      buf,
      ptr,
      {
        x0: item.x0,
        y0: item.y0,
        x1: item.x1,
        y1: item.y1,
        flipX: item.flipX,
      },
      uv,
      item.color,
      item.effect || 0.0,
    );
  }

  const vertexCount = drawItems.length * 6;
  const FLOAT_SIZE = Float32Array.BYTES_PER_ELEMENT;
  const FLOATS_PER_VERTEX = 9;
  const STRIDE = FLOATS_PER_VERTEX * FLOAT_SIZE;

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  gl.useProgram(renderer.program);
  gl.uniformMatrix4fv(renderer.uCamera, false, matrix);
  gl.uniform1f(renderer.uTime, simulationState?.time || 0.0);
  gl.uniform1f(renderer.uDayNight, simulationState?.dayNight?.progress || 0.0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(renderer.uTexture, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, ptr), gl.DYNAMIC_DRAW);

  gl.enableVertexAttribArray(renderer.aPosition);
  gl.vertexAttribPointer(renderer.aPosition, 2, gl.FLOAT, false, STRIDE, 0);

  gl.enableVertexAttribArray(renderer.aUv);
  gl.vertexAttribPointer(
    renderer.aUv,
    2,
    gl.FLOAT,
    false,
    STRIDE,
    2 * FLOAT_SIZE,
  );

  gl.enableVertexAttribArray(renderer.aColor);
  gl.vertexAttribPointer(
    renderer.aColor,
    4,
    gl.FLOAT,
    false,
    STRIDE,
    4 * FLOAT_SIZE,
  );

  gl.enableVertexAttribArray(renderer.aEffect);
  gl.vertexAttribPointer(
    renderer.aEffect,
    1,
    gl.FLOAT,
    false,
    STRIDE,
    8 * FLOAT_SIZE,
  );

  gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

  gl.disableVertexAttribArray(renderer.aPosition);
  gl.disableVertexAttribArray(renderer.aUv);
  gl.disableVertexAttribArray(renderer.aColor);
  gl.disableVertexAttribArray(renderer.aEffect);

  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

// ============================================================
// BAGIAN 9 — LIGHTING OVERLAY SIANG-MALAM
// ============================================================
// Kontribusi Dea: overlay pencahayaan siang-malam yang digambar setelah road dan sprite.

const LIGHTING_VERT_SRC = `
  attribute vec2 a_position;
  varying vec2 v_position;
  void main() {
    v_position = a_position;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const LIGHTING_FRAG_SRC = `
  precision mediump float;
  varying vec2 v_position;
  uniform float u_dayNight;
  uniform vec2 u_resolution;

  void main() {
    float t = clamp(u_dayNight, 0.0, 1.0);

    float dusk = smoothstep(0.25, 0.58, t) * (1.0 - smoothstep(0.66, 0.82, t));
    float night = smoothstep(0.46, 1.0, t);

    float dist = length(v_position * vec2(0.82, 1.0));
    float vignette = smoothstep(0.40, 1.20, dist);

    vec3 duskColor = vec3(0.90, 0.48, 0.16);
    vec3 nightColor = vec3(0.03, 0.06, 0.16);

    vec3 color = duskColor;
    float alpha = dusk * 0.10;

    color = mix(color, nightColor, night);
    alpha += night * (0.20 + vignette * 0.20);

    gl_FragColor = vec4(color, alpha);
  }
`;

class LightingOverlayRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = _createProgram(
      gl,
      LIGHTING_VERT_SRC,
      LIGHTING_FRAG_SRC,
      "LightingOverlayRenderer",
    );
    this.aPosition = gl.getAttribLocation(this.program, "a_position");
    this.uDayNight = gl.getUniformLocation(this.program, "u_dayNight");
    this.uResolution = gl.getUniformLocation(this.program, "u_resolution");
    this.vbo = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
}

export function drawLightingOverlay(gl, locations, rendererState) {
  void locations;
  if (!gl || !rendererState) return;

  if (!rendererState.lightingOverlay) {
    rendererState.lightingOverlay = new LightingOverlayRenderer(gl);
  }

  const renderer = rendererState.lightingOverlay;
  const progress = Math.max(
    0,
    Math.min(1, Number(rendererState.dayNightProgress) || 0),
  );

  gl.useProgram(renderer.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.vbo);

  gl.enableVertexAttribArray(renderer.aPosition);
  gl.vertexAttribPointer(renderer.aPosition, 2, gl.FLOAT, false, 0, 0);

  if (renderer.uDayNight) gl.uniform1f(renderer.uDayNight, progress);
  if (renderer.uResolution)
    gl.uniform2f(renderer.uResolution, gl.canvas.width, gl.canvas.height);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  gl.enable(gl.DEPTH_TEST);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}
