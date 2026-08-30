# Agent Note: Blueprint 几何信息由展示就绪驱动

Status: implemented

[English](2026-08-28-blueprint-layout-presentation-readiness.md) | 中文

## 问题

Blueprint 已投影内容时，详情 store 仍可能保持关闭：延后的打开操作依赖上下文同步，而同步可能在冷启动 Session 物化期间拒绝。Session 变化的布局 effect 也可能关闭已展开的面板。这两种问题均不属于容器测量失败。让几何信息依赖内容恢复，会使有效面板被裁剪为零宽。

## 决策

Blueprint 在展示 slot 注册时申请展开详情栏。布局控制器保留最新的打开或关闭请求，直到根布局操作接入，再消费一次。AppFrame 仅根据布局 store 和已测量的框架计算宽度。Session slot 仍拥有内容隔离；hydration、target 恢复和 Session 选择不能写入宽度。这替代了[已归档的会话详情栏决策](../../archived/bug-fix/2026-07-29-web-details-session-lifecycle.md)中的几何耦合，同时保留其瞬时存储和 Session 作用域内容归属。

零表示显式关闭或窄 viewport 的派生让步结果，不是尚未测量的持久偏好。ResizeObserver 忽略零测量。重复打开保留当前拖动宽度；显式关闭仍然有效。不引入持久化、定时器、重试或新的业务就绪状态。

## 考虑过的替代方案

**延时打开或启动后刷新。** 否决，因为经过的时间不能证明根布局接入或几何信息有效。

**每次投影或 Session 更新后打开。** 否决，因为内容 RPC 失败仍会控制几何信息，重复 hydration 还可能覆盖显式关闭。

**持久化宽度。** 否决，因为当前不存在需要修复的几何持久化读取器；持久化属于独立功能。

## 后果

Session 作用域内容 hydration 期间，已展开的外壳栏可以暂时为空。slot 归属未变，因此不会显示其他 Session 的内容。原先 Session 切换自动关闭的行为被移除；显式关闭和 viewport 让步仍然保留。单元测试覆盖挂载前请求、hydration、重复接入、拖动宽度、显式关闭以及忽略旧存储。可运行 Web 示例通过组装快照固定 Draft 和 Session 切换时的几何信息。真实上下文错误仍可见，不会被转换为业务恢复成功。
