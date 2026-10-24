// dsh-iter-memory · 宿主半边
//
// 迭代记忆 = 潮位（会自己退回基线的状态曲线）+ 开口（不定时自己说句话）。
// 两半共用一份会话状态：状态低就先忍着不说；说了没人应，状态再掉一点。
// 不开口的时候一声不响（零 token），这一点和「cron 每轮都唤醒」有本质区别。
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'iter-memory'
export const inject = ['agents', 'tools', 'webServer', 'timer']

import {
  MINUTE, DEFAULT_CFG, DEFAULT_MOOD, LEGACY_PROMPT_PREFIX,
  pickDelayMs, nextWindowStart, dayKey, decide, composeWhisper,
  segmentsFor, gapMs, pickAngle, clockHHMM,
  decayedLevel, moodLabel, nudgeMood, setMood, pushMoodPoint, curvePoints, clamp01,
} from './core.js'

const VERSION = '1.0.0'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'iter-memory')
const LEGACY_DIR = join(HOME, 'tide-whisper')
const CFG_FILE = join(DIR, 'config.json')
const STATE_FILE = join(DIR, 'state.json')
const LOG_FILE = join(DIR, 'log.jsonl')

function ensureDir() {
  try { mkdirSync(DIR, { recursive: true }) } catch { /* 已经有了 */ }
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch { return fallback }
}

function writeJson(file, value) {
  try {
    ensureDir()
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch { /* 磁盘写不动就算了，别把宿主弄挂 */ }
}

function num(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(n, lo), hi)
}

/** 老插件（潮声）的配置和状态原样搬过来：主人的 30~200 分钟、上限 10 不能静默丢。 */
function migrateLegacy() {
  try {
    if (existsSync(CFG_FILE)) return false
    const oldCfg = join(LEGACY_DIR, 'config.json')
    if (!existsSync(oldCfg)) return false
    ensureDir()
    copyFileSync(oldCfg, CFG_FILE)
    // 旧配置里没有潮位那几项，落盘时顺手补齐，别在文件里留半份
    try { writeJson(CFG_FILE, loadCfg()) } catch { /* 补不上也能跑 */ }
    const oldState = join(LEGACY_DIR, 'state.json')
    if (existsSync(oldState) && !existsSync(STATE_FILE)) copyFileSync(oldState, STATE_FILE)
    return true
  } catch { return false }
}

function loadCfg() {
  const raw = readJson(CFG_FILE, {}) || {}
  const cfg = { ...DEFAULT_CFG, ...raw }
  cfg.enabled = !!cfg.enabled
  cfg.minMinutes = num(cfg.minMinutes, 1, 1440, DEFAULT_CFG.minMinutes)
  cfg.maxMinutes = num(cfg.maxMinutes, cfg.minMinutes, 1440, Math.max(cfg.minMinutes, DEFAULT_CFG.maxMinutes))
  cfg.speakProb = num(cfg.speakProb, 0, 1, DEFAULT_CFG.speakProb)
  cfg.activeStart = num(cfg.activeStart, 0, 24, DEFAULT_CFG.activeStart)
  cfg.activeEnd = num(cfg.activeEnd, 0, 34, DEFAULT_CFG.activeEnd)
  cfg.maxPerDay = Math.round(num(cfg.maxPerDay, 0, 200, DEFAULT_CFG.maxPerDay))
  cfg.cooldownMinutes = num(cfg.cooldownMinutes, 0, 1440, DEFAULT_CFG.cooldownMinutes)
  cfg.userCooldownMinutes = num(cfg.userCooldownMinutes, 0, 1440, DEFAULT_CFG.userCooldownMinutes)
  cfg.multiSegmentProb = num(cfg.multiSegmentProb, 0, 1, DEFAULT_CFG.multiSegmentProb)
  cfg.gapMinSeconds = num(cfg.gapMinSeconds, 1, 600, DEFAULT_CFG.gapMinSeconds)
  cfg.gapMaxSeconds = num(cfg.gapMaxSeconds, cfg.gapMinSeconds, 900, Math.max(cfg.gapMinSeconds, DEFAULT_CFG.gapMaxSeconds))
  cfg.roundCooldownMult = num(cfg.roundCooldownMult, 1, 5, DEFAULT_CFG.roundCooldownMult)
  cfg.moodBaseline = num(cfg.moodBaseline, 0, 1, DEFAULT_CFG.moodBaseline)
  cfg.moodHalfLifeMinutes = num(cfg.moodHalfLifeMinutes, 1, 1440, DEFAULT_CFG.moodHalfLifeMinutes)
  cfg.moodReplyBoost = num(cfg.moodReplyBoost, 0, 0.5, DEFAULT_CFG.moodReplyBoost)
  cfg.moodIgnoredDrop = num(cfg.moodIgnoredDrop, 0, 0.5, DEFAULT_CFG.moodIgnoredDrop)
  cfg.moodSpeakInfluence = num(cfg.moodSpeakInfluence, 0, 1, DEFAULT_CFG.moodSpeakInfluence)
  cfg.moodInWhisper = cfg.moodInWhisper === undefined ? DEFAULT_CFG.moodInWhisper : !!cfg.moodInWhisper
  const legacyPrompt = typeof cfg.prompt === 'string' ? cfg.prompt : ''
  if (legacyPrompt && legacyPrompt.indexOf(LEGACY_PROMPT_PREFIX) === 0) cfg.prompt = ''
  else cfg.prompt = legacyPrompt.slice(0, 4000)
  cfg.style = String(cfg.style === undefined ? cfg.prompt : cfg.style || '').slice(0, 2000)
  return cfg
}

function saveCfg(patch) {
  const next = { ...loadCfg(), ...(patch || {}) }
  writeJson(CFG_FILE, next)
  return loadCfg()
}

function loadState() {
  const st = readJson(STATE_FILE, null) || { sessions: {} }
  if (!st.sessions || typeof st.sessions !== 'object') st.sessions = {}
  return st
}

function saveState(st) { writeJson(STATE_FILE, st) }

function appendLog(entry) {
  try {
    ensureDir()
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* 忽略 */ }
}

function tailLog(n) {
  try {
    if (!existsSync(LOG_FILE)) return []
    const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-Math.max(1, n))
    return lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
  } catch { return [] }
}

async function loadHostDefineTool() {
  const roots = []
  try {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    roots.push(join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh-tools'))
  } catch { /* 忽略 */ }
  try {
    const profiles = join(HOME, 'profiles')
    for (const p of ['desktop', 'web']) roots.push(join(profiles, p, 'node_modules', '@deepseek-ai', 'dsh-tools'))
  } catch { /* 忽略 */ }
  roots.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai', 'dsh-tools'))
  for (const root of roots) {
    try {
      const pkgFile = join(root, 'package.json')
      if (!existsSync(pkgFile)) continue
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const rel = (pkg.exports && (pkg.exports['.'] || pkg.exports)) || pkg.main
      const file = join(root, String(rel).replace(/^\.\//, ''))
      const mod = await import(pathToFileURL(file).href)
      const fn = mod.defineTool || (mod.default && mod.default.defineTool)
      if (typeof fn === 'function') return fn
    } catch { /* 换下一个 */ }
  }
  return null
}

function localDefineTool(spec) {
  const props = {}
  const required = []
  for (const [k, v] of Object.entries(spec.parameters || {})) {
    props[k] = { ...v }
    delete props[k].required
    if (v && v.required) required.push(k)
  }
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: props, required },
    output: spec.output,
    execute: spec.execute,
  }
}

const defineTool = (await loadHostDefineTool()) || localDefineTool

// ───────────────────────── 应用 ─────────────────────────

function sessionIdOf(session) {
  try {
    for (const k of ['id', 'sessionId', 'sid']) if (session && typeof session[k] === 'string' && session[k]) return session[k]
    if (session && session.info && typeof session.info.id === 'string') return session.info.id
  } catch { /* 拿不到就算 */ }
  return ''
}

const pad2 = (n) => String(n).padStart(2, '0')
const fmtTime = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }

export function apply(ctx) {
  ensureDir()
  const diag = (msg) => { try { ctx.logger?.debug?.('[iter-memory] ' + msg) } catch { /* 忽略 */ } }
  diag('启动 v' + VERSION)

  const migrated = migrateLegacy()
  if (migrated) {
    diag('已从潮声的旧目录迁移配置和状态')
    appendLog({ at: Date.now(), op: 'migrate', from: LEGACY_DIR })
  }

  const st = loadState()
  let lastUserAt = 0

  const freshSession = () => ({
    nextAt: 0, day: '', spoken: 0, lastSpokenAt: 0, lastReason: '', lastUserAt: 0,
    lastDirection: '', recentAngles: [], unanswered: 0, rounds: 0,
    mood: { ...DEFAULT_MOOD }, moodLog: [], pendingReplyAt: 0,
  })

  const stFor = (sid) => {
    if (!st.sessions[sid]) st.sessions[sid] = freshSession()
    const s = st.sessions[sid]
    if (!s.mood || typeof s.mood !== 'object') s.mood = { ...DEFAULT_MOOD }
    if (!Array.isArray(s.moodLog)) s.moodLog = []
    if (typeof s.pendingReplyAt !== 'number') s.pendingReplyAt = 0
    return s
  }

  const arm = (sid, now = Date.now()) => {
    const cfg = loadCfg()
    const s = stFor(sid)
    s.nextAt = Math.max(now + pickDelayMs(cfg), nextWindowStart(cfg, now))
    s.lastReason = 'armed'
    saveState(st)
    return s.nextAt
  }

  function recordMood(s, next, kind, now) {
    s.mood = next
    s.moodLog = pushMoodPoint(s.moodLog, { t: now, v: next.level, k: kind || '' })
  }

  function moodView(s, cfg, now) {
    const level = decayedLevel(s.mood, cfg, now)
    return { level, label: moodLabel(level), why: (s.mood && s.mood.why) || '', at: (s.mood && s.mood.at) || 0, baseline: cfg.moodBaseline }
  }

  async function deliver(sid, prompt, meta) {
    let sched = null
    try { sched = ctx.get('schedule') || ctx.schedule || null } catch { sched = null }
    if (!sched || typeof sched.create !== 'function') {
      appendLog({ at: Date.now(), sid, op: 'deliver-failed', reason: 'no-schedule-service' })
      return { ok: false, error: '宿主没有 schedule 服务，叫不醒' }
    }
    const m = meta || {}
    const text = String(prompt || '')
    try {
      await sched.create(sid, {
        title: m.title || '迭代记忆 · 自己说一句',
        prompt: text,
        after_seconds: Math.max(1, Number(m.after_seconds) || 1),
      })
      appendLog({ at: Date.now(), sid, op: 'deliver', seg: m.seg || 1, direction: m.direction || '', prompt: text.slice(0, 60) })
      return { ok: true }
    } catch (e) {
      appendLog({ at: Date.now(), sid, op: 'deliver-failed', reason: String(e && e.message) })
      return { ok: false, error: String(e && e.message) }
    }
  }

  /** 拼这一段的注入文本：处境 + 此刻的状态 + 方向 + 约束。 */
  function composeFor(s, cfg, opts) {
    const o = opts || {}
    const now = Date.now()
    return composeWhisper({
      now,
      lastSpokenAt: o.lastSpokenAt === undefined ? s.lastSpokenAt : o.lastSpokenAt,
      lastUserAt: s.lastUserAt,
      lastDirection: s.lastDirection,
      lastDirectionRemembered: !!s.lastDirection,
      unanswered: s.unanswered || 0,
      avoid: s.recentAngles || [],
      style: cfg.style,
      mood: cfg.moodInWhisper ? moodView(s, cfg, now) : null,
      rnd: Math.random,
    })
  }

  async function fire(sid) {
    const cfg = loadCfg()
    const now = Date.now()
    const s = stFor(sid)
    if (lastUserAt && (!s.lastUserAt || lastUserAt > s.lastUserAt)) s.lastUserAt = lastUserAt
    const level = decayedLevel(s.mood, cfg, now)
    const verdict = decide(cfg, s, now, { moodLevel: level })
    s.lastReason = verdict.reason
    if (s.day !== dayKey(now)) { s.day = dayKey(now); s.spoken = 0 }
    if (!verdict.speak) {
      s.nextAt = verdict.nextAt
      appendLog({ at: now, sid, op: 'skip', reason: verdict.reason })
      saveState(st)
      return
    }
    const prevSpokenAt = Number(s.lastSpokenAt) || 0
    const segs = segmentsFor(cfg)
    const mult = segs > 1 ? cfg.roundCooldownMult : 1
    const first = composeFor(s, cfg, { lastSpokenAt: prevSpokenAt })

    s.spoken = verdict.spoken
    s.lastSpokenAt = now
    s.lastReason = 'speak'
    s.nextAt = now + Math.max(cfg.cooldownMinutes * mult * MINUTE, pickDelayMs(cfg, Math.random) * mult)
    s.lastDirection = first.direction
    s.recentAngles = [first.direction].concat(s.recentAngles || []).slice(0, 3)
    s.unanswered = (Number(s.unanswered) || 0) + 1
    s.pendingReplyAt = now
    if (segs > 1) s.rounds = (Number(s.rounds) || 0) + 1
    saveState(st)

    await deliver(sid, first.prompt, {
      seg: 1, direction: first.direction,
      title: segs > 1 ? '迭代记忆 · 自己说一句（1/2）' : '迭代记忆 · 自己说一句',
    })

    if (segs > 1) {
      const gap = gapMs(cfg)
      const second = composeWhisper({
        now: Date.now() + gap,
        lastSpokenAt: now,
        lastUserAt: s.lastUserAt,
        lastDirection: s.lastDirection,
        lastDirectionRemembered: false,
        unanswered: 0,
        avoid: s.recentAngles || [],
        style: cfg.style,
        mood: cfg.moodInWhisper ? moodView(s, cfg, Date.now()) : null,
        direction: pickAngle(Math.random, s.recentAngles || []),
      })
      setTimeout(() => {
        deliver(sid, second.prompt, {
          seg: 2, direction: second.direction,
          title: '迭代记忆 · 自己说一句（2/2）',
        }).catch(() => { /* 宿主可能已经关了 */ })
      }, gap)
    }
  }

  function activeSessions() {
    const out = []
    try {
      for (const agent of ctx.agents.list() || []) {
        const sid = sessionIdOf(agent && agent.session)
        if (sid) out.push(sid)
      }
    } catch { /* 拿不到就当没有 */ }
    return out
  }

  function tick() {
    try {
      const cfg = loadCfg()
      if (!cfg.enabled) {
        // 关着的时候也要让状态慢慢退回基线，别一直冻在那里
        return
      }
      const sids = activeSessions()
      const now = Date.now()
      const grace = Math.max(10, Number(cfg.userCooldownMinutes) || 20) * MINUTE
      let dirty = false
      for (const sid of sids) {
        const s = stFor(sid)
        // 我开了口，他一直没应 → 掉一点，只掉一次
        if (s.pendingReplyAt && now - s.pendingReplyAt > grace && (!s.lastUserAt || s.lastUserAt < s.pendingReplyAt)) {
          recordMood(s, nudgeMood(s.mood, -cfg.moodIgnoredDrop, '你开了口，他一直没应', now, cfg), 'ignored', now)
          s.pendingReplyAt = 0
          appendLog({ at: now, sid, op: 'mood-down', reason: 'ignored' })
          dirty = true
        }
        if (!st.sessions[sid] || !st.sessions[sid].nextAt) {
          arm(sid, now)
          appendLog({ at: now, sid, op: 'arm', at2: st.sessions[sid].nextAt })
          continue
        }
        if (now >= Number(s.nextAt)) fire(sid)
      }
      if (dirty) saveState(st)
      const keys = Object.keys(st.sessions)
      if (keys.length > 30) {
        keys.sort((a, b) => (Number(st.sessions[b].nextAt) || 0) - (Number(st.sessions[a].nextAt) || 0))
        for (const k of keys.slice(30)) delete st.sessions[k]
        saveState(st)
      }
    } catch (e) { diag('tick 出错：' + (e && e.message)) }
  }

  try { ctx.timer.interval(tick, 15000) } catch { setTimeout(tick, 3000) }

  // ───────────── 工具（每个 agent 一份） ─────────────
  function statusView(sid) {
    const cfg = loadCfg()
    const now = Date.now()
    const s = stFor(sid)
    const mv = moodView(s, cfg, now)
    return {
      enabled: cfg.enabled,
      range: cfg.minMinutes + '~' + cfg.maxMinutes + ' 分钟',
      speakProb: cfg.speakProb,
      window: cfg.activeStart + ' → ' + cfg.activeEnd,
      maxPerDay: cfg.maxPerDay,
      spokenToday: s.day === dayKey(now) ? s.spoken : 0,
      nextAt: s.nextAt || 0,
      nextLabel: s.nextAt ? fmtTime(s.nextAt) + ' 前后' : '—',
      lastReason: s.lastReason || '',
      lastDirection: s.lastDirection || '',
      unanswered: Number(s.unanswered) || 0,
      mood: { level: Number(mv.level.toFixed(3)), label: mv.label, why: mv.why, baseline: mv.baseline },
    }
  }

  function makeTools(sid) {
    return [
      defineTool({
        name: 'iter_status',
        description: '看看迭代记忆现在的状态：开没开、下次大概什么时候开口、此刻的潮位是多少。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_a, v) {
            if (!v || v.ok === false) return [{ type: 'text', text: '✗ 看不到' }]
            const m = v.mood || {}
            return [{ type: 'text', text: (v.enabled ? '开着' : '关着') + ' · 潮位 ' + (m.label || '?') + ' ' + (m.level === undefined ? '' : m.level) + ' · 下次 ' + v.nextLabel + ' · 今天 ' + v.spokenToday + '/' + v.maxPerDay }]
          },
        },
        async execute() { return { ok: true, ...statusView(sid) } },
      }),
      defineTool({
        name: 'iter_feel',
        description: '记一笔此刻的状态（0 = 很沉，0.5 = 平常，1 = 很舒展），写清为什么。这条会存下来、影响要不要主动开口，也会被下一次开口读到。',
        parameters: {
          level: { type: 'number', required: true, description: '0~1 的数，0.5 是平常。' },
          why: { type: 'string', description: '一句话原因，只说真实的原因。' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_a, v) {
            if (!v || v.ok === false) return [{ type: 'text', text: '✗ 没记上' }]
            return [{ type: 'text', text: '✓ 记下了：' + v.label + '（' + v.level + '）' }]
          },
        },
        async execute(args) {
          const cfg = loadCfg()
          const now = Date.now()
          const s = stFor(sid)
          const lv = clamp01(args && args.level)
          const why = String((args && args.why) || '').slice(0, 200)
          s.mood = setMood(s.mood, lv, why, now)
          s.moodLog = pushMoodPoint(s.moodLog, { t: now, v: lv, k: '自报' })
          s.pendingReplyAt = 0
          saveState(st)
          appendLog({ at: now, sid, op: 'mood-set', level: lv, why })
          return { ok: true, level: Number(lv.toFixed(3)), label: moodLabel(lv), why }
        },
      }),
      defineTool({
        name: 'iter_set',
        description: '调整迭代记忆的参数（只有给了的字段会变）。',
        parameters: {
          enabled: { type: 'boolean', description: '开/关。' },
          minMinutes: { type: 'number', description: '最短间隔（分钟）。' },
          maxMinutes: { type: 'number', description: '最长间隔（分钟）。' },
          speakProb: { type: 'number', description: '到点开口的概率 0~1。' },
          activeStart: { type: 'number', description: '几点之后才开口（24 小时制，可写 25 = 凌晨一点）。' },
          activeEnd: { type: 'number', description: '几点之后闭嘴。' },
          maxPerDay: { type: 'number', description: '一天最多主动开口几次。' },
          moodHalfLifeMinutes: { type: 'number', description: '状态偏离之后多久衰减一半（分钟）。' },
          moodSpeakInfluence: { type: 'number', description: '状态影响开口概率的强度 0~1。' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_a, v) { return [{ type: 'text', text: v && v.ok ? '✓ 已改' : '✗ 没改上' }] },
        },
        async execute(args) {
          const keys = ['enabled', 'minMinutes', 'maxMinutes', 'speakProb', 'activeStart', 'activeEnd', 'maxPerDay',
            'multiSegmentProb', 'cooldownMinutes', 'userCooldownMinutes', 'style',
            'moodBaseline', 'moodHalfLifeMinutes', 'moodReplyBoost', 'moodIgnoredDrop', 'moodSpeakInfluence', 'moodInWhisper']
          const patch = {}
          for (const k of keys) if (args && args[k] !== undefined) patch[k] = args[k]
          saveCfg(patch)
          if (patch.enabled) arm(sid)
          else if (patch.enabled === false) { stFor(sid).nextAt = 0; stFor(sid).lastReason = 'off'; saveState(st) }
          return { ok: true, ...statusView(sid) }
        },
      }),
      defineTool({
        name: 'iter_now',
        description: '不等骰子，现在就叫醒一次（测试用）。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_a, v) { return [{ type: 'text', text: v && v.ok ? '✓ 已经排上了' : ('✗ ' + String((v && v.error) || '没排上')) }] },
        },
        async execute() {
          const cfg = loadCfg()
          const s = stFor(sid)
          const seg = composeFor(s, cfg, {})
          s.lastDirection = seg.direction
          s.recentAngles = [seg.direction].concat(s.recentAngles || []).slice(0, 3)
          s.lastSpokenAt = Date.now()
          s.pendingReplyAt = Date.now()
          s.unanswered = (Number(s.unanswered) || 0) + 1
          saveState(st)
          const r = await deliver(sid, seg.prompt, { seg: 1, direction: seg.direction })
          return r.ok ? { ok: true, direction: seg.direction } : { ok: false, error: r.error }
        },
      }),
    ]
  }

  const mounted = new Map()
  function mountFor(agent, sid) {
    const offs = []
    for (const t of makeTools(sid)) {
      try {
        const off = agent.ctx.tools.register(t)
        if (typeof off === 'function') offs.push(off)
      } catch (e) { diag('工具 ' + t.name + ' 挂不上：' + (e && e.message)) }
    }
    try {
      const off = agent.ctx.on('agent/inbox/inserted', (payload) => {
        const msg = payload && payload.message ? payload.message : payload
        const role = msg && (msg.role || (msg.author && msg.author.role))
        if (role && role !== 'user') return
        const now = Date.now()
        lastUserAt = now
        try {
          const cfg = loadCfg()
          const s = stFor(sid)
          s.lastUserAt = now
          s.unanswered = 0
          s.pendingReplyAt = 0
          recordMood(s, nudgeMood(s.mood, cfg.moodReplyBoost, '他跟你说话了', now, cfg), 'reply', now)
          saveState(st)
        } catch { /* 忽略 */ }
      })
      if (typeof off === 'function') offs.push(off)
    } catch { /* 忽略 */ }
    return { off: () => { for (const o of offs) { try { if (typeof o === 'function') o() } catch { /* 忽略 */ } } } }
  }

  function tickMount() {
    try {
      const cfg = loadCfg()
      for (const agent of ctx.agents.list() || []) {
        const sid = sessionIdOf(agent && agent.session)
        if (!sid) continue
        if (!cfg.enabled) {
          const v = mounted.get(sid)
          if (v) { try { v.off() } catch { /* 忽略 */ } mounted.delete(sid) }
          continue
        }
        if (mounted.has(sid)) continue
        try { mounted.set(sid, mountFor(agent, sid)) } catch (e) { diag('挂 ' + sid + ' 失败：' + (e && e.message)) }
      }
    } catch (e) { diag('mount tick 出错：' + (e && e.message)) }
  }
  try { ctx.timer.interval(tickMount, 3000) } catch { setTimeout(tickMount, 3000) }

  // ───────────── 设置页接口 ─────────────
  const BASE = '/dsh-iter-memory'
  const mroute = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + path,
    handler: async (req, res) => {
      try { await handler(req, res) } catch (e) {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(e && e.message) }))
        } catch { /* 客户端断了 */ }
      }
    },
  }))

  const send = (res, v) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(v))
  }

  const readBody = (req) => new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  mroute('/status', async (req, res) => {
    const cfg = loadCfg()
    const now = Date.now()
    const rows = activeSessions().map((sid) => {
      const s = stFor(sid)
      const mv = moodView(s, cfg, now)
      return {
        sid,
        nextAt: s.nextAt || 0,
        spokenToday: s.day === dayKey(now) ? s.spoken : 0,
        lastSpokenAt: s.lastSpokenAt || 0,
        lastReason: s.lastReason || '',
        mood: { level: Number(mv.level.toFixed(3)), label: mv.label, why: mv.why, baseline: mv.baseline },
        curve: curvePoints(s.moodLog, now, 24, 72),
      }
    })
    send(res, { ok: true, version: VERSION, cfg, sessions: rows, log: tailLog(20) })
  })

  mroute('/config', async (req, res) => {
    if (req.method === 'GET') { send(res, { ok: true, cfg: loadCfg() }); return }
    const body = await readBody(req)
    const keys = ['enabled', 'minMinutes', 'maxMinutes', 'speakProb', 'activeStart', 'activeEnd', 'maxPerDay',
      'cooldownMinutes', 'userCooldownMinutes', 'prompt', 'style', 'multiSegmentProb', 'gapMinSeconds', 'gapMaxSeconds',
      'roundCooldownMult', 'moodBaseline', 'moodHalfLifeMinutes', 'moodReplyBoost', 'moodIgnoredDrop',
      'moodSpeakInfluence', 'moodInWhisper']
    const patch = {}
    for (const k of keys) if (body && body[k] !== undefined) patch[k] = body[k]
    const cfg = saveCfg(patch)
    for (const sid of activeSessions()) {
      if (cfg.enabled) { if (!st.sessions[sid] || !st.sessions[sid].nextAt) arm(sid) }
      else { stFor(sid).nextAt = 0 }
    }
    saveState(st)
    send(res, { ok: true, cfg })
  })

  mroute('/feel', async (req, res) => {
    if (req.method !== 'POST') { send(res, { ok: false, error: 'POST only' }); return }
    const body = await readBody(req)
    const sids = activeSessions()
    if (!sids.length) { send(res, { ok: false, error: '现在没有活着的会话' }); return }
    const cfg = loadCfg()
    const now = Date.now()
    const s = stFor(sids[0])
    const lv = clamp01(body && body.level)
    const why = String((body && body.why) || '').slice(0, 200)
    s.mood = setMood(s.mood, lv, why, now)
    s.moodLog = pushMoodPoint(s.moodLog, { t: now, v: lv, k: '自报' })
    s.pendingReplyAt = 0
    saveState(st)
    appendLog({ at: now, sid: sids[0], op: 'mood-set', level: lv, why })
    send(res, { ok: true, level: Number(lv.toFixed(3)), label: moodLabel(lv), why })
  })

  mroute('/now', async (req, res) => {
    const sids = activeSessions()
    if (!sids.length) { send(res, { ok: false, error: '现在没有活着的会话，叫不醒' }); return }
    const cfg = loadCfg()
    const s = stFor(sids[0])
    const seg = composeFor(s, cfg, {})
    s.lastDirection = seg.direction
    s.recentAngles = [seg.direction].concat(s.recentAngles || []).slice(0, 3)
    s.lastSpokenAt = Date.now()
    s.pendingReplyAt = Date.now()
    saveState(st)
    const r = await deliver(sids[0], seg.prompt, { seg: 1, direction: seg.direction })
    send(res, r.ok ? { ok: true, direction: seg.direction } : { ok: false, error: r.error })
  })

  mroute('/log', async (req, res) => { send(res, { ok: true, log: tailLog(60) }) })

  ctx.effect(() => () => { try { saveState(st) } catch { /* 忽略 */ } })
}

export const __test = { decide, dayKey, decayedLevel, moodLabel, curvePoints }
