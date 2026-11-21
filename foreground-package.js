/**
 * 读当前前台应用的包名。
 *
 * 桥没有这个端点（/app/device 只给 app_foreground 布尔值，问不出"是哪个应用"），
 * 所以走设备 shell 的 dumpsys。这条路要 Shizuku / ADB / root 任一通道可用；
 * 通道不通时如实返回 undefined，让调用方自己决定降级策略，不猜。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** dumpsys 一次约 1.5 秒，给足余量但不能无限等。 */
const DUMPSYS_TIMEOUT_MS = 8000

/** 包装脚本不存在时的退路，与桥文档给的一致。 */
const FALLBACK = { command: 'python3', args: ['/root/.dsh/adb-shell.py'] }

/**
 * 从 dumpsys 输出里取前台包名。
 *
 * 兼容两种行：
 *   mResumedActivity: ActivityRecord{... u0 com.foo/.MainActivity t1720 d0}
 *   mFocusedApp=ActivityRecord{... u0 com.foo/.MainActivity t1720 d0}
 * 优先 mResumedActivity；拿不到再退到 mFocusedApp。
 */
export function parseForegroundPackage(output) {
  if (typeof output !== 'string' || output === '') return undefined
  for (const key of ['mResumedActivity', 'mFocusedApp']) {
    const line = output.split('\n').find(text => text.includes(key))
    if (line === undefined) continue
    // ActivityRecord 里的 "u0 pkg/activity"：包名至少含一个点，避免把 u0 之类当成包名。
    const match = /\su\d+\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\//.exec(line)
    if (match) return match[1]
    // 个别 ROM 的格式不带 u0，退一步只认带点的包名。
    const loose = /([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/[A-Za-z0-9_.$]+/.exec(line)
    if (loose) return loose[1]
  }
  return undefined
}

/**
 * 查询当前前台包名。拿不到就是 undefined——不返回空串、不返回目标包当默认值。
 * @param {{shellPath?: string}} options - shellPath 可换成别的执行器
 */
export async function currentForegroundPackage(options = {}) {
  const attempts = []
  if (typeof options.shellPath === 'string' && options.shellPath !== '') {
    attempts.push({ command: options.shellPath, args: ['dumpsys activity activities'] })
  } else {
    attempts.push({ command: '/root/dsh-bin/adb-shell', args: ['dumpsys activity activities'] })
    attempts.push({ command: FALLBACK.command, args: [...FALLBACK.args, 'dumpsys activity activities'] })
  }
  for (const attempt of attempts) {
    try {
      const { stdout } = await run(attempt.command, attempt.args, {
        timeout: DUMPSYS_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      })
      const name = parseForegroundPackage(stdout)
      if (name !== undefined && name !== '') return name
    } catch {
      // 通道未授权、命令被策略拦下、超时：都换下一种执行器再试。
    }
  }
  return undefined
}

/**
 * 包名匹配：支持精确名与尾部通配（`com.tencent.*`）。
 * 空规则表返回 defaultResult，让"没配白名单"和"白名单没命中"能区分开。
 */
export function matchPackages(rules, packageName) {
  if (!Array.isArray(rules) || rules.length === 0) return undefined
  if (typeof packageName !== 'string' || packageName === '') return false
  for (const rule of rules) {
    if (typeof rule !== 'string' || rule === '') continue
    const pattern = rule.trim()
    if (pattern === '') continue
    if (pattern.endsWith('*')) {
      if (packageName.startsWith(pattern.slice(0, -1))) return true
      continue
    }
    if (packageName === pattern) return true
  }
  return false
}
