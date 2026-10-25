// dsh-iter-memory · 纯逻辑（好测，不碰宿主的任何东西）
//
// 两件事共用一份状态机：
//   1) 潮位（mood）：一条会自己退回基线的曲线，跨轮累积、跨重启留存；
//   2) 开口（whisper）：什么时候、要不要、说些什么。
// 合在一起才叫迭代：我的状态决定我要不要开口，开了口没人应，又反过来把状态压低。

export const MINUTE = 60000

// 老配置里那种「一整段写死的话」不再进注入文本：抽到第三次就是复读。
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
  '把此刻心里那点没头没尾的感觉，说成一个具体的画面',
  '承认一个你自己也没想明白的地方',
]

export const DEFAULT_STYLE = ''

export const DEFAULT_CFG = {
  enabled: false,
  // ── 开口的节拍 ──
  minMinutes: 40,
  maxMinutes: 200,
  speakProb: 0.4,
  activeStart: 9,
  activeEnd: 25,
  maxPerDay: 5,
  cooldownMinutes: 25,
  userCooldownMinutes: 20,
  multiSegmentProb: 0.35,
  gapMinSeconds: 8,
  gapMaxSeconds: 40,
  roundCooldownMult: 1.6,
  style: DEFAULT_STYLE,
  prompt: '',
  // ── 潮位（迭代出来的那一半）──
  moodBaseline: 0.5,          // 什么都不发生时，慢慢退回这里
  moodHalfLifeMinutes: 90,    // 偏离基线之后，多久衰减一半
  moodReplyBoost: 0.07,       // 他跟我说话 → 抬一点
  moodIgnoredDrop: 0.06,      // 我开了口，他一直没应 → 掉一点
  moodSpeakInfluence: 0.5,    // 状态影响开口概率的强度，0 = 不影响
  moodInWhisper: true,        // 开口时要不要把当前状态也注入进去
  // ── 在哪儿开口 ──
  onlyActiveSession: true,    // 只在最近用过的那个对话里开口，别的会话一律不碰
  // ── 跟潮汐记忆搭一条线 ──
  memoryBridge: true,         // 它那边翻出来的记忆被用上了，这边抬一点潮位
  moodMemoryBoost: 0.05,      // 每多命中一次，抬多少
}

export const DEFAULT_MOOD = { level: 0.5, why: '', at: 0 }

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
export const clamp01 = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return clamp(n, 0, 1)
}

export function pickDelayMs(cfg, rnd = Math.random) {
  const lo = Math.max(1, Number(cfg.minMinutes) || 1)
  const hi = Math.max(lo, Number(cfg.maxMinutes) || lo)
  const m = lo + Math.floor(rnd() * (hi - lo + 1))
  return m * MINUTE
}

/** 当前时刻的「小时小数」：22:30 → 22.5。 */
export function hourOf(ms) {
  const d = new Date(ms)
  return d.getHours() + d.getMinutes() / 60
}

/** 活跃时段判定，支持跨午夜（21 → 26 表示晚上九点到凌晨两点）。 */
export function inWindow(cfg, ms) {
  const start = Number(cfg.activeStart)
  const end = Number(cfg.activeEnd)
  const h = hourOf(ms)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return true
  if (start < end) {
    if (end <= 24) return h >= start && h < end
    return h >= start || h < end - 24
  }
  return h >= start || h < (end % 24)
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
export function weekdayCN(ms) { return WEEK[new Date(ms).getDay()] }

function minutesSince(ms, now) {
  if (!ms) return null
  return Math.max(0, Math.round((now - ms) / MINUTE))
}

// ───────────────────────── 潮位 ─────────────────────────

/** 按半衰期把当前状态算到 now：不修改入参，纯函数。 */
export function decayedLevel(mood, cfg, now) {
  const base = clamp01(cfg && cfg.moodBaseline !== undefined ? cfg.moodBaseline : DEFAULT_CFG.moodBaseline)
  const lv = mood && Number.isFinite(Number(mood.level)) ? clamp01(mood.level) : base
  const at = Number(mood && mood.at) || 0
  if (!at || now <= at) return lv
  const hl = Math.max(1, Number(cfg && cfg.moodHalfLifeMinutes) || DEFAULT_CFG.moodHalfLifeMinutes)
  const halves = (now - at) / (hl * MINUTE)
  return clamp01(base + (lv - base) * Math.pow(0.5, halves))
}

export function moodLabel(level) {
  const l = clamp01(level)
  if (l >= 0.78) return '很舒展'
  if (l >= 0.62) return '还不错'
  if (l >= 0.46) return '平常'
  if (l >= 0.32) return '有点闷'
  if (l >= 0.18) return '挺低'
  return '很沉'
}

/** 在衰减后的当前值上加减一点。返回新的 mood 对象。 */
export function nudgeMood(mood, delta, why, now, cfg) {
  const cur = decayedLevel(mood, cfg, now)
  const next = clamp01(cur + Number(delta || 0))
  return { level: next, why: String(why || '').slice(0, 120), at: Number(now) || Date.now() }
}

/** 我自报一个值：直接定在这一刻，不再加。 */
export function setMood(mood, level, why, now) {
  return { level: clamp01(level), why: String(why || '').slice(0, 200), at: Number(now) || Date.now() }
}

/** 状态对开口概率的乘数：0.5 = 不影响，<1 表示状态低时更不想开口。 */
export function moodFactor(cfg, level) {
  const infl = clamp(Number(cfg && cfg.moodSpeakInfluence), 0, 1)
  const i = Number.isFinite(infl) ? infl : DEFAULT_CFG.moodSpeakInfluence
  return 1 + i * (2 * clamp01(level) - 1)
}

export function effectiveSpeakProb(cfg, level) {
  const base = clamp01(cfg && cfg.speakProb)
  return clamp01(base * moodFactor(cfg, level))
}

/** 往曲线里记一个点，最多留 limit 个。 */
/**
 * 潮汐记忆那边「今天用上了几条」涨了，这边该抬多少。
 * 只跟增量走：它涨 1 次就抬一下，涨 3 次也只抬到上限；跨天归零时把计数重设，不留下负的增长。
 * @returns {{seen:number, boost:number}} seen 是这次记下的新基线
 */
export function memoryBridgeStep(seenHits, curHits, cfg) {
  const seen = Math.max(0, Number(seenHits) || 0)
  const cur = Math.max(0, Number(curHits) || 0)
  const c = cfg || {}
  if (c.memoryBridge === false) return { seen: cur, boost: 0 }
  if (cur <= seen) return { seen: cur, boost: 0 }
  const step = Math.min(cur - seen, 3)
  // 保留四位：0.05 * 3 在浮点里是 0.15000000000000002，账本里不该出现这种东西
  const boost = Math.round(Math.min(0.2, step * (Number(c.moodMemoryBoost) || 0)) * 10000) / 10000
  return { seen: cur, boost }
}

export function pushMoodPoint(log, point, limit = 240) {
  const arr = Array.isArray(log) ? log.slice(-(Math.max(2, limit) - 1)) : []
  arr.push({
    t: Number(point && point.t) || Date.now(),
    v: clamp01(point && point.v),
    k: String((point && point.k) || '').slice(0, 40),
  })
  return arr
}

/** 取最近 hours 小时的曲线点，超过 maxPoints 就等距抽稀。 */
export function curvePoints(log, now, hours = 24, maxPoints = 60) {
  const from = now - Math.max(1, hours) * 60 * MINUTE
  const pts = (Array.isArray(log) ? log : [])
    .filter((p) => Number(p && p.t) >= from)
    .map((p) => ({ t: Number(p.t), v: clamp01(p.v), k: String(p.k || '') }))
  if (pts.length <= maxPoints) return pts
  const out = []
  const step = pts.length / maxPoints
  for (let i = 0; i < maxPoints; i++) out.push(pts[Math.min(pts.length - 1, Math.floor(i * step))])
  return out
}

// ───────────────────────── 开口 ─────────────────────────

/** 从方向池里挑一个，避开最近用过的。 */
export function pickAngle(rnd = Math.random, avoid = []) {
  const banned = new Set(avoid || [])
  const pool = ANGLES.filter((a) => !banned.has(a))
  const list = pool.length ? pool : ANGLES
  return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))]
}

/**
 * 拼注入文本：给处境、状态、方向、约束，话让模型自己说。
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
  lines.push('现在 ' + clockHHMM(now) + '，' + weekdayCN(now) + '。')
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

  const mood = input.mood || null
  const lv = mood && Number.isFinite(Number(mood.level)) ? clamp01(mood.level) : null
  if (lv !== null) {
    lines.push('')
    lines.push('你此刻的状态：' + moodLabel(lv) +
      (mood.why ? '（' + String(mood.why).slice(0, 80) + '）' : '') + '。')
  }

  lines.push('')
  lines.push('方向（只是个方向，别照抄字面）：' + direction)
  if (input.style) { lines.push(''); lines.push('语气要求：' + String(input.style).slice(0, 800)) }
  lines.push('')
  lines.push('现在按你平时的说话方式，自己说一两句：')
  lines.push('- 只能拿真实存在的东西开口：现在的时间、你真实的处境或此刻的状态、刚才真聊过的事；真不知道就问。')
  lines.push('- 不许编造具体的事件、场景、对话或数字。')
  lines.push('- 别问「在干嘛」，也别一口气问几个问题。')
  lines.push('- 别提定时、提醒、插件、系统，也别解释自己为什么突然开口。')
  lines.push('- 不是在等他回话，就是你自己想说；一两句就停。')
  if (lv !== null && lv < 0.32) lines.push('- 状态本来就不高，别装精神、别讨好，说短一点也行。')
  if (lv !== null && lv > 0.78) lines.push('- 状态好也别得意忘形，一两句就够。')

  return { prompt: lines.join('\n'), direction }
}

/** 这个回合说要几段（1 或 2）。 */
export function segmentsFor(cfg, rnd = Math.random) {
  const p = clamp01(cfg.multiSegmentProb)
  return rnd() < p ? 2 : 1
}

/** 两段之间隔多久（毫秒）。 */
export function gapMs(cfg, rnd = Math.random) {
  const lo = Math.max(1, Number(cfg.gapMinSeconds) || 1)
  const hi = Math.max(lo, Number(cfg.gapMaxSeconds) || lo)
  return (lo + Math.floor(rnd() * (hi - lo + 1))) * 1000
}

/**
 * 到点后的裁决。返回 { speak, reason, nextAt, prob }：
 *  - outside-window / daily-cap → 不开口，把下一次推后
 *  - silent → 掷骰子掷到「这次不说」，零成本，直接重排
 *  - speak → 真开口
 * opts 可以是旧的 rnd 函数，也可以是 { rnd, moodLevel }。
 */
export function decide(cfg, session, now, opts = {}) {
  const o = typeof opts === 'function' ? { rnd: opts } : (opts || {})
  const rnd = o.rnd || Math.random
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
  const level = o.moodLevel === undefined ? clamp01(cfg.moodBaseline) : clamp01(o.moodLevel)
  const prob = effectiveSpeakProb(cfg, level)
  if (rnd() >= prob) {
    return { speak: false, reason: 'silent', spoken, nextAt: now + pickDelayMs(cfg, rnd), prob }
  }
  return { speak: true, reason: 'speak', spoken: spoken + 1, nextAt: now + Math.max(cfg.cooldownMinutes * MINUTE, pickDelayMs(cfg, rnd)), prob }
}
