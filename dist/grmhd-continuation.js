"use strict";

/*
 * Main-thread coordinator for the private solver session. The renderer owns
 * GPU upload, while this object owns the 128 logical-time slots and rejects
 * late worker messages from a previous scene/session.
 */
(() => {
  const SLOT_COUNT = 128;

  function create(options = {}) {
    const entries = new Array(SLOT_COUNT);
    let worker = null;
    let session = 0;
    let generation = 0;
    let started = false;
    let status = "idle";
    let latestTime = Number(options.historyEndTime ?? 800);
    let active = false;
    let targetTime = latestTime;
    let resetPending = false;

    const report = (type, payload) => {
      if (type === "status") options.onStatus?.(payload);
      if (type === "progress") options.onProgress?.(payload);
      if (type === "ready") options.onReady?.(payload);
      if (type === "snapshot") options.onSnapshot?.(payload);
      if (type === "error") options.onError?.(payload);
    };

    function clear() {
      entries.fill(undefined);
      latestTime = Number(options.historyEndTime ?? 800);
      targetTime = latestTime;
    }

    function start() {
      if (started) return;
      started = true;
      if (typeof Worker !== "function") {
        status = "unavailable";
        report("error", {kind: "load", message: "当前浏览器不支持 Web Worker"});
        return;
      }
      session += 1;
      status = "loading";
      try {
        worker = new Worker(options.workerUrl || "./grmhd-worker.js");
      } catch (error) {
        status = "unavailable";
        report("error", {kind: "load", message: error instanceof Error ? error.message : String(error)});
        return;
      }
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.session !== session || message.generation !== generation) return;
        if (message.type === "ready") {
          if (resetPending) {
            resetPending = false;
            generation++;
            worker.postMessage({type: "reset", session});
            return;
          }
          status = "ready";
          latestTime = Math.max(latestTime, message.time);
          report("ready", message);
          if (active) {
            worker.postMessage({type: "resume", session});
            if (targetTime > latestTime) worker.postMessage({type: "advance", session, targetTime});
          }
        } else if (message.type === "progress") {
          status = message.state === "computing" || message.state === "backpressure" ? "computing" : message.state;
          latestTime = Math.max(latestTime, Number(message.simulationTime) || latestTime);
          report("progress", {...message, status, latestTime});
        } else if (message.type === "snapshot") {
          const records = new Float32Array(message.buffer);
          const entry = {slot: message.slot, time: message.time, records, diagnostics: message.diagnostics};
          entries[message.slot % SLOT_COUNT] = entry;
          latestTime = Math.max(latestTime, message.time);
          report("snapshot", entry);
          /* Acknowledging only after the renderer has received the transferable
             keeps the worker's queue bounded without SharedArrayBuffer. */
          worker.postMessage({type: "consume", session, slot: message.slot});
        } else if (message.type === "reset") {
          clear();
          report("status", {status: "ready", time: message.time});
        } else if (message.type === "destroyed") {
          status = "destroyed";
        } else if (message.type === "error") {
          status = message.kind === "load" ? "unavailable" : "failed";
          report("error", message);
        }
      };
      worker.onerror = event => {
        status = "failed";
        report("error", {kind: "runtime", message: event.message || "Worker 运行失败"});
      };
      worker.postMessage({
        type: "init",
        session,
        workerUrl: options.workerUrl,
        wasmUrl: options.wasmUrl || "./solver/grmhd-runtime.wasm",
        checkpointUrl: options.checkpointUrl || "./data/grmhd-torus.checkpoint.bin.gz",
        checkpointSpec: options.checkpointSpec
      });
    }

    function setActive(value) {
      const next = Boolean(value);
      // draw() runs every frame; avoid replaying the same pause/resume command
      // while advanceTo() independently updates a moving target time.
      if (next === active) return;
      active = next;
      if (!worker || status === "unavailable" || status === "failed") return;
      if (status === "loading") return;
      worker.postMessage({type: active ? "resume" : "pause", session});
      if (active && targetTime > latestTime) worker.postMessage({type: "advance", session, targetTime});
    }

    function advanceTo(time) {
      const value = Number(time);
      if (!Number.isFinite(value) || value <= latestTime + 1e-6) return;
      targetTime = Math.max(targetTime, value);
      if (!worker || !active || status === "unavailable" || status === "failed") return;
      if (status === "loading") return;
      worker.postMessage({type: "advance", session, targetTime});
    }

    function reset() {
      clear();
      // A reset can race with a transferable snapshot already queued by the
      // worker. Incrementing the generation makes that old message harmless.
      if (worker && status === "loading") { resetPending = true; return; }
      generation++;
      if (worker && status !== "unavailable" && status !== "failed") worker.postMessage({type: "reset", session});
    }

    function destroy() {
      if (!worker) return;
      worker.postMessage({type: "destroy", session});
      worker.terminate();
      worker = null;
      status = "destroyed";
    }

    return Object.freeze({
      start,
      setActive,
      advanceTo,
      reset,
      destroy,
      clear,
      entries: () => entries.filter(Boolean).sort((a, b) => a.time - b.time),
      latest: () => latestTime,
      get status() { return status; },
      get session() { return session; },
      slotCount: SLOT_COUNT
    });
  }

  globalThis.BlackHoleGrmhdContinuation = Object.freeze({create});
})();
