# dsh-foreground-return

> DSHA 插件：一轮任务在后台跑完之后，自动把 DSHA 强制切回前台。

你在刷别的 App、看视频、或者手机锁着屏，Agent 还在后台干活。它跑完了你不知道，得自己想起来切回来。
这个插件补上最后一环——**跑完了，自己把手机界面拉回来给你看**。

适用环境：DeepSeek Harness（DSH）+ DSHA Android 客户端。

---

## 它做什么

| 场景 | 行为 |
|---|---|
| DSHA 在后台，任务正常跑完 | 把 DSHA 拉到前台 |
| DSHA 已在前台（你正看着） | 什么都不做，不打扰 |
| 用户主动停止 / 被中断 | 默认不抢屏，可配置开启 |
| 子 Agent 的轮次结束 | 不触发，只认根 agent |
| 历史回放 / 被替换的 agent | 不触发 |

一轮对话结束后，插件读宿主的真实前台状态：在前台就退出；在后台就请求拉起，然后**回读确认**，
没到前台就继续重试。

### 为什么需要「回读确认」

`/app/launch` 返回 `OK` 只代表 Android 接受了这次启动请求，**窗口不一定已经可见**。
实测在 Android 11 上，从别的 App 拉起后台应用，第一次经常不生效，第二次才成功。
所以每次 launch 之后都回读 `app_foreground`，没到就再来一次（默认最多 3 次）。
宁可多试两次，不要静默失败。

---

## 安装

### 方式一：从 GitHub 直接装（推荐）

在 DSH 里装 bundle，`target` 直接给仓库地址：

```text
plugin_manager
  action: install_bundle
  target: github:qpwoeirutyqp/dsh-foreground-return
```

或者用 git 地址：

```text
plugin_manager
  action: install_bundle
  target: https://github.com/qpwoeirutyqp/dsh-foreground-return.git
```

装好后插件立刻 active，不用重启 dsh。

### 方式二：本地目录

先把仓库克隆下来：

```bash
git clone https://github.com/qpwoeirutyqp/dsh-foreground-return.git
```

然后把**绝对路径**交给 `install_bundle`：

```text
plugin_manager
  action: install_bundle
  target: /absolute/path/to/dsh-foreground-return
```

### 方式三：手动改 profile

把包加进 profile 的 `package.json` 依赖，再列进 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "dsh-foreground-return": "github:qpwoeirutyqp/dsh-foreground-return"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-foreground-return"]
    }
  }
}
```

### 环境要求

- DSH 0.2.2 及以上
- DSHA Android 客户端，桥协议 3（`/app/device`、`/app/launch` 可用）
- 插件跑在 DSH 宿主进程里，读 `/root/.dsh/.bridge_token` 与 `.bridge_port` 调本机桥
- Node 20 及以上

---

## 配置

全部可选，写在 profile patch 里 `id: foreground-return` 的 `config` 下：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `packageName` | `dsh.android.client` | 要拉回的目标包 |
| `cooldownMs` | `8000` | 两次拉回的最小间隔，防多会话同时结束连着抢屏 |
| `minTurnMs` | `0` | 短于此时长的轮次不拉（闲聊不抢屏），`0` = 全拉 |
| `onlyWhenBackground` | `true` | 只在 App 处于后台时拉 |
| `onCompleted` | `true` | 正常完成 / 达到输出上限时触发 |
| `onAborted` | `false` | 停止 / 中断时触发 |
| `attempts` | `3` | launch 尝试次数（1–6） |
| `retryDelayMs` | `600` | 每次尝试之间的等待 |
| `verbose` | `false` | 打印每次判定日志 |

例：

```yaml
- id: foreground-return
  config:
    minTurnMs: 3000      # 三秒以内的轮次（问一句话就答完）不抢屏
    onAborted: true      # 我按了停止，也想让它切回来
    verbose: true
```

---

## 手动演练

不用等真任务跑完：

```bash
curl -s http://127.0.0.1:3080/__dsha_foreground_return
```

`report` 是结构化事实，能直接看出这一轮到底发生了什么：

```json
{
  "attempted": true,
  "launched": true,
  "foregroundBefore": false,
  "foregroundAfter": true,
  "tries": 1,
  "reason": "foreground"
}
```

`reason` 取值：

| 值 | 含义 |
|---|---|
| `already-foreground` | 本来就在前台，没动 |
| `foreground` | 成功拉回前台 |
| `still-background` | 试过上限次数，仍在后台（多半是系统省电策略拦截） |
| `unverified` | 前台状态读不出来，已尽力 |
| `bridge-unavailable` | 桥 token / 端口不可用 |
| `launch-failed` | 桥拒绝了 launch 请求 |

---

## 实现要点

几个刻意保留的设计，都是踩过坑的：

**不写模块级 `inject`。** 模块级 `inject` 是硬依赖，某个服务缺失会让 entry 永远 pending，
dsh 判定入口没激活就可能把整棵插件树拖挂，Web 直接打不开。这里只用 `ctx.on` / `ctx.get`，
拿不到服务就静默降级。

**只认真正属于本进程的根 agent。** 历史回放、被替换的 agent、子 Agent 的 turn 结束都不能触发——
否则子任务一结束就把手机抢走，很难用。

**凭据只进请求头。** token 走 `X-Token`，不拼 URL、不进命令行；桥端口每次现读、不缓存、
不回退固定端口（同机可能有另一个 DSHA 安装，猜端口等于把 token 送给别人）。

**一个异常都不许冒出去。** 这是「顺手提醒」级别的功能，绝不能影响 Agent 跑任务。
所有 IO 与解析全部包在 `try/catch` 里。

---

## 已知限制

- vivo / 部分国产 ROM 的深度省电策略可能拒绝后台拉起，会如实返回 `still-background`。
  把 DSHA 加进后台高耗电白名单即可。
- 只处理 turn 结束。如果你的任务需要中途提醒，那是另一个功能（通知栏胶囊已经在别处做了）。

---

## License

MIT
