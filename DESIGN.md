---
version: alpha
name: "Interstellar 黑洞观测站"
description: "用粒子吸积盘探索黑洞的中文交互展览"
colors:
  primary: "#efb77b"
  background: "#08090d"
  surface: "#14151b"
  text: "#f4f0e9"
  muted: "#b5b1aa"
  border: "#343239"
  focus: "#f5cc9e"
typography:
  sans:
    fontFamily: "PingFang SC, Microsoft YaHei, system-ui, sans-serif"
  display:
    fontFamily: "Songti SC, STSong, Georgia, serif"
  mono:
    fontFamily: "SFMono-Regular, Consolas, monospace"
rounded:
  DEFAULT: "0.5rem"
  panel: "0.75rem"
  pill: "999px"
spacing:
  section-gap: "5rem"
  page-max: "88rem"
components:
  button: {}
  range: {}
  panel: {}
---

# Interstellar 设计方案

## Overview

### Creative North Star

一间深夜的天文观测室：黑色视野、琥珀色发光物质、克制的观测仪器。整个首屏就是观测面，最醒目的元素是实时旋转的吸积盘。

### Product context and register

- 中文天文和图形爱好者，通过直接操作探索粒子黑洞；简体中文 UI，项目原名保留英文。
- 单页交互数字展览，不需要账号、业务数据或持久化。
- 桌面可拖动、滚轮和键盘操作；手机使用相同参数，控件自然排列到画面下方。
- 独特视觉集中于粒子吸积盘，周边控件保持安静；不使用宣传式大按钮、虚构观测数据。
- `dist/styles.css` 的 `:root` 是运行时 token 的唯一来源；本文映射对应 `--accent`、`--bg`、`--surface`、`--text`、`--muted`、`--line`、`--focus`。原生控件使用同一组变量。

## Colors

深黑背景与暖白文字，琥珀强调只用于选中状态和参数。粒子采用由内向外的暖白、琥珀和暗红渐变，冰蓝模式只切换可视化颜色。滚动条使用全局颜色变量；强制颜色模式交给系统。

## Typography

宋体用于中文展览标题；无衬线用于正文及操作，正文 16px、控件 14px，12px 仅用于次要英文元信息。等宽字体用于参数读数，保留稳定的数字宽度。使用系统字体以避免加载后布局跳变。

## Layout

导航与画面同宽。首屏的画面中央是黑洞，左侧简短标题，右侧是 272px 观测面板。宽度低于 1000px 时面板进入文档流，画面仍先呈现。低于 600px 时标题和场景控件简化排列。页面支持自然滚动和文字放大。

## Elevation & Depth

参数面板使用深色半透明表面和细边框，粒子光晕承担视觉深度；正文区使用分割线，不堆叠阴影卡片。

## Shapes

主面板 12px 圆角，按钮 8px，短模式按钮使用胶囊。线条与圆形图标统一 1.5px 描边。

## Components

原生 button、a、input[type=range] 是本项目唯一控件来源；不存在可复用的原有组件。滑块自带键盘操作和显式 label/output；拖动操作始终有滑块替代。统一可见焦点，hover 与 pressed 状态。不可用全屏操作给出内联状态。

共享状态由 `dist/app.js` 维护，暂停、预设、重置和 WebMCP 调用复用同一更新函数。状态反馈由 `role=status` 区域负责。无弹窗和业务表单。

### Motion

控件反馈 180ms，物理场景按时间推进；减少动态效果时默认暂停，用户可主动播放。页面隐藏不推进时间，恢复不追赶遗漏帧。暂停时只有参数变化触发重绘。

### Content and data visualization

数字只描述当前真实参数，粒子数反映实际渲染数量。网站将透镜与发光效果标注为艺术近似。参考链接指向已查阅的原始 GitHub 仓库。

## Do's and Don'ts

- 保持画面先于解释；参数用中文命名，读数不制造科学精确性。
- 保持对比度和原生键盘操作；禁止用隐藏滚动条或裁切正文维护画面比例。
- 不将艺术近似称作严格的广义相对论模拟。
