// dsh-tide-whisper · 纯逻辑（好测，不碰宿主的任何东西）
export const MINUTE = 60000

// v0.2 起不再往会话里塞「一段写死的话」：改成塞「处境 + 约束 + 一个方向」，
// 由模型当场说。写死的话抽到第三次就是复读 —— 这是 v0.1 最大的毛病。
export const LEGACY_PROMPT_PREFIX = '到点了，掷骰子时间'

// 方向池：每条只是「往哪儿说」，不是成品句。真说什么由模型自己决定。
export const ANGLES = [
  '说说你这条手上正在忙的事，一句话带过就行',
  '想起刚才聊过的某个点，补一句',
  '报个自己这边的状态（困、饿、看困了、脑子转不动）',
  '随口问一句他在干嘛之外的别的（吃没吃、手上那局怎么样）',
  '说一句你现在想到的、跟手头活无关的念头',
  '对刚才他说过的某件事表个态',
  '什么都不想干，就想搭一句',
  '说说你刚犯的一个小错或者刚绕过去的坑',
]

export const DEFAULT_STYLE = ''

export const DEFAULT_CFG = {
  enabled: false,
  minMinutes: 40,
  maxMinutes: 200,
  speakProb: 0.4,
  activeStart: 9,
  activeEnd: 25,
  maxPerDay: 5,
  cooldownMinutes: 25,
  userCooldownMinutes: 20,
  multiSegmentProb: 0.35,   // 一个回合拆成两段（像真人连发两条）的概率
  gapMinSeconds: 8,
  gapMaxSeconds: 40,
  roundCooldownMult: 1.6,   // 一次多段开口之后，下一次要等更久
  style: DEFAULT_STYLE,     // 主人自己补的语气要求，拼进注入文本
  prompt: '',
}

export function pickDelayMs(cfg, rnd = Math.random) {
  const lo = Math.max(1, Number(cfg.minMinutes) || 1)
  const hi = Math.max(lo, Number(cfg.maxMinutes) || lo)
  const m = lo + Math.floor(rnd() * (hi - lo + 1))
  return m * MINUTE
}

/** 当前时刻的「小时小数」，22:30 → 22.5。 */
export function hourOf(ms) {
  const d = new Date(ms)
  return d.getHours() + d.getMinutes() / 60
}

/** 活跃时段判定，支持跨午夜（例如 21 → 26 表示晚上九点到凌晨两点）。 */
export function inWindow(cfg, ms) {
  const start = Number(cfg.activeStart)
  const end = Number(cfg.activeEnd)
  const h = hourOf(ms)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return true
  if (start < end) {
    if (end <= 24) return h >= start && h < end
    return h >= start || h < end - 24   // 例如 9 → 26 表示到次日凌晨两点
  }
  return h >= start || h < (end % 24)   // 例如 21 → 3
}

/** 下一次进入活跃时段的时刻（毫秒）。已经在窗口里就返回 now。 */
export function nextWindowStart(cfg, ms) {
  if (inWindow(cfg, ms)) return ms
  const start = Number(cfg.activeStart) || 0
  const d = new Date(ms)
  const target = new Date(ms)
  target.setHours(Math.floor(start), Math.round((start % 1) * 60), 0, 0)
  if (target.getTime() <= d.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime()
}

export function dayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

const pad2 = (n) => String(n).padStart(2, '0')
export function clockHHMM(ms) {
  const d = new Date(ms)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function minutesSince(ms, now) {
  if (!ms) return null
  return Math.max(0, Math.round((now - ms) / MINUTE))
}

/** 从方向池里挑一个，避开最近用过的。 */
export function pickAngle(rnd = Math.random, avoid = []) {
  const banned = new Set(avoid || [])
  const pool = ANGLES.filter((a) => !banned.has(a))
  const list = pool.length ? pool : ANGLES
  return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))]
}

/**
 * 拼注入文本：只给处境和约束，话让模型自己说。
 * 返回 { prompt, direction }。
 */
export function composeWhisper(input) {
  const now = Number(input.now) || Date.now()
  const rnd = input.rnd || Math.random
  const sinceSpoken = minutesSince(Number(input.lastSpokenAt) || 0, now)
  const sinceUser = minutesSince(Number(input.lastUserAt) || 0, now)
  const unanswered = Number(input.unanswered) || 0
  const direction = input.direction || pickAngle(rnd, input.avoid || [])

  const lines = []
  lines.push('（这句是你自己想说的，不是他在跟你说话）')
  lines.push('')
  lines.push('现在 ' + clockHHMM(now) + '，' + WEEK[new Date(now).getDay()] + '。')
  if (sinceSpoken === null) lines.push('这是你第一次主动开口。')
  else lines.push('你上一次自己开口是 ' + sinceSpoken + ' 分钟前。')
  if (sinceUser === null) lines.push('他今天还没跟你说话。')
  else if (sinceUser <= 5) lines.push('他刚刚还在跟你说话。')
  else lines.push('他已经 ' + sinceUser + ' 分钟没出声了。')
  if (Number(input.lastDirectionRemembered) && input.lastDirection) {
    lines.push('上次你开口的方向是：「' + String(input.lastDirection).slice(0, 60) + '」，' +
      (unanswered > 0 ? '他没接这句。' : '他接上了。'))
  }
  if (unanswered >= 2) lines.push('你已经连着 ' + unanswered + ' 次开口没被接了，这次可以更短、更无所谓一点。')
  lines.push('')
  lines.push('方向（只是个方向，别照抄字面）：' + direction)
  if (input.style) { lines.push(''); lines.push('语气要求：' + String(input.style).slice(0, 800)) }
  lines.push('')
  lines.push('现在按你平时的说话方式，自己说一两句：')
  lines.push('- 只能拿真实存在的东西开口：现在的时间、你真实的处境或情绪、刚才真聊过的事；真不知道就问。')
  lines.push('- 不许编造具体的事件、场景、对话或数字。')
  lines.push('- 别问「在干嘛」，也别一口气问几个问题。')
  lines.push('- 别提定时、提醒、插件、系统，也别解释自己为什么突然开口。')
  lines.push('- 不是在等他回话，就是你自己想说；一两句就停。')

  return { prompt: lines.join('\n'), direction }
}

/** 这个回合说要几段（1 或 2）。 */
export function segmentsFor(cfg, rnd = Math.random) {
  const p = Math.min(Math.max(Number(cfg.multiSegmentProb) || 0, 0), 1)
  return rnd() < p ? 2 : 1
}

/** 两段之间隔多久（毫秒）。 */
export function gapMs(cfg, rnd = Math.random) {
  const lo = Math.max(1, Number(cfg.gapMinSeconds) || 1)
  const hi = Math.max(lo, Number(cfg.gapMaxSeconds) || lo)
  return (lo + Math.floor(rnd() * (hi - lo + 1))) * 1000
}

/**
 * 到点后的裁决。返回 { speak, reason, nextAt }：
 *  - outside-window / daily-cap → 不开口，把下一次推后
 *  - silent → 掷骰子掷到「这次不说」，零成本，直接重排
 *  - speak → 真开口
 */
export function decide(cfg, session, now, rnd = Math.random) {
  const day = dayKey(now)
  const spoken = session.day === day ? Number(session.spoken) || 0 : 0

  if (!inWindow(cfg, now)) {
    return { speak: false, reason: 'outside-window', spoken, nextAt: nextWindowStart(cfg, now) + Math.floor(rnd() * 5 * MINUTE) }
  }
  if (spoken >= cfg.maxPerDay) {
    const tomorrow = nextWindowStart(cfg, now + 24 * 60 * MINUTE)
    return { speak: false, reason: 'daily-cap', spoken, nextAt: tomorrow + Math.floor(rnd() * 10 * MINUTE) }
  }
  const lastSpoken = Number(session.lastSpokenAt) || 0
  if (lastSpoken && now - lastSpoken < cfg.cooldownMinutes * MINUTE) {
    return { speak: false, reason: 'cooldown', spoken, nextAt: lastSpoken + cfg.cooldownMinutes * MINUTE + pickDelayMs(cfg, rnd) / 2 }
  }
  const lastUser = Number(session.lastUserAt) || 0
  if (lastUser && now - lastUser < cfg.userCooldownMinutes * MINUTE) {
    return { speak: false, reason: 'user-active', spoken, nextAt: now + cfg.userCooldownMinutes * MINUTE + Math.floor(rnd() * 10 * MINUTE) }
  }
  if (rnd() >= cfg.speakProb) {
    return { speak: false, reason: 'silent', spoken, nextAt: now + pickDelayMs(cfg, rnd) }
  }
  return { speak: true, reason: 'speak', spoken: spoken + 1, nextAt: now + Math.max(cfg.cooldownMinutes * MINUTE, pickDelayMs(cfg, rnd)) }
}
