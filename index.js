/**
 * dsh-foreground-return —— 一轮对话在后台跑完之后，把 DSHA 强制拉回前台。
 *
 * 要解决的问题：DSHA 在后台（刷别的 App、看视频、锁屏），Agent 继续跑；
 * 跑完了用户根本不知道，得自己想起切回来。这个插件补上最后一环。
 *
 * 几条刻意保留下来的设计：
 *
 * 1) 不写模块级 inject。模块级 inject 是硬依赖，某个服务缺失会让 entry 永远
 *    pending，dsh 判定入口没激活就可能把整棵插件树拖挂，Web 直接打不开。
 *    这里只用 ctx.on / ctx.get，拿不到服务就静默降级。
 *
 * 2) 先看是不是真的在后台。App 已经在前台时（用户正看着结果）再 launch 只会
 *    把正在滚动的对话重新拉一次，属于打扰。用桥的 /app/device 读
 *    app_foreground 作为唯一判据，不猜。
 *
 * 3) launch 返回 OK 不等于到了前台。实测 Android 11 上把后台应用从另一个 App
 *    拉到前台，startActivity 会被接受但窗口可能要过一会儿才真正可见，甚至
 *    第一次不生效。所以 launch 之后要回读 app_foreground，没到就再来一次，
 *    次数有上限（默认 3 次）。宁可多试两次，不要静默失败。
 *
 * 4) 只认真正属于本进程的根 agent。历史回放、被替换的 agent、子 Agent 的 turn
 *    结束都不能触发——否则子任务一结束就把手机抢走，很难用。
 *
 * 5) 一个异常都不许冒出去。这是"顺手提醒"级别的功能，绝不能影响 Agent 跑任务。
 *    所有 IO 与解析都包在 try/catch 里。
 */
import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import bridgePort from './bridge-port.cjs'
import { currentForegroundPackage, matchPackages } from './foreground-package.js'

export const name = 'dsh-foreground-return'

/** 桥 token 只读不写、不缓存、不落盘，用完即弃。 */
const TOKEN_PATH = '/root/.dsh/.bridge_token'

/** 单次桥请求超时：桥在本机，1.5 秒都不该等。 */
const TIMEOUT_MS = 1500

/** 手动演练端点，只允许本机回环调用。 */
export const TEST_PATH = '/__dsha_foreground_return'

/** 视为"任务正常收尾"的结束原因。 */
const DONE_REASONS = new Set(['completed', 'max-tokens'])

/** 视为"被用户停掉或被打断"的结束原因。 */
const ABORT_REASONS = new Set(['aborted', 'interrupted'])

export const Config = z.object({
  enabled: z.boolean().default(true),
  packageName: z.string().default('dsh.android.client'),
  /** 同一轮结束后短时间内不重复拉，避免多会话同时结束连着抢屏。 */
  cooldownMs: z.natural().default(8000),
  /** 短于这个时长的轮次不拉（例如问一句就答完的闲聊），0 表示全都拉。 */
  minTurnMs: z.natural().default(0),
  /** 只在 App 处于后台时拉；关掉就变成无条件拉。 */
  onlyWhenBackground: z.boolean().default(true),
  /** 触发原因：任务正常完成 / 达到输出上限。 */
  onCompleted: z.boolean().default(true),
  /** 触发原因：用户主动停止或被中断。默认不抢屏。 */
  onAborted: z.boolean().default(false),
  /** launch 后回读仍不在前台时最多试几次（1~6）。 */
  attempts: z.natural().min(1).max(6).default(3),
  retryDelayMs: z.natural().default(600),
  /** 每次判定都打日志；默认只在真正拉回时打一行。 */
  verbose: z.boolean().default(false),
  /**
   * 白名单：只有这些应用在前台时才抢屏。
   *
   * 空数组 = 白名单关闭（任何应用在前台都拉），保持旧行为。
   * 填入后支持精确包名与尾部通配，例如 ["com.tencent.mm", "com.tencent.*"]。
   * 典型用法：只在刷微信/看视频时把手机抢回来，但你在写文档、开会、录音时不要动你的屏。
   *
   * 判据是「当前前台是哪个应用」，靠 dumpsys 读，需要 Shizuku / ADB / root 任一通道；
   * 读不出来时按 allowWhenUnknown 决定，默认放行（宁可拉一次，也不要静默失效）。
   */
  allowForegroundPackages: z.array(z.string()).default([]),
  /** 前台包名读不出来（无 shell 通道）时是否仍按白名单放行。 */
  allowWhenUnknown: z.boolean().default(true),
  /** 反向名单：这些应用在前台时永不抢屏，优先级高于白名单。 */
  denyForegroundPackages: z.array(z.string()).default([])
})

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 桥鉴权头。token 只进请求头，绝不拼进 URL 或命令行。 */
async function bridgeHeaders() {
  const token = (await readFile(TOKEN_PATH, 'utf8')).trim()
  if (!token) throw Object.assign(Error('bridge token empty'), { code: 'BRIDGE_UNAVAILABLE' })
  return { 'X-Token': token }
}

async function bridgeGet(path) {
  const port = bridgePort()
  const headers = await bridgeHeaders()
  const response = await fetch('http://127.0.0.1:' + port + path, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const payload = await response.json()
  const result = typeof payload?.result === 'string' ? payload.result : ''
  if (!response.ok || result === '') throw Object.assign(Error('bridge rejected'), { code: 'BRIDGE_REJECTED' })
  return result
}

/** 读宿主真实前台状态。返回 undefined 表示现在问不出来（不是"在前台"）。 */
async function foregroundState() {
  try {
    const result = await bridgeGet('/app/device')
    const match = /app_foreground=(true|false)/.exec(result)
    return match ? match[1] === 'true' : undefined
  } catch {
    return undefined
  }
}

/** 请求宿主把目标包提到前台；true 只代表 Android 接受了这次启动。 */
async function requestLaunch(packageName) {
  const result = await bridgeGet('/app/launch?pkg=' + encodeURIComponent(packageName))
  // 旧版 App 不认识 pkg / 包名不存在 / 被策略拦下时回错误码，不能当成成功。
  return !result.startsWith('[') && !result.startsWith('ERROR') && !result.startsWith('FORBIDDEN')
}

/**
 * 拉回前台的完整动作：判后台 → 查白名单 → launch → 回读 → 没到就重试。
 * 返回结构化结果，端点和日志共用同一份事实。
 */
export async function bringToFront(options) {
  const report = {
    attempted: false, launched: false,
    foregroundBefore: undefined, foregroundAfter: undefined,
    foregroundPackage: undefined, gate: '',
    tries: 0, reason: ''
  }
  report.foregroundBefore = await foregroundState()

  if (options.onlyWhenBackground && report.foregroundBefore === true) {
    report.reason = 'already-foreground'
    return report
  }

  // 白名单判定：只有确实在后台时才需要知道"现在是哪个应用"。
  const gate = await foregroundGate(options)
  report.gate = gate.verdict
  report.foregroundPackage = gate.packageName
  if (gate.verdict === 'denied') {
    report.reason = gate.reason
    return report
  }

  report.attempted = true
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    report.tries = attempt
    try {
      if (await requestLaunch(options.packageName)) report.launched = true
    } catch (error) {
      report.reason = error?.code === 'BRIDGE_UNAVAILABLE' || error?.code === 'BRIDGE_PORT_UNAVAILABLE'
        ? 'bridge-unavailable' : 'launch-failed'
      return report
    }
    // startActivity 被接受不等于窗口已可见：等一小会儿再回读真实前台状态。
    await sleep(options.retryDelayMs)
    const now = await foregroundState()
    report.foregroundAfter = now
    if (now === true) { report.reason = 'foreground'; return report }
    // 问不出来时不能判定失败，交给下一次尝试；最后一次仍未知就当作已尽力。
    if (now === undefined && attempt === options.attempts) { report.reason = 'unverified'; return report }
  }
  report.reason = report.foregroundAfter === false ? 'still-background' : 'unverified'
  return report
}

/**
 * 前台应用白/黑名单判定。
 *
 * 三个结论：
 *   allow   — 放行（没配白名单 / 命中白名单 / 读不出来但 allowWhenUnknown）
 *   denied  — 不抢屏，reason 说明是命中黑名单还是不在白名单
 * 黑名单优先级高于白名单：同一个人在写文档、开录音时，绝不能被抢屏。
 */
export async function foregroundGate(options) {
  const allow = Array.isArray(options.allowForegroundPackages) ? options.allowForegroundPackages : []
  const deny = Array.isArray(options.denyForegroundPackages) ? options.denyForegroundPackages : []
  const hasAllow = allow.length > 0
  const hasDeny = deny.length > 0
  if (!hasAllow && !hasDeny) return { verdict: 'allow', packageName: undefined, reason: '' }

  const packageName = await currentForegroundPackage({ shellPath: options.shellPath })
  if (packageName === undefined) {
    // 读不出前台应用（没开 Shizuku/ADB/root）。黑名单此时无从判断，只能退回放行；
    // 白名单则按配置决定，默认放行——宁可拉一次，也不要静默失效。
    return options.allowWhenUnknown === false
      ? { verdict: 'denied', packageName: undefined, reason: 'whitelist-unknown' }
      : { verdict: 'allow', packageName: undefined, reason: '' }
  }
  if (matchPackages(deny, packageName) === true) {
    return { verdict: 'denied', packageName, reason: 'blacklisted' }
  }
  if (hasAllow && matchPackages(allow, packageName) !== true) {
    return { verdict: 'denied', packageName, reason: 'not-whitelisted' }
  }
  return { verdict: 'allow', packageName, reason: '' }
}

/** 把一条字符串列表收敛成干净的包名规则；非数组、非字符串、空串全部丢掉。 */
function packageRules(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(rule => typeof rule === 'string')
    .map(rule => rule.trim())
    .filter(rule => rule !== '')
}

/** 把 patch 的 config 收敛成一份已校验的运行时选项。 */
export function normalizeConfig(config) {
  return {
    enabled: config?.enabled !== false,
    packageName: typeof config?.packageName === 'string' && config.packageName.trim() !== ''
      ? config.packageName.trim() : 'dsh.android.client',
    cooldownMs: Number.isSafeInteger(config?.cooldownMs) && config.cooldownMs >= 0 ? config.cooldownMs : 8000,
    minTurnMs: Number.isSafeInteger(config?.minTurnMs) && config.minTurnMs >= 0 ? config.minTurnMs : 0,
    onlyWhenBackground: config?.onlyWhenBackground !== false,
    onCompleted: config?.onCompleted !== false,
    onAborted: config?.onAborted === true,
    attempts: Number.isSafeInteger(config?.attempts) ? Math.min(6, Math.max(1, config.attempts)) : 3,
    retryDelayMs: Number.isSafeInteger(config?.retryDelayMs) && config.retryDelayMs >= 0 ? config.retryDelayMs : 600,
    verbose: config?.verbose === true,
    allowForegroundPackages: packageRules(config?.allowForegroundPackages),
    allowWhenUnknown: config?.allowWhenUnknown !== false,
    denyForegroundPackages: packageRules(config?.denyForegroundPackages),
    /** 仅供测试注入别的执行器；不写就自动挑 adb-shell 或 python3 退路。 */
    shellPath: typeof config?.shellPath === 'string' && config.shellPath.trim() !== ''
      ? config.shellPath.trim() : undefined
  }
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)

  let lastAt = 0
  let running = false
  let disposed = false
  /** sessionId → 本轮开始时间；只用于 minTurnMs 过滤，不参与归属判定。 */
  const startedAt = new Map()

  const log = (...args) => {
    if (options.verbose) console.log('[foreground-return]', ...args)
  }

  function roots() {
    try {
      const agents = ctx.get('agents')
      return typeof agents?.roots === 'function' ? agents.roots() : []
    } catch {
      return []
    }
  }

  /** 真正执行一次拉回，带互斥与冷却，绝不并发抢屏。 */
  async function runOnce(source) {
    if (running || disposed) return undefined
    const now = Date.now()
    if (options.cooldownMs > 0 && now - lastAt < options.cooldownMs) {
      log('skip: cooldown', source)
      return undefined
    }
    running = true
    lastAt = now
    try {
      const report = await bringToFront(options)
      // 只在真的做了动作或出现异常时留痕，正常"已在前台"不刷日志。
      if (report.reason !== 'already-foreground') {
        console.log('[foreground-return]', source, JSON.stringify(report))
      }
      return report
    } catch {
      return undefined
    } finally {
      running = false
    }
  }

  /** 这一轮的结束原因是否值得抢屏。 */
  function wanted(reason) {
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
    if (options.onCompleted && DONE_REASONS.has(kind)) return true
    if (options.onAborted && ABORT_REASONS.has(kind)) return true
    return false
  }

  const onEvent = (session, event, emittingAgent) => {
    try {
      if (disposed || !options.enabled) return
      const id = session?.id
      if (typeof id !== 'string' || id === '') return
      const type = event?.type
      if (type !== 'turn/start' && type !== 'turn/end') return

      const agent = ctx.get('agents')?.get?.(id)
      // 只有当前仍然挂在这个 session 上的 agent 才算直播；换过的对象一律不认。
      if (!agent || agent.session !== session) return
      if (emittingAgent !== undefined && emittingAgent !== agent) return
      // 子 Agent / 非根 Agent 的轮次不抢屏：子任务批量结束会把手机抢走。
      if (!roots().includes(agent)) return

      if (type === 'turn/start') {
        startedAt.set(id, Date.now())
        return
      }

      const turn = event?.data?.turn
      const since = startedAt.get(id)
      startedAt.delete(id)
      if (options.minTurnMs > 0 && Number.isSafeInteger(since) && Date.now() - since < options.minTurnMs) {
        log('skip: turn too short', id, turn)
        return
      }
      if (!wanted(event?.data?.reason)) return
      void runOnce('turn/end:' + String(turn ?? '?'))
    } catch {
      /* 通知功能不允许影响 Agent。 */
    }
  }

  ctx.on('session/event', onEvent)

  // 手动演练端点：验证"任务完成 → 回到前台"这条链路，不用等真任务跑完。
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: TEST_PATH,
      handler: async (request, response) => {
        const send = (status, value) => {
          try {
            response.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store'
            })
            response.end(JSON.stringify(value))
          } catch {}
        }
        // 只接受本机回环调用。这个端点唯一的后果是把 App 提到前台、不返回任何
        // 宿主数据，所以不要求网页会话身份；把唯一动作限制在回环来源就够了。
        const remote = request.socket?.remoteAddress ?? ''
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return send(403, { ok: false, error: 'REMOTE' })
        if (request.method !== 'GET' && request.method !== 'POST') return send(405, { ok: false, error: 'METHOD' })
        try {
          const report = await bringToFront({ ...options, onlyWhenBackground: false })
          send(200, { ok: true, enabled: options.enabled, packageName: options.packageName, report })
        } catch (error) {
          send(500, { ok: false, error: typeof error?.code === 'string' ? error.code : 'FAILED' })
        }
      }
    }), 'dsh-foreground-return: manual test route')
  })

  ctx.on('dispose', () => {
    disposed = true
    startedAt.clear()
  })
}
