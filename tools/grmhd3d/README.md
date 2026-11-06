# Global three-dimensional GRMHD / 全局三维 GRMHD

The native solver advances density, momentum, total energy and the magnetic field
on a three-dimensional spherical Kerr–Schild mesh. The website only decodes these
states and performs relativistic radiation transfer. Its loader Worker does not
solve fluid equations or synthesize turbulence.

原生求解器推进三维密度、动量、总能量与磁场；网页加载实际快照并追踪弯曲光路。加载
Worker 只校验、解压和转换插值速度，不把参数化发光结构当作湍流计算。

## Source and patches / 来源与补丁

- Athena++: `https://github.com/PrincetonUniversity/athena.git`, pinned to
  `053bc738d5c85dac717326b4338b34c7db4e715d` (BSD-3-Clause; see `ATHENA-LICENSE.txt`).
- `athena.patch` corrects six obsolete one-dimensional normal-field reads in the
  selected Kerr–Schild coordinate transforms. The GR Riemann interface passes full
  three-dimensional face arrays, so those reads must use `(k,j,i)`.
- The patch adds only a once-applied nonaxisymmetric velocity seed, a divergence-free
  vertical-field initializer, native CT/four-vector diagnostics, and full-precision
  VTK timestamps in addition to that interface fix. It does not replace the GRMHD
  evolution equations.

固定提交与完整补丁都进入数据来源清单。六处索引修正经过三轴解析法向场测试和单步绕卷
测试：恢复旧索引时测试能够检出错误。初始化采用 `A_phi = B0 r² sin²(theta)/2`，面磁场仍
由原生离散旋度生成。小扰动只在初始时刻施加，后续结构来自原生三维演化。

`eos-failure.patch` is a supplemental repair for future builds: failed primitive
inversions cannot supply an unspecified magnetic pressure to the floors, and a
velocity ceiling must update its Lorentz factor before recomputing that pressure.
Production-call tests exercise first/retry failures and the ceiling; reverting the
repair in an isolated copy reproduces each broken contract. This evidence does
not establish the cause of a separate HLLD energy runaway. The supplied dataset
predates this repair and records only its actual core patch; future manifests
list the supplemental patch separately.

补充 EOS 修复只用于后续新编译：反演失败时使用与回退速度一致的磁压，速度上限处理后
同步洛伦兹因子。测试验证实际生产调用的三种边界路径；没有把它倒写成现有数据的来源，
也没有将独立的 HLLD 失稳归因于尚未复现的触发路径。

## Physical configuration / 物理配置

The maintained case uses `a=0`, `gamma=4/3`, `96×64×32` cells, full periodic
azimuth, `r=1.5..64`, and polar outflow cutouts of 15 degrees. The equilibrium
torus has `r_edge=6`, `r_peak=15`, with a density-weighted initial `H/R` near 0.16.
The vertical seed is calibrated by `max(p_gas)/max(p_mag)=20`; this is not the local
beta in every cell. `initialMRIQuality` reports the actual dense-gas vertical MRI
sampling, and does not assert turbulent saturation or convergence.

模型包括极区裁切、数值大气层和磁化/速度 floors，必须保留这些限制。实际初始化的最大
磁化度可以稍高于配置值，不能把 `sigma_max` 当作实测硬上限。方位分辨率 32、有限时长、
理想 MHD 数值耗散及缺少辐射反馈，都不支持统计收敛或观测拟合的宣称。

## Build and run / 编译与运行

Requirements are Python 3.9+, Git, Make and Clang++. OpenMP is optional; Apple
Clang needs an existing LLVM libomp installation. The website has no new package
or third-party JavaScript runtime dependency.

从仓库根目录运行。默认在临时目录检出固定源码；`--source` 可以复用固定提交的检出目录，
但脚本会拒绝不同补丁或其它源码改动。重新配置后必须 `make clean`，避免混用通量求解器
对象文件。线程数由参数和实际多个 MeshBlock 共同控制。

```bash
python3 tools/generate-grmhd3d.py \
  --threads 8 --openmp-prefix /opt/homebrew/opt/libomp \
  --run-directory verification/grmhd3d/run-new \
  --time 400
```

Default numerical settings are the robust HLLE flux, PLM reconstruction and
CFL 0.2. `athinput.seed-hlld` preserves the earlier HLLD/PPM input for documented
method comparisons. The packaged manifest declares numerical stages if a native
restart was continued with a different method; it must not imply a single-method
run when methods changed.

默认采用 HLLE、PLM、CFL 0.2。较高阶的 HLLD/PPM 试算不能仅凭有限值、散度和四速度检查
就发布：若出现总 Killing 能量异常放大，打包会失败并保留诊断文件。这是选定孤立环、
无外部热源模型的粗失稳门槛，不是严格的全局能量守恒或边界通量误差证明。

The supplied 21-frame history covers `t=0..400 GM/c³`: HLLD/PPM/CFL 0.3 to the
full-precision checkpoint at `t=200.0019262229277`, then HLLE/PLM/CFL 0.2 to 400.
The discarded all-HLLD trial is retained only as failure evidence. The valid
history has maximum native CT divergence `3.50e-13` in code units (relative
divergence `5.22e-11`), four-velocity
norm error `9.11e-15`, and peak absolute Killing-energy amplification `1.000262`.
These checks do not establish saturated or resolution-converged turbulence.

当前数据按真实阶段记录，不冒充单一数值方法。采用完整双精度原生检查点切换方法，
没有从展示快照恢复演化；21 帧保留所有 32 个方位单元，压缩下载约164.4 MiB。

## Full-precision continuation / 完整精度续算

```bash
python3 tools/generate-grmhd3d.py \
  --source /path/to/pinned/athena --threads 8 \
  --run-directory verification/grmhd3d/run-new \
  --restart verification/grmhd3d/run-new/grmhd3d.final.rst \
  --time 2000 --max-frames 32
```

Use the latest native restart in the same directory. To resume an older checkpoint,
use a new run directory so future snapshots are preserved. Native restarts retain
the double-precision evolution state; exported float32 images are not restarts.
Only the newest consecutive rendering frames are exported within the texture
budget. Their actual time window and recommended observation epoch are in the
manifest; the browser never loops or extrapolates missing states.

原始 VTK、历史、构建日志和重启文件保留在 `verification/`，不进入站点。三维打包保留所有
方位单元，不旋转二维平均场。多个 MeshBlock 由真实坐标面拼接，缺块、重叠、布局或时间
不一致会被拒绝。数据按最多 64 MiB 原始字节分块，每块及整体均校验 SHA-256，清单最后
原子替换。对浏览器而言，暂停只冻结选定观察事件，独立原生计算由本机进程管理。

## Verification / 验证

```bash
python3 checks/grmhd3d-io.py
python3 checks/grmhd3d-frames.py --source /path/to/configured/athena \
  --input tools/grmhd3d/athinput.torus --output verification/grmhd3d/frame-check
# Add --original-bug in a different empty output directory to verify rejection.
python3 checks/grmhd3d-winding.py --source /path/to/configured/athena \
  --output verification/grmhd3d/winding-check
python3 checks/grmhd3d-eos.py --source /path/to/eos-patched/athena \
  --input tools/grmhd3d/athinput.torus --output verification/grmhd3d/eos-check
node checks/grmhd3d-data.cjs
node checks/schwarzschild-screen.cjs
PLAYWRIGHT_MODULE=/path/to/playwright node checks/grmhd3d-sampling.cjs
PLAYWRIGHT_MODULE=/path/to/playwright node checks/grmhd3d-screen.cjs
PLAYWRIGHT_MODULE=/path/to/playwright node checks/grmhd3d-browser.cjs http://127.0.0.1:18786
```

Browser tests use isolated headless WebKit or Firefox (`SIMULATION_BROWSER`),
never Chrome or personal profiles. Native mesh invariants are measured before
float32 export. Radiation-field interpolation is an additional approximation and
does not preserve native face-based CT divergence exactly. Screenshots, traces,
source/binary hashes and numerical reports stay in `verification/grmhd3d/`.
