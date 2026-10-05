"use strict";

/* One worker owns one solver instance. No SharedArrayBuffer or worker pool is
   used: yielding between short batches leaves pause/reset/destroy messages a
   chance to run and keeps each visitor's evolving state private. */
importScripts("./solver/grmhd-runtime.js?v=261e8eb6d6e1");

const SLOT_COUNT = 128;
const SNAPSHOT_INTERVAL = 20;
const BATCH_STEPS = 8;
const MAX_PENDING_SNAPSHOTS = 8;
const DIAGNOSTIC_NAMES = ["time", "finite", "minDensity", "minInternal", "massResidual", "internalResidual", "maxCoordinateDivB", "velocityNormDrift", "velocityDrift", "acceptedSteps", "positive", "maxVelocityNormError"];
let session = 0;
let generation = 0;
let bootToken = 0;
let runtime = null;
let checkpoint = null;
let targetTime = 0;
let nextSnapshotTime = 0;
let ringSlot = 0;
let pendingSnapshots = 0;
let active = false;
let paused = true;
let pumping = false;
let destroyed = false;

function reply(type, payload = {}, transfer = []) {
  self.postMessage({type, session, generation, ...payload}, transfer);
}

function sleepForMessageTurn() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function readGzip(url) {
  const response = await fetch(url, {cache: "force-cache"});
  if (!response.ok) throw new Error(`检查点请求失败（${response.status}）`);
  if (!self.DecompressionStream) throw new Error("当前浏览器缺少 DecompressionStream");
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function digestHex(buffer) {
  if (!self.crypto?.subtle) throw new Error("当前上下文无法校验检查点哈希");
  return Array.from(new Uint8Array(await self.crypto.subtle.digest("SHA-256", buffer)), value => value.toString(16).padStart(2, "0")).join("");
}

async function readCheckpoint(url, expected) {
  // The browser must fail closed when provenance metadata is absent; accepting
  // an arbitrary parseable restart would bypass the published integrity gate.
  if (!expected || typeof expected !== "object" || typeof expected.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(expected.sha256)) {
    throw new Error("检查点缺少有效 SHA-256 元数据");
  }
  const raw = await readGzip(url);
  if (await digestHex(raw) !== expected.sha256.toLowerCase()) throw new Error("检查点哈希不匹配");
  if (raw.byteLength < 40) throw new Error("检查点内容不完整");
  const view = new DataView(raw);
  const magic = new TextDecoder().decode(new Uint8Array(raw, 0, 8));
  const version = view.getUint32(8, true);
  const cells = view.getUint32(12, true);
  const components = view.getUint32(16, true);
  const boundaryRows = view.getUint32(20, true);
  const time = view.getFloat64(24, true);
  const boundaryWidth = view.getUint32(32, true);
  const expectedCells = Number(expected.cells),expectedComponents = Number(expected.components),expectedStateCount = Number(expected.stateCount),expectedBoundaryRows = Number(expected.boundaryRows),expectedBoundaryWidth = Number(expected.boundaryWidth),expectedTime = Number(expected.time);
  if (![expectedCells,expectedComponents,expectedStateCount,expectedBoundaryRows,expectedBoundaryWidth,expectedTime].every(Number.isFinite) || ![expectedCells,expectedComponents,expectedStateCount,expectedBoundaryRows,expectedBoundaryWidth].every(Number.isInteger) || expectedCells<1 || expectedComponents<1 || expectedStateCount!==expectedCells*expectedComponents || expectedBoundaryRows<1 || expectedBoundaryWidth<1 || expectedBoundaryRows*expectedBoundaryWidth>expectedCells) {
    throw new Error("检查点元数据不完整");
  }
  // Shape, time and row layout come from the loaded dataset metadata rather
  // than a single baked-in 64×64, t=800 checkpoint.
  if (magic !== "GRMHDCP1" || version !== 1 || cells !== expectedCells || components !== expectedComponents || boundaryRows !== expectedBoundaryRows || boundaryWidth !== expectedBoundaryWidth || Math.abs(time-expectedTime)>1e-9) {
    throw new Error("检查点格式或边界状态无效");
  }
  const stateCount = cells * components;
  const stateOffset = 40;
  const boundaryOffset = stateOffset + stateCount * Float64Array.BYTES_PER_ELEMENT;
  const boundaryCount = boundaryRows * boundaryWidth * components;
  if (boundaryOffset + boundaryCount * Float64Array.BYTES_PER_ELEMENT !== raw.byteLength) throw new Error("检查点内容不完整");
  const state = new Float64Array(stateCount);
  state.set(new Float64Array(raw, stateOffset, stateCount));
  const boundary = new Float64Array(boundaryCount);
  boundary.set(new Float64Array(raw, boundaryOffset, boundaryCount));
  if (boundaryRows === 2) for (let index = 0; index < boundaryCount / 2; index++) {
    if (boundary[index] !== state[index] || boundary[index + boundaryCount / 2] !== state[state.length - boundaryCount / 2 + index]) {
      throw new Error("检查点边界副本与完整状态不一致");
    }
  }
  return {state, time, cells, components, boundaryRows, boundaryWidth};
}

function views() {
  const exports = runtime.exports;
  return {
    input: new Float64Array(exports.memory.buffer, exports.grmhd_input_ptr(), exports.grmhd_snapshot_length()),
    snapshot: new Float32Array(exports.memory.buffer, exports.grmhd_snapshot_ptr(), exports.grmhd_snapshot_length()),
    diagnostics: new Float64Array(exports.memory.buffer, exports.grmhd_diagnostics_ptr(), exports.grmhd_diagnostics_length())
  };
}

function currentTime() {
  return runtime.exports.grmhd_time();
}

function emitSnapshot() {
  runtime.exports.grmhd_snapshot();
  const data = views().snapshot.slice();
  const diagnostics = Array.from(views().diagnostics);
  const time = currentTime();
  const slot = ringSlot++ % SLOT_COUNT;
  pendingSnapshots++;
  reply("snapshot", {slot, time, diagnostics, buffer: data.buffer}, [data.buffer]);
}

function emitProgress(state) {
  reply("progress", {
    state,
    simulationTime: currentTime(),
    targetTime,
    stepRate: runtime?.stepRate || 0,
    pendingSnapshots,
    snapshotInterval: SNAPSHOT_INTERVAL,
    cacheSlots: SLOT_COUNT
  });
}

async function pump() {
  if (pumping || !runtime || destroyed) return;
  pumping = true;
  try {
    while (active && !paused && targetTime > currentTime() + 1e-9 && pendingSnapshots < MAX_PENDING_SNAPSHOTS) {
      const before = currentTime();
      const started = performance.now();
      const requested = Math.min(targetTime, nextSnapshotTime);
      const result = runtime.exports.grmhd_advance(requested, BATCH_STEPS);
      const elapsed = Math.max(1e-6, performance.now() - started);
      const after = currentTime();
      runtime.stepRate = Math.max(0, (after - before) / (elapsed / 1000));
      if (result < 0 || !Number.isFinite(after)) throw new Error("求解器返回非有限状态");
      // Render targets move every frame. Only fixed simulation-time boundaries
      // may consume a history slot; a partial target is progress, not a frame.
      if (after + 1e-9 >= nextSnapshotTime) {
        emitSnapshot();
        nextSnapshotTime += SNAPSHOT_INTERVAL;
      }
      emitProgress("computing");
      await sleepForMessageTurn();
    }
    if (pendingSnapshots >= MAX_PENDING_SNAPSHOTS) emitProgress("backpressure");
    else if (paused || !active) emitProgress("paused");
    else if (targetTime <= currentTime() + 1e-9) emitProgress("ready");
  } catch (error) {
    active = false;
    paused = true;
    reply("error", {kind: "runtime", message: error instanceof Error ? error.message : String(error)});
  } finally {
    pumping = false;
  }
}

async function boot(message, token) {
  try {
    const [wasm, loadedCheckpoint] = await Promise.all([
      InterstellarGrmhdWasmLoader.instantiate(message.wasmUrl),
      readCheckpoint(message.checkpointUrl, message.checkpointSpec)
    ]);
    if (token !== bootToken || destroyed) return;
    runtime = wasm.instance;
    checkpoint = loadedCheckpoint;
    const solverViews = views();
    solverViews.input.set(checkpoint.state);
    runtime.exports.grmhd_init(checkpoint.time);
    targetTime = checkpoint.time;
    nextSnapshotTime = checkpoint.time + SNAPSHOT_INTERVAL;
    ringSlot = 0;
    pendingSnapshots = 0;
    paused = true;
    reply("ready", {time: checkpoint.time, stateCount: checkpoint.state.length, snapshotInterval: SNAPSHOT_INTERVAL, cacheSlots: SLOT_COUNT, diagnosticNames: DIAGNOSTIC_NAMES});
    if (active) pump();
  } catch (error) {
    if (token !== bootToken || destroyed) return;
    runtime = null;
    reply("error", {kind: "load", message: error instanceof Error ? error.message : String(error)});
  }
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === "init") {
    session = message.session;
    generation = 0;
    bootToken++;
    destroyed = false;
    active = false;
    paused = true;
    targetTime = 0;
    boot(message, bootToken);
    return;
  }
  if (message.session !== session || destroyed) return;
  if (message.type === "advance") {
    targetTime = Math.max(targetTime, Number(message.targetTime) || targetTime);
    active = true;
    paused = false;
    if (runtime) pump();
  } else if (message.type === "resume") {
    active = true;
    paused = false;
    if (runtime) { emitProgress("computing"); pump(); }
  } else if (message.type === "pause") {
    paused = true;
    if (runtime) emitProgress("paused");
  } else if (message.type === "consume") {
    pendingSnapshots = Math.max(0, pendingSnapshots - 1);
    pump();
  } else if (message.type === "reset") {
    if (!runtime || !checkpoint) return;
    generation++;
    const solverViews = views();
    solverViews.input.set(checkpoint.state);
    runtime.exports.grmhd_init(checkpoint.time);
    targetTime = checkpoint.time;
    nextSnapshotTime = checkpoint.time + SNAPSHOT_INTERVAL;
    ringSlot = 0;
    pendingSnapshots = 0;
    paused = true;
    reply("reset", {time: checkpoint.time});
    reply("ready", {time: checkpoint.time, stateCount: checkpoint.state.length, snapshotInterval: SNAPSHOT_INTERVAL, cacheSlots: SLOT_COUNT, diagnosticNames: DIAGNOSTIC_NAMES});
  } else if (message.type === "destroy") {
    destroyed = true;
    active = false;
    paused = true;
    if (runtime) runtime.exports.grmhd_destroy();
    reply("destroyed");
    self.close();
  }
};
