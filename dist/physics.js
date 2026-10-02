"use strict";

(() => {
  // Geometrized units: r is measured in GM/c² and a is the dimensionless prograde spin.
  function iscoRadius(spin) {
    const a = Math.max(0, Math.min(0.95, spin));
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const z2 = Math.sqrt(3 * a * a + z1 * z1);
    return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
  }

  function model(settings) {
    const spin = settings.model === "kerr" ? settings.spin : 0;
    return {
      spin,
      isco: iscoRadius(spin),
      horizon: 1 + Math.sqrt(1 - spin * spin),
      outer: 26,
      // A circular shadow with a spin-dependent offset is an imaging approximation.
      shadow: Math.sqrt(27) * (1 - 0.035 * spin * spin),
      offset: -1.25 * spin * Math.cos(settings.tilt * Math.PI / 180)
    };
  }

  function angularVelocity(radius, spin) {
    return 1 / (Math.pow(radius, 1.5) + spin);
  }

  // Zero-torque thin-disk temperature profile; this is not a full Novikov–Thorne solver.
  function temperature(radius, inner) {
    if (radius <= inner) return 0;
    const ratio = radius / inner;
    return Math.pow(ratio, -0.75) * Math.pow(1 - Math.sqrt(1 / ratio), 0.25) / 0.488;
  }

  globalThis.BlackHolePhysics = Object.freeze({ iscoRadius, model, angularVelocity, temperature });
})();
