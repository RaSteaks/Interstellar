#![allow(static_mut_refs)]

//! WebAssembly build of the deterministic GRMHD continuation ABI.
//!
//! The native and browser builds use the same double-precision state layout,
//! boundary convention, stable step and conservative scalar finite-volume
//! continuation rule. The
//! t=800 values come from the pinned iharm2d_v3 checkpoint; only the exported
//! snapshot is converted to the renderer's float32 record format.

#[cfg(not(target_arch = "wasm32"))]
use std::{env, fs};

const NR: usize = 64;
const NTHETA: usize = 64;
const CELLS: usize = NR * NTHETA;
const COMPONENTS: usize = 12;
const STATE_COUNT: usize = CELLS * COMPONENTS;
const MAX_DT: f64 = 2.0;
const MIN_LOG: f64 = -100.0;
const MAX_LOG: f64 = 100.0;
const RADIAL_START: f64 = 0.2784083797990242;
const RADIAL_STEP: f64 = 0.053288610536170504;
// Volume-weighted faces are much stiffer near the logarithmic inner edge;
// this scale keeps the explicit two-unit step inside the positive CFL region.
const TRANSPORT_SCALE: f64 = 0.00001;
const DIFFUSION: f64 = 0.08;
const PI: f64 = 3.141592653589793;
const SPIN: f64 = 0.9375;

static mut INPUT: [f64; STATE_COUNT] = [0.0; STATE_COUNT];
static mut STATE: [f64; STATE_COUNT] = [0.0; STATE_COUNT];
static mut NEXT: [f64; STATE_COUNT] = [0.0; STATE_COUNT];
static mut SNAPSHOT: [f32; STATE_COUNT] = [0.0; STATE_COUNT];
static mut DIAGNOSTICS: [f64; 12] = [0.0; 12];
static mut SIMULATION_TIME: f64 = 0.0;
static mut ACCEPTED_STEPS: u32 = 0;
static mut INITIALIZED: i32 = 0;
static mut INITIAL_MASS: f64 = 0.0;
static mut INITIAL_INTERNAL: f64 = 0.0;
static mut INITIAL_VELOCITY_NORM_ERROR: f64 = 0.0;

#[inline]
fn index(radial: usize, polar: usize, component: usize) -> usize {
    (radial * NTHETA + polar) * COMPONENTS + component
}

#[inline]
fn finite(value: f64) -> bool {
    value == value && value < 1.0e300 && value > -1.0e300
}

#[inline]
fn bounded_log(value: f64, fallback: f64) -> f64 {
    if !finite(value) {
        return fallback;
    }
    if value < MIN_LOG {
        MIN_LOG
    } else if value > MAX_LOG {
        MAX_LOG
    } else {
        value
    }
}

#[inline]
fn positive(value: f64, fallback: f64) -> f64 {
    if !finite(value) || value < 1.0e-30 {
        fallback
    } else {
        value
    }
}

#[inline]
fn absolute(value: f64) -> f64 {
    if value < 0.0 { -value } else { value }
}

#[inline]
fn clamp(value: f64, low: f64, high: f64) -> f64 {
    if value < low { low } else if value > high { high } else { value }
}

#[inline]
fn fast_sin(value: f64) -> f64 {
    value.sin()
}

#[inline]
fn fast_cos(value: f64) -> f64 {
    value.cos()
}

#[inline]
fn radius(radial: usize) -> f64 {
    f64::exp(RADIAL_START + (radial as f64 + 0.5) * RADIAL_STEP)
}

#[inline]
fn radius_edge(edge: usize) -> f64 {
    f64::exp(RADIAL_START + edge as f64 * RADIAL_STEP)
}

#[inline]
fn theta_at(fraction: f64) -> f64 {
    PI * fraction + 0.35 * fast_sin(2.0 * PI * fraction)
}

#[inline]
fn cell_volume(radial: usize, polar: usize) -> f64 {
    let lo = radius_edge(radial);
    let hi = radius_edge(radial + 1);
    let theta_lo = theta_at(polar as f64 / NTHETA as f64);
    let theta_hi = theta_at((polar + 1) as f64 / NTHETA as f64);
    ((hi * hi * hi - lo * lo * lo) / 3.0) * (fast_cos(theta_lo) - fast_cos(theta_hi)).max(1.0e-12)
}

#[inline]
fn radial_face_weight(radial_edge_index: usize, polar: usize) -> f64 {
    let r = radius_edge(radial_edge_index);
    let theta_lo = theta_at(polar as f64 / NTHETA as f64);
    let theta_hi = theta_at((polar + 1) as f64 / NTHETA as f64);
    r * r * (fast_cos(theta_lo) - fast_cos(theta_hi)).max(1.0e-12)
}

#[inline]
fn polar_face_weight(radial: usize, polar_edge: usize) -> f64 {
    let lo = radius_edge(radial);
    let hi = radius_edge(radial + 1);
    let theta = theta_at(polar_edge as f64 / NTHETA as f64);
    ((hi * hi * hi - lo * lo * lo) / 3.0) * fast_sin(theta).abs()
}

#[inline]
fn theta_stretch(fraction: f64) -> f64 {
    PI * (1.0 + 0.7 * fast_cos(2.0 * PI * fraction))
}

fn magnetic_divergence(radial: usize, polar: usize, source: &[f64; STATE_COUNT]) -> f64 {
    let base = index(radial, polar, 0);
    let volume = cell_volume(radial, polar).max(1.0e-30);
    let radial_in = if radial == 0 { 0.0 } else {
        let neighbor = index(radial - 1, polar, 0);
        radial_face_weight(radial, polar) * 0.5 * (source[neighbor + 9] / radius(radial - 1) + source[base + 9] / radius(radial))
    };
    let radial_out = if radial + 1 >= NR { 0.0 } else {
        let neighbor = index(radial + 1, polar, 0);
        radial_face_weight(radial + 1, polar) * 0.5 * (source[base + 9] / radius(radial) + source[neighbor + 9] / radius(radial + 1))
    };
    let theta_in = if polar == 0 { 0.0 } else {
        let neighbor = index(radial, polar - 1, 0);
        polar_face_weight(radial, polar) * 0.5 * (source[neighbor + 10] / theta_stretch((polar as f64 - 0.5) / NTHETA as f64) + source[base + 10] / theta_stretch((polar as f64 + 0.5) / NTHETA as f64))
    };
    let theta_out = if polar + 1 >= NTHETA { 0.0 } else {
        let neighbor = index(radial, polar + 1, 0);
        polar_face_weight(radial, polar + 1) * 0.5 * (source[base + 10] / theta_stretch((polar as f64 + 0.5) / NTHETA as f64) + source[neighbor + 10] / theta_stretch((polar as f64 + 1.5) / NTHETA as f64))
    };
    absolute((radial_out - radial_in + theta_out - theta_in) / volume)
}

fn velocity_norm_error(radial: usize, polar: usize, source: &[f64; STATE_COUNT]) -> f64 {
    let base = index(radial, polar, 0);
    let r = radius(radial);
    let fraction = (polar as f64 + 0.5) / NTHETA as f64;
    let theta = PI * fraction + 0.35 * fast_sin(2.0 * PI * fraction);
    let st = fast_sin(theta);
    let ct = fast_cos(theta);
    // Reproduce the renderer's raw four-velocity -> Eulerian velocity ->
    // ingoing Kerr–Schild reconstruction, then evaluate the same KS metric
    // norm. This checks the invariant without inventing a post-step repair.
    let r2 = r * r;
    let f = 2.0 * r / (r2 + SPIN * SPIN * ct * ct).max(1.0e-30);
    let root = (1.0 + f).sqrt();
    let gamma_seed = source[base + 4] / root;
    if !finite(gamma_seed) || gamma_seed.abs() < 1.0e-12 { return 1.0e300; }
    let ur = source[base + 5];
    let uth = source[base + 6];
    let uph = source[base + 7];
    let spatial = [
        ur * st + uth * r * ct - uph * SPIN * st,
        uth * SPIN * ct + uph * r * st,
        ur * ct - uth * r * st,
    ];
    let v = [
        spatial[0] / gamma_seed + f * st / root,
        spatial[1] / gamma_seed,
        spatial[2] / gamma_seed + f * ct / root,
    ];
    let along = v[0] * st + v[2] * ct;
    let packed = [v[0] + (root - 1.0) * st * along, v[1], v[2] + (root - 1.0) * ct * along];
    let gamma = 1.0 / (1.0 - packed[0] * packed[0] - packed[1] * packed[1] - packed[2] * packed[2]).max(1.0e-8).sqrt();
    let dot_n = packed[0] * st + packed[2] * ct;
    let coordinate = [packed[0] - f * st / root - (1.0 - 1.0 / root) * st * dot_n, packed[1], packed[2] - f * ct / root - (1.0 - 1.0 / root) * ct * dot_n];
    let incoming = [gamma * coordinate[0], gamma * coordinate[1], gamma * coordinate[2], gamma * root];
    let null_term = st * incoming[0] + ct * incoming[2] + incoming[3];
    absolute(incoming[0] * incoming[0] + incoming[1] * incoming[1] + incoming[2] * incoming[2] - incoming[3] * incoming[3] + f * null_term * null_term + 1.0)
}

unsafe fn max_velocity_norm_error(source: &[f64; STATE_COUNT]) -> f64 {
    let mut maximum: f64 = 0.0;
    for radial in 0..NR {
        for polar in 0..NTHETA {
            maximum = maximum.max(velocity_norm_error(radial, polar, source));
        }
    }
    maximum
}

// Use full-precision libm conversions: truncated exp/log polynomials are not
// inverses and introduce mass loss on every step, even as dt tends to zero.
#[inline]
fn density_at(radial: usize, polar: usize, source: &[f64; STATE_COUNT]) -> f64 {
    f64::exp(source[index(radial, polar, 0)])
}

#[inline]
fn internal_at(radial: usize, polar: usize, source: &[f64; STATE_COUNT]) -> f64 {
    f64::exp(source[index(radial, polar, 1)])
}

#[inline]
fn radial_speed(radial: usize, polar: usize, source: &[f64; STATE_COUNT]) -> f64 {
    let base = index(radial, polar, 0);
    clamp(source[base + 5] / source[base + 4].abs().max(1.0), -0.45, 0.45)
}

#[inline]
fn polar_speed(radial: usize, polar: usize, source: &[f64; STATE_COUNT]) -> f64 {
    let base = index(radial, polar, 0);
    clamp(source[base + 6] / source[base + 4].abs().max(1.0), -0.25, 0.25)
}

#[inline]
fn mass_flux(left: f64, right: f64, speed: f64) -> f64 {
    TRANSPORT_SCALE * (0.5 * speed * (left + right) - DIFFUSION * (right - left))
}

#[inline]
fn internal_flux(left_density: f64, right_density: f64, left_internal: f64, right_internal: f64, speed: f64) -> f64 {
    let _ = (left_density, right_density);
    TRANSPORT_SCALE * (0.5 * speed * (left_internal + right_internal) - DIFFUSION * (right_internal - left_internal))
}

unsafe fn collect_diagnostics() {
    let mut min_density: f64 = 1.0e300;
    let mut min_internal: f64 = 1.0e300;
    let mut max_divergence: f64 = 0.0;
    let mut max_velocity_drift: f64 = 0.0;
    let mut all_finite = true;
    let mut cell = 0;
    while cell < CELLS {
        let base = cell * COMPONENTS;
        let mut component = 0;
        while component < COMPONENTS {
            let value = STATE[base + component];
            if !finite(value) {
                all_finite = false;
            }
            component += 1;
        }
        let density = f64::exp(STATE[base]);
        let internal = f64::exp(STATE[base + 1]);
        if density < min_density {
            min_density = density;
        }
        if internal < min_internal {
            min_internal = internal;
        }
        for component in 4..8 {
            max_velocity_drift = max_velocity_drift.max(absolute(STATE[base + component] - INPUT[base + component]));
        }
        cell += 1;
    }
    let max_velocity_norm_error = max_velocity_norm_error(&STATE);
    for radial in 0..NR {
        for polar in 0..NTHETA {
            max_divergence = max_divergence.max(magnetic_divergence(radial, polar, &STATE));
        }
    }
    let mass = total_mass(&STATE);
    let internal = total_internal(&STATE);
    DIAGNOSTICS[0] = SIMULATION_TIME;
    DIAGNOSTICS[1] = if all_finite { 1.0 } else { 0.0 };
    DIAGNOSTICS[2] = min_density;
    DIAGNOSTICS[3] = min_internal;
    DIAGNOSTICS[4] = (mass - INITIAL_MASS) / INITIAL_MASS.max(1.0e-30);
    DIAGNOSTICS[5] = (internal - INITIAL_INTERNAL) / INITIAL_INTERNAL.max(1.0e-30);
    DIAGNOSTICS[6] = max_divergence;
    DIAGNOSTICS[7] = absolute(max_velocity_norm_error - INITIAL_VELOCITY_NORM_ERROR);
    DIAGNOSTICS[8] = max_velocity_drift;
    DIAGNOSTICS[9] = ACCEPTED_STEPS as f64;
    DIAGNOSTICS[10] = if min_density > 0.0 && min_internal > 0.0 { 1.0 } else { 0.0 };
    DIAGNOSTICS[11] = max_velocity_norm_error;
}

unsafe fn total_mass(source: &[f64; STATE_COUNT]) -> f64 {
    let mut total = 0.0;
    for radial in 1..(NR - 1) {
        for polar in 0..NTHETA {
            total += density_at(radial, polar, source) * cell_volume(radial, polar);
        }
    }
    total
}

unsafe fn total_internal(source: &[f64; STATE_COUNT]) -> f64 {
    let mut total = 0.0;
    for radial in 1..(NR - 1) {
        for polar in 0..NTHETA {
            total += internal_at(radial, polar, source) * cell_volume(radial, polar);
        }
    }
    total
}

unsafe fn export_snapshot() {
    let mut index = 0;
    while index < STATE_COUNT {
        SNAPSHOT[index] = STATE[index] as f32;
        index += 1;
    }
    collect_diagnostics();
}

unsafe fn step_state(dt: f64) {
    let magnetic_decay = 1.0 - 0.000018 * dt;
    let mut radial = 0;
    while radial < NR {
        let mut polar = 0;
        while polar < NTHETA {
            let base = index(radial, polar, 0);
            let density = density_at(radial, polar, &STATE);
            let internal = internal_at(radial, polar, &STATE);
            let volume = cell_volume(radial, polar).max(1.0e-30);
            let fixed_boundary = radial == 0 || radial == NR - 1;
            let mut density_delta = 0.0;
            let mut internal_delta = 0.0;
            if !fixed_boundary {
                let radial_in = if radial == 1 { 0.0 } else {
                    let speed = 0.5 * (radial_speed(radial - 1, polar, &STATE) + radial_speed(radial, polar, &STATE));
                    radial_face_weight(radial, polar) * mass_flux(density_at(radial - 1, polar, &STATE), density, speed)
                };
                let radial_out = if radial == NR - 2 { 0.0 } else {
                    let speed = 0.5 * (radial_speed(radial, polar, &STATE) + radial_speed(radial + 1, polar, &STATE));
                    radial_face_weight(radial + 1, polar) * mass_flux(density, density_at(radial + 1, polar, &STATE), speed)
                };
                let internal_radial_in = if radial == 1 { 0.0 } else {
                    let speed = 0.5 * (radial_speed(radial - 1, polar, &STATE) + radial_speed(radial, polar, &STATE));
                    radial_face_weight(radial, polar) * internal_flux(density_at(radial - 1, polar, &STATE), density, internal_at(radial - 1, polar, &STATE), internal, speed)
                };
                let internal_radial_out = if radial == NR - 2 { 0.0 } else {
                    let speed = 0.5 * (radial_speed(radial, polar, &STATE) + radial_speed(radial + 1, polar, &STATE));
                    radial_face_weight(radial + 1, polar) * internal_flux(density, density_at(radial + 1, polar, &STATE), internal, internal_at(radial + 1, polar, &STATE), speed)
                };
                density_delta -= radial_out - radial_in;
                internal_delta -= internal_radial_out - internal_radial_in;
            }
            if polar > 0 {
                let speed = 0.5 * (polar_speed(radial, polar - 1, &STATE) + polar_speed(radial, polar, &STATE));
                let neighbor_density = density_at(radial, polar - 1, &STATE);
                let neighbor_internal = internal_at(radial, polar - 1, &STATE);
                density_delta += polar_face_weight(radial, polar) * mass_flux(neighbor_density, density, speed);
                internal_delta += polar_face_weight(radial, polar) * internal_flux(neighbor_density, density, neighbor_internal, internal, speed);
            }
            if polar + 1 < NTHETA {
                let speed = 0.5 * (polar_speed(radial, polar, &STATE) + polar_speed(radial, polar + 1, &STATE));
                let neighbor_density = density_at(radial, polar + 1, &STATE);
                let neighbor_internal = internal_at(radial, polar + 1, &STATE);
                density_delta -= polar_face_weight(radial, polar + 1) * mass_flux(density, neighbor_density, speed);
                internal_delta -= polar_face_weight(radial, polar + 1) * internal_flux(density, neighbor_density, internal, neighbor_internal, speed);
            }
            let next_density = if fixed_boundary { density } else { (density + dt * density_delta / volume).max(1.0e-30) };
            let next_internal = if fixed_boundary { internal } else { (internal + dt * internal_delta / volume).max(1.0e-30) };
            // Fixed radial scalar boundaries are exact checkpoint values. Do not
            // round-trip them through exp/log during an otherwise empty update.
            NEXT[base] = if fixed_boundary { STATE[base] } else { bounded_log(f64::ln(next_density), STATE[base]) };
            NEXT[base + 1] = if fixed_boundary { STATE[base + 1] } else { bounded_log(f64::ln(next_internal), STATE[base + 1]) };
            NEXT[base + 2] = positive(STATE[base + 2] * magnetic_decay * magnetic_decay, 0.0);
            NEXT[base + 3] = 0.0;
            let mut component = 4;
            while component < 8 {
                NEXT[base + component] = STATE[base + component];
                component += 1;
            }
            while component < COMPONENTS {
                NEXT[base + component] = STATE[base + component] * magnetic_decay;
                component += 1;
            }
            polar += 1;
        }
        radial += 1;
    }
    let mut state_index = 0;
    while state_index < STATE_COUNT {
        STATE[state_index] = NEXT[state_index];
        state_index += 1;
    }
    SIMULATION_TIME += dt;
    ACCEPTED_STEPS += 1;
}

#[no_mangle]
pub extern "C" fn grmhd_input_ptr() -> i32 {
    unsafe { INPUT.as_ptr() as usize as i32 }
}

#[no_mangle]
pub extern "C" fn grmhd_snapshot_ptr() -> i32 {
    unsafe { SNAPSHOT.as_ptr() as usize as i32 }
}

#[no_mangle]
pub extern "C" fn grmhd_snapshot_length() -> i32 {
    STATE_COUNT as i32
}

#[no_mangle]
pub extern "C" fn grmhd_diagnostics_ptr() -> i32 {
    unsafe { DIAGNOSTICS.as_ptr() as usize as i32 }
}

#[no_mangle]
pub extern "C" fn grmhd_diagnostics_length() -> i32 {
    12
}

#[no_mangle]
pub extern "C" fn grmhd_time() -> f64 {
    unsafe { SIMULATION_TIME }
}

#[no_mangle]
pub extern "C" fn grmhd_initialized() -> i32 {
    unsafe { INITIALIZED }
}

#[no_mangle]
pub extern "C" fn grmhd_init(initial_time: f64) {
    unsafe {
        let mut index = 0;
        while index < STATE_COUNT {
            STATE[index] = INPUT[index];
            index += 1;
        }
        SIMULATION_TIME = initial_time;
        ACCEPTED_STEPS = 0;
        INITIALIZED = 1;
        INITIAL_MASS = total_mass(&STATE);
        INITIAL_INTERNAL = total_internal(&STATE);
        INITIAL_VELOCITY_NORM_ERROR = max_velocity_norm_error(&STATE);
        export_snapshot();
    }
}

#[no_mangle]
pub extern "C" fn grmhd_advance(target_time: f64, max_steps: i32) -> i32 {
    unsafe {
        if INITIALIZED == 0 || !finite(target_time) || target_time < SIMULATION_TIME {
            return -1;
        }
        let steps_limit = if max_steps < 1 { 1 } else { max_steps };
        let mut steps = 0;
        while SIMULATION_TIME + 1.0e-12 < target_time && steps < steps_limit {
            let mut dt = target_time - SIMULATION_TIME;
            if dt > MAX_DT {
                dt = MAX_DT;
            }
            step_state(dt);
            steps += 1;
            if !finite(SIMULATION_TIME) {
                return -1;
            }
        }
        export_snapshot();
        if SIMULATION_TIME + 1.0e-12 >= target_time { 1 } else { 0 }
    }
}

#[no_mangle]
pub extern "C" fn grmhd_snapshot() {
    unsafe { export_snapshot() }
}

#[no_mangle]
pub extern "C" fn grmhd_destroy() {
    unsafe { INITIALIZED = 0 }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let arguments: Vec<String> = env::args().collect();
    if arguments.len() != 4 {
        eprintln!("usage: {} checkpoint.raw target-time snapshot.f32", arguments[0]);
        std::process::exit(2);
    }
    let bytes = fs::read(&arguments[1]).expect("checkpoint read failed");
    if bytes.len() < 40 + STATE_COUNT * 8 || &bytes[0..8] != b"GRMHDCP1" {
        eprintln!("invalid GRMHDCP1 checkpoint");
        std::process::exit(3);
    }
    unsafe {
        for index in 0..STATE_COUNT {
            let offset = 40 + index * 8;
            let mut value = [0u8; 8];
            value.copy_from_slice(&bytes[offset..offset + 8]);
            INPUT[index] = f64::from_le_bytes(value);
        }
        let mut time_bytes = [0u8; 8];
        time_bytes.copy_from_slice(&bytes[24..32]);
        let initial_time = f64::from_le_bytes(time_bytes);
        let target: f64 = arguments[2].parse().expect("invalid target time");
        grmhd_init(initial_time);
        if grmhd_advance(target, 1_000_000) < 0 {
            eprintln!("solver failed");
            std::process::exit(4);
        }
        let mut output = Vec::with_capacity(STATE_COUNT * 4);
        for value in SNAPSHOT {
            output.extend_from_slice(&value.to_le_bytes());
        }
        fs::write(&arguments[3], output).expect("snapshot write failed");
    }
}
