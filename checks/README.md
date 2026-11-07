# 检查入口与维护范围

从仓库根目录运行。没有 npm 依赖安装或构建步骤；默认检查只需要 Node 和 Python 3：

```bash
node checks/run.cjs
```

默认 `core` 执行下表的五个检查。输出与失败日志保存在 `verification/checks/`；可直接运行其中一个脚本。数据或求解器变更才运行对应分组，也可组合运行 `node checks/run.cjs core data solver`。

| 分组 / 文件 | 唯一职责 |
| --- | --- |
| core · `physical-core.cjs` | 当前科学核心：时空、光谱、传输、世界线、偏振屏幕、二维数据完整性；包含原 orbital / screen 数值检查 |
| core · `render-physics.cjs` | 历史数值基准与 Canvas 共用物理：光线、盘面、坠落粒子；不检查旧 GPU 着色器的源码结构 |
| core · `navigation.cjs` | 缩放映射、手势输入、去重、缓动和漂移步进 |
| core · `idle-drift.cjs` | 真实 app 状态与事件整合：暂停、减少动态效果、预设、原子拒绝和旅程；DOM/GPU 使用替身 |
| core · `grmhd3d-io.py` | 确定性 VTK 数据读写边界与多块拼接，包含截断、重叠和时刻不一致 |
| data · `grmhd3d-data.cjs` | 发布的三维数据哈希、来源、真实演化与因果速度；需完整本地数据 |
| solver · `continuous-solver.cjs` | 检查点恢复、native/Wasm 对照和长程守恒；需 `rustc` |
| solver · `grmhd-worker.cjs` | 生产 Worker/加载器/Wasm 的消息生命周期、快照间隔、背压和缓存 |

## 浏览器检查：按改动选择

使用本机已有 Playwright，不连接个人浏览器。默认隔离的 headless WebKit，可设置 `SIMULATION_BROWSER=firefox`；预览页脚本使用 `PREVIEW_BROWSER=firefox`。不支持 Chrome。触控模拟不能替代真实 iPhone 的地址栏和安全区验证。

```bash
python3 -m http.server 18786 --bind 127.0.0.1
# 在另一个终端运行所需的检查：
PLAYWRIGHT_MODULE=/path/to/playwright node checks/physical-browser.cjs http://127.0.0.1:18786
```

| 文件 | 运行时机与范围 |
| --- | --- |
| `physical-browser.cjs` | 通用渲染/桌面控件变更：多物理场景、系数 CPU/GPU 对照、真实 Worker、原生控件和 Canvas 回退 |
| `mobile-controls.cjs` | 控制面板或尺寸处理变更：4 组代表性布局，触控、短屏滚动、动态标题、重复 resize 与全屏不可用 |
| `render-performance.cjs` | 渲染缓存/调度变更：GPU 提交、渐进采样、诊断、预算与过滤回退；使用同名 HTML 检查页 |
| `plunge-orbit-browser.cjs` | 绕行场景变更：GPU 内外视界、盘面演化与真实旅程操作 |
| `grmhd3d-browser.cjs` | 三维渲染/加载变更：真实数据、演化、控件及解析屏幕与连接 ODE 对照；`--smoke` 仅运行渲染冒烟，不含完整屏幕与 UI 验收 |
| `grmhd3d-sampling.cjs` | 采样器变更：实际 GLSL 的周期接缝、空间/时间插值与历史边界；无需 HTTP 服务 |
| `preview.cjs` | 嵌入预览/响应头变更：需 README 中的本地 Cloudflare 资产服务，普通 HTTP 服务不能验证 `_headers` |

`physical-browser.html` 是多个 GPU 套件共用的检查页，不是额外测试入口。截图、报告和可用的 trace 保留在各脚本对应的 `verification/` 子目录。

## 昂贵的专项验收

- `thermal-acceptance.cjs`：热盘域、边界和数值收敛；只需当前版本服务，不再重复运行性能测量。报告中的 `domainConverged=false` 表示边界目标未达，不能将脚本退出成功解释为全项科学验收通过。
- `thermal-performance.cjs`：唯一的版本性能对比入口；需要当前与历史基线两个服务，固定光线预算、预热及交错采样。基线由使用者保存在 `verification/thermal/baseline/`，缺失时不能声称比较完成。
- `grmhd3d-frames.py`、`grmhd3d-eos.py`、`grmhd3d-winding.py`：仅在上游补丁、原生求解器或数据生成变更时运行。分别验证法向场索引、EOS 失败路径和磁绕卷，依赖及命令见 [原生求解器说明](../tools/grmhd3d/README.md#verification--验证)。保留它们的独立物理参照和失败证据。

## 精简原则

按模块与行为维护套件，不按每次修复新增文件或测试。先判断现有检查能否覆盖；只有缺少重要、可观测的行为验证时，才在所属套件补充必要用例。

不锁定函数拼写、着色器数量、选项数量或完整文案，不复制生产公式作为预期值。代表性布局覆盖不同分支，避免无差别的场景 × 尺寸排列。CPU 科学参照和真实 GPU 对照验证不同风险，应同时保留。

本轮删除两份应用不再调用的旧粒子 GPU 检查页；其历史证据仍在 Git 历史。坠落粒子、绕行世界线和偏振屏幕数值检查已归并到物理套件，三维屏幕 GPU 对照归并到三维浏览器验收。历史 `AGENT.md` 记录中的旧命令不作为当前运行指南。
