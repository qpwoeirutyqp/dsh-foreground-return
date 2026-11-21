# 更新记录

## 0.2.0

- 新增前台应用白名单 `allowForegroundPackages`：只在指定的 App 前台时才抢屏，支持尾部通配
- 新增前台应用黑名单 `denyForegroundPackages`，优先级高于白名单
- 新增 `allowWhenUnknown`：前台包名读不出来时的降级策略，默认放行
- `report` 增加 `gate` 与 `foregroundPackage` 字段，判定过程可复查
- 新增 `foreground-package.js`：前台包名解析与包名匹配，独立可测
- 单测从 7 个扩到 25 个，覆盖解析、通配、名单优先级与降级路径

## 0.1.0

首个版本。

- 一轮对话在后台结束时，把 DSHA 拉回前台
- 只认当前进程的根 agent：子 Agent 与历史回放不触发
- 先读 `/app/device` 的 `app_foreground`，已在前台则不打扰
- `launch` 后回读确认，没到前台自动重试（默认 3 次）
- 冷却时间、短轮次过滤、停止/中断可选触发
- `/__dsha_foreground_return` 手动演练端点
- 桥端口每次现读不缓存，凭据只进请求头
- 配置经 `Config` schema 校验，7 个离线单测覆盖默认值与边界
