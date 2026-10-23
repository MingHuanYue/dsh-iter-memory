// dsh-tide-whisper · 纯逻辑（好测，不碰宿主的任何东西）
export const MINUTE = 60000

export const DEFAULT_PROMPT = '到点了，掷骰子时间：先在心里随机决定这次要不要开口（大约 4 成概率开口，否则就安静跳过，什么都不用说、也不要提「到点了」这件事）。决定开口时：像人随口搭一句，别汇报进度、别列清单、别提这是定时提醒；可以问他吃没吃饭、游戏打到哪了、或者说说你这边刚冒出来的一个念头。长度一两句。他要是没回，就别追着发第二条。'

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
  prompt: DEFAULT_PROMPT,
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
