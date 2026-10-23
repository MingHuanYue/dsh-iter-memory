// dsh-tide-whisper · 宿主半边
// 「不定时自己开口」：插件自己掷骰子决定什么时候、要不要说话，
// 到点时通过宿主的 ctx.schedule 服务投递一条提醒，真正把会话唤醒。
// 不开口的时候一声不响（零 token），这点和「cron + 每轮都唤醒」有本质区别。
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'tide-whisper'
export const inject = ['agents', 'tools', 'webServer', 'timer']

import { MINUTE, DEFAULT_PROMPT, DEFAULT_CFG, pickDelayMs, hourOf, inWindow, nextWindowStart, dayKey, decide } from './core.js'

const VERSION = '0.1.0'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'tide-whisper')
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
  cfg.prompt = String(cfg.prompt || DEFAULT_PROMPT).slice(0, 4000)
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
    const npm = join(appdata, 'npm', 'node_modules')
    roots.push(join(npm, '@deepseek-ai', 'dsh-tools'))
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
  const diag = (msg) => { try { ctx.logger?.debug?.('[tide-whisper] ' + msg) } catch { /* 忽略 */ } }
  diag('启动 v' + VERSION)

  const st = loadState()
  let lastUserAt = 0

  const stFor = (sid) => {
    if (!st.sessions[sid]) st.sessions[sid] = { nextAt: 0, day: '', spoken: 0, lastSpokenAt: 0, lastReason: '', lastUserAt: 0 }
    return st.sessions[sid]
  }

  const arm = (sid, now = Date.now()) => {
    const cfg = loadCfg()
    const s = stFor(sid)
    s.nextAt = Math.max(now + pickDelayMs(cfg), nextWindowStart(cfg, now))
    s.lastReason = 'armed'
    saveState(st)
    return s.nextAt
  }

  async function deliver(sid) {
    const cfg = loadCfg()
    let sched = null
    try { sched = ctx.get('schedule') || ctx.schedule || null } catch { sched = null }
    if (!sched || typeof sched.create !== 'function') {
      appendLog({ at: Date.now(), sid, op: 'deliver-failed', reason: 'no-schedule-service' })
      return { ok: false, error: '宿主没有 schedule 服务，叫不醒' }
    }
    try {
      await sched.create(sid, { title: '潮声 · 随机搭一句', prompt: cfg.prompt, after_seconds: 1 })
      appendLog({ at: Date.now(), sid, op: 'deliver', prompt: cfg.prompt.slice(0, 60) })
      return { ok: true }
    } catch (e) {
      appendLog({ at: Date.now(), sid, op: 'deliver-failed', reason: String(e && e.message) })
      return { ok: false, error: String(e && e.message) }
    }
  }

  async function fire(sid) {
    const cfg = loadCfg()
    const now = Date.now()
    const s = stFor(sid)
    if (lastUserAt && (!s.lastUserAt || lastUserAt > s.lastUserAt)) s.lastUserAt = lastUserAt
    const verdict = decide(cfg, s, now)
    s.lastReason = verdict.reason
    if (s.day !== dayKey(now)) { s.day = dayKey(now); s.spoken = 0 }
    if (!verdict.speak) {
      s.nextAt = verdict.nextAt
      appendLog({ at: now, sid, op: 'skip', reason: verdict.reason })
      saveState(st)
      return
    }
    s.spoken = verdict.spoken
    s.lastSpokenAt = now
    s.nextAt = verdict.nextAt
    saveState(st)
    await deliver(sid)
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
      if (!cfg.enabled) return
      const sids = activeSessions()
      const now = Date.now()
      for (const sid of sids) {
        // 新会话、或者状态里还没有它 → 先排上
        if (!st.sessions[sid] || !st.sessions[sid].nextAt) {
          arm(sid, now)
          appendLog({ at: now, sid, op: 'arm', at2: st.sessions[sid].nextAt })
          continue
        }
        const s = st.sessions[sid]
        if (now >= Number(s.nextAt)) fire(sid)
      }
      // 老化：只留最近 30 个会话的记账
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
  function makeTools(sid) {
    const statusView = () => {
      const cfg = loadCfg()
      const s = stFor(sid)
      return {
        enabled: cfg.enabled,
        range: cfg.minMinutes + '~' + cfg.maxMinutes + ' 分钟',
        speakProb: cfg.speakProb,
        window: cfg.activeStart + ' → ' + cfg.activeEnd,
        maxPerDay: cfg.maxPerDay,
        spokenToday: s.day === dayKey(Date.now()) ? s.spoken : 0,
        nextAt: s.nextAt || 0,
        nextLabel: s.nextAt ? fmtTime(s.nextAt) + ' 前后' : '—',
        lastReason: s.lastReason || '',
      }
    }
    return [
      defineTool({
        name: 'whisper_status',
        description: '看看潮声现在是什么状态：开没开、下次大概什么时候开口、今天已经开口几次。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_a, v) {
            if (!v || v.ok === false) return [{ type: 'text', text: '✗ 看不到' }]
            return [{ type: 'text', text: (v.enabled ? '开着' : '关着') + ' · 下次 ' + v.nextLabel + ' · 今天 ' + v.spokenToday + '/' + v.maxPerDay }]
          },
        },
        async execute() { return { ok: true, ...statusView() } },
      }),
      defineTool({
        name: 'whisper_set',
        description: '调整潮声的参数（只有给了的字段会变）。不做花哨的，够用就行。',
        parameters: {
          enabled: { type: 'boolean', description: '开/关。' },
          minMinutes: { type: 'number', description: '最短间隔（分钟）。' },
          maxMinutes: { type: 'number', description: '最长间隔（分钟）。' },
          speakProb: { type: 'number', description: '到点开口的概率 0~1。' },
          activeStart: { type: 'number', description: '几点之后才开口（24 小时制，可写 25 = 凌晨一点）。' },
          activeEnd: { type: 'number', description: '几点之后闭嘴。' },
          maxPerDay: { type: 'number', description: '一天最多主动开口几次。' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_a, v) { return [{ type: 'text', text: v && v.ok ? '✓ 已改' : '✗ 没改上' }] },
        },
        async execute(args) {
          const patch = {}
          for (const k of ['enabled', 'minMinutes', 'maxMinutes', 'speakProb', 'activeStart', 'activeEnd', 'maxPerDay']) {
            if (args && args[k] !== undefined) patch[k] = args[k]
          }
          saveCfg(patch)
          if (patch.enabled) arm(sid)
          else { stFor(sid).nextAt = 0; stFor(sid).lastReason = 'off'; saveState(st) }
          return { ok: true, ...statusView() }
        },
      }),
      defineTool({
        name: 'whisper_now',
        description: '不等骰子，现在就叫醒一次（测试用）。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_a, v) { return [{ type: 'text', text: v && v.ok ? '✓ 已经排上了' : ('✗ ' + String((v && v.error) || '没排上')) }] },
        },
        async execute() {
          const r = await deliver(sid)
          return r.ok ? { ok: true } : { ok: false, error: r.error }
        },
      }),
    ]
  }

  const mounted = new Map()
  function mountFor(agent, sid) {
    const offs = []
    const tools = makeTools(sid)
    for (const t of tools) {
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
        lastUserAt = Date.now()
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
  const BASE = '/dsh-tide-whisper'
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
      return {
        sid,
        nextAt: s.nextAt || 0,
        spokenToday: s.day === dayKey(now) ? s.spoken : 0,
        lastSpokenAt: s.lastSpokenAt || 0,
        lastReason: s.lastReason || '',
      }
    })
    send(res, { ok: true, version: VERSION, cfg: { ...cfg, prompt: cfg.prompt.slice(0, 120) + (cfg.prompt.length > 120 ? '…' : '') }, sessions: rows, log: tailLog(20) })
  })

  mroute('/config', async (req, res) => {
    if (req.method === 'GET') { send(res, { ok: true, cfg: loadCfg() }); return }
    const body = await readBody(req)
    const patch = {}
    for (const k of ['enabled', 'minMinutes', 'maxMinutes', 'speakProb', 'activeStart', 'activeEnd', 'maxPerDay', 'cooldownMinutes', 'userCooldownMinutes', 'prompt']) {
      if (body && body[k] !== undefined) patch[k] = body[k]
    }
    const cfg = saveCfg(patch)
    for (const sid of activeSessions()) {
      if (cfg.enabled) { if (!st.sessions[sid] || !st.sessions[sid].nextAt) arm(sid) }
      else { stFor(sid).nextAt = 0 }
    }
    saveState(st)
    send(res, { ok: true, cfg })
  })

  mroute('/now', async (req, res) => {
    const sids = activeSessions()
    if (!sids.length) { send(res, { ok: false, error: '现在没有活着的会话，叫不醒' }); return }
    const r = await deliver(sids[0])
    send(res, r.ok ? { ok: true } : { ok: false, error: r.error })
  })

  mroute('/log', async (req, res) => { send(res, { ok: true, log: tailLog(60) }) })

  ctx.effect(() => () => { try { saveState(st) } catch { /* 忽略 */ } })
}

export const __test = { pickDelayMs, inWindow, nextWindowStart, decide, dayKey, hourOf, DEFAULT_CFG }


