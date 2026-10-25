import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MINUTE, DEFAULT_CFG, ANGLES, clamp01,
  pickDelayMs, hourOf, inWindow, nextWindowStart, dayKey, clockHHMM, weekdayCN,
  decayedLevel, moodLabel, nudgeMood, setMood, moodFactor, effectiveSpeakProb,
  pushMoodPoint, curvePoints, pickAngle, composeWhisper, segmentsFor, gapMs, decide,
  memoryBridgeStep,
} from '../lib/core.js'

const cfg = (o) => ({ ...DEFAULT_CFG, ...(o || {}) })
const at = (h, m, d) => new Date(2026, 9, d || 24, h, m || 0, 0, 0).getTime()
const seq = (vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)] }

// ───────────── 节拍 ─────────────

test('pickDelayMs 落在区间里，边界也不越界', () => {
  const c = cfg({ minMinutes: 30, maxMinutes: 200 })
  assert.equal(pickDelayMs(c, () => 0), 30 * MINUTE)
  assert.equal(pickDelayMs(c, () => 0.999999), 200 * MINUTE)
  const v = pickDelayMs(c, () => 0.5)
  assert.ok(v >= 30 * MINUTE && v <= 200 * MINUTE)
})

test('pickDelayMs 配置写坏也能兜底', () => {
  const c = cfg({ minMinutes: 0, maxMinutes: -5 })
  const v = pickDelayMs(c, () => 0.3)
  assert.ok(v >= MINUTE)
})

test('hourOf 给小数的钟点', () => {
  assert.equal(hourOf(at(22, 30)), 22.5)
})

test('inWindow：普通时段', () => {
  const c = cfg({ activeStart: 9, activeEnd: 25 })
  assert.equal(inWindow(c, at(15, 0)), true)
  assert.equal(inWindow(c, at(8, 30)), false)
  assert.equal(inWindow(c, at(0, 30)), true)   // 25 表示到次日一点
  assert.equal(inWindow(c, at(2, 0)), false)
})

test('inWindow：跨午夜的 21 → 3', () => {
  const c = cfg({ activeStart: 21, activeEnd: 3 })
  assert.equal(inWindow(c, at(22, 0)), true)
  assert.equal(inWindow(c, at(1, 30)), true)
  assert.equal(inWindow(c, at(12, 0)), false)
})

test('inWindow：起止相同 = 全天', () => {
  const c = cfg({ activeStart: 9, activeEnd: 9 })
  assert.equal(inWindow(c, at(3, 0)), true)
})

test('nextWindowStart：窗口外推到下个开始点，窗口内就是 now', () => {
  const c = cfg({ activeStart: 9, activeEnd: 25 })
  const inWin = at(15, 0)
  assert.equal(nextWindowStart(c, inWin), inWin)
  const outside = at(3, 0)
  const next = nextWindowStart(c, outside)
  assert.equal(new Date(next).getHours(), 9)
  assert.ok(next > outside)
})

test('dayKey / clockHHMM / weekdayCN', () => {
  assert.equal(dayKey(at(0, 5, 3)), '2026-10-03')
  assert.equal(clockHHMM(at(7, 4)), '07:04')
  assert.equal(weekdayCN(at(12, 0)), '周六')
})

// ───────────── 潮位 ─────────────

test('decayedLevel：没有时间戳就当它一直是这个值', () => {
  const c = cfg({ moodBaseline: 0.5 })
  assert.equal(decayedLevel({ level: 0.9, at: 0 }, c, at(12, 0)), 0.9)
  assert.equal(decayedLevel({ level: 3, at: 0 }, c, at(12, 0)), 1)
  assert.equal(decayedLevel({ level: -1, at: 0 }, c, at(12, 0)), 0)
})

test('decayedLevel：一个半衰期正好退到一半', () => {
  const c = cfg({ moodBaseline: 0.5, moodHalfLifeMinutes: 60 })
  const t0 = at(12, 0)
  const v = decayedLevel({ level: 0.9, at: t0 }, c, t0 + 60 * MINUTE)
  assert.ok(Math.abs(v - 0.7) < 1e-9)
})

test('decayedLevel：很久之后回到基线', () => {
  const c = cfg({ moodBaseline: 0.5, moodHalfLifeMinutes: 60 })
  const t0 = at(12, 0)
  const v = decayedLevel({ level: 0.1, at: t0 }, c, t0 + 20 * 60 * MINUTE)
  assert.ok(Math.abs(v - 0.5) < 1e-6)
})

test('moodLabel 的分档', () => {
  assert.equal(moodLabel(1), '很舒展')
  assert.equal(moodLabel(0.7), '还不错')
  assert.equal(moodLabel(0.5), '平常')
  assert.equal(moodLabel(0.4), '有点闷')
  assert.equal(moodLabel(0.2), '挺低')
  assert.equal(moodLabel(0.05), '很沉')
})

test('nudgeMood：先按半衰期算到现在，再加减，并夹在 0~1', () => {
  const c = cfg({ moodBaseline: 0.5, moodHalfLifeMinutes: 60 })
  const t0 = at(12, 0)
  const up = nudgeMood({ level: 0.5, at: t0 }, 0.2, '他跟我说话了', t0, c)
  assert.ok(Math.abs(up.level - 0.7) < 1e-9)
  assert.equal(up.why, '他跟我说话了')
  assert.equal(up.at, t0)
  const capped = nudgeMood({ level: 1, at: 0 }, 0.5, '', t0, c)
  assert.equal(capped.level, 1)
})

test('setMood：自报就是直接定下来，不叠加', () => {
  const m = setMood({ level: 0.9, at: 1 }, 0.3, '有点烦', at(12, 0))
  assert.equal(m.level, 0.3)
  assert.equal(m.why, '有点烦')
})

test('moodFactor：0.5 不影响，两头按强度放大', () => {
  const c = cfg({ moodSpeakInfluence: 0.5 })
  assert.equal(moodFactor(c, 0.5), 1)
  assert.equal(moodFactor(c, 0), 0.5)
  assert.equal(moodFactor(c, 1), 1.5)
  assert.equal(moodFactor(cfg({ moodSpeakInfluence: 0 }), 0), 1)
})

test('effectiveSpeakProb 会按潮位缩放并夹在 0~1', () => {
  const c = cfg({ speakProb: 0.4, moodSpeakInfluence: 0.5 })
  assert.ok(Math.abs(effectiveSpeakProb(c, 0.5) - 0.4) < 1e-9)
  assert.ok(Math.abs(effectiveSpeakProb(c, 0) - 0.2) < 1e-9)
  assert.ok(Math.abs(effectiveSpeakProb(c, 1) - 0.6) < 1e-9)
  assert.equal(clamp01(effectiveSpeakProb(cfg({ speakProb: 1, moodSpeakInfluence: 1 }), 1)), 1)
})

test('pushMoodPoint 只留 limit 个，并且按顺序', () => {
  let log = []
  for (let i = 0; i < 10; i++) log = pushMoodPoint(log, { t: i, v: 0.5 }, 4)
  assert.equal(log.length, 4)
  assert.deepEqual(log.map((p) => p.t), [6, 7, 8, 9])
})

test('curvePoints：只取窗口内的点，超量就抽稀', () => {
  const now = at(12, 0)
  const log = []
  for (let i = 0; i < 100; i++) log.push({ t: now - i * 10 * MINUTE, v: 0.5 })
  const pts = curvePoints(log, now, 24, 10)
  assert.equal(pts.length, 10)
  assert.ok(pts[0].t <= now)
  assert.ok(pts[0].t >= now - 24 * 60 * MINUTE)
})

// ───────────── 开口 ─────────────

test('pickAngle 避开最近用过的', () => {
  const a = pickAngle(() => 0, ANGLES.slice(0, ANGLES.length - 1))
  assert.equal(a, ANGLES[ANGLES.length - 1])
  const b = pickAngle(() => 0.5, ANGLES)
  assert.ok(ANGLES.includes(b))
})

test('segmentsFor：概率 0 永远一段，概率 1 永远两段', () => {
  assert.equal(segmentsFor(cfg({ multiSegmentProb: 0 }), () => 0), 1)
  assert.equal(segmentsFor(cfg({ multiSegmentProb: 1 }), () => 0.99), 2)
})

test('gapMs 落在区间里', () => {
  const c = cfg({ gapMinSeconds: 8, gapMaxSeconds: 40 })
  assert.equal(gapMs(c, () => 0), 8000)
  assert.equal(gapMs(c, () => 0.999999), 40000)
})

test('composeWhisper：处境 + 方向 + 约束都在，且不塞成品句', () => {
  const now = at(22, 0)
  const r = composeWhisper({
    now, lastSpokenAt: now - 90 * MINUTE, lastUserAt: now - 40 * MINUTE,
    direction: 'DIRECTION_SENTINEL', style: '别用感叹号',
  })
  assert.equal(r.direction, 'DIRECTION_SENTINEL')
  const t = r.prompt
  assert.ok(t.includes('22:00'))
  assert.ok(t.includes('90 分钟前'))
  assert.ok(t.includes('40 分钟没出声'))
  assert.ok(t.includes('DIRECTION_SENTINEL'))
  assert.ok(t.includes('别用感叹号'))
  assert.ok(t.includes('不许编造'))
  assert.ok(t.includes('一两句就停'))
  assert.ok(!t.includes('你此刻的状态'))
})

test('composeWhisper：带了潮位就把状态写进去，低的时候多一条约束', () => {
  const now = at(22, 0)
  const low = composeWhisper({ now, direction: 'd', mood: { level: 0.2, why: '今天有点堵' } })
  assert.ok(low.prompt.includes('你此刻的状态：挺低'))
  assert.ok(low.prompt.includes('今天有点堵'))
  assert.ok(low.prompt.includes('别装精神'))
  const high = composeWhisper({ now, direction: 'd', mood: { level: 0.9, why: '' } })
  assert.ok(high.prompt.includes('很舒展'))
  assert.ok(!high.prompt.includes('别装精神'))
})

test('composeWhisper：连续没被接会写进处境', () => {
  const now = at(22, 0)
  const r = composeWhisper({ now, direction: 'd', unanswered: 2, lastDirection: '报个状态', lastDirectionRemembered: true })
  assert.ok(r.prompt.includes('没接这句'))
  assert.ok(r.prompt.includes('连着 2 次'))
})

// ───────────── 裁决 ─────────────

const session = (o) => ({ nextAt: 0, day: '', spoken: 0, lastSpokenAt: 0, lastUserAt: 0, ...(o || {}) })

test('decide：不在活跃时段', () => {
  const c = cfg({ activeStart: 9, activeEnd: 18 })
  const v = decide(c, session(), at(3, 0), { rnd: () => 0.99 })
  assert.equal(v.speak, false)
  assert.equal(v.reason, 'outside-window')
})

test('decide：今天次数用完', () => {
  const c = cfg({ maxPerDay: 2 })
  const now = at(15, 0)
  const v = decide(c, session({ day: dayKey(now), spoken: 2 }), now, { rnd: () => 0.99 })
  assert.equal(v.reason, 'daily-cap')
})

test('decide：刚说过 → cooldown', () => {
  const c = cfg({ activeStart: 0, activeEnd: 24, cooldownMinutes: 25 })
  const now = at(15, 0)
  const v = decide(c, session({ lastSpokenAt: now - 5 * MINUTE }), now, { rnd: () => 0.99 })
  assert.equal(v.reason, 'cooldown')
})

test('decide：他刚说过话 → user-active', () => {
  const c = cfg({ activeStart: 0, activeEnd: 24, userCooldownMinutes: 20 })
  const now = at(15, 0)
  const v = decide(c, session({ lastUserAt: now - 2 * MINUTE }), now, { rnd: () => 0.99 })
  assert.equal(v.reason, 'user-active')
})

test('decide：骰子没过 → silent，且不花 token', () => {
  const c = cfg({ activeStart: 0, activeEnd: 24, speakProb: 0.3 })
  const now = at(15, 0)
  const v = decide(c, session(), now, { rnd: () => 0.9, moodLevel: 0.5 })
  assert.equal(v.reason, 'silent')
  assert.equal(v.spoken, 0)
})

test('decide：骰子过了 → speak，当天计数 +1', () => {
  const c = cfg({ activeStart: 0, activeEnd: 24, speakProb: 0.9, moodSpeakInfluence: 0 })
  const now = at(15, 0)
  const v = decide(c, session({ day: dayKey(now), spoken: 1 }), now, { rnd: () => 0.1, moodLevel: 0.5 })
  assert.equal(v.reason, 'speak')
  assert.equal(v.spoken, 2)
  assert.ok(v.nextAt > now)
})

test('decide：潮位低的时候同样一次骰子更容易忍住', () => {
  const c = cfg({ activeStart: 0, activeEnd: 24, speakProb: 0.6, moodSpeakInfluence: 0.5 })
  const now = at(15, 0)
  const roll = { rnd: () => 0.4 }
  // 潮位 0 → 有效概率 0.3 → 0.4 不过
  assert.equal(decide(c, session(), now, { ...roll, moodLevel: 0 }).reason, 'silent')
  // 潮位 1 → 有效概率 0.9 → 0.4 通过
  assert.equal(decide(c, session(), now, { ...roll, moodLevel: 1 }).reason, 'speak')
})

// ───────────── 跟潮汐记忆搭的那条线 ─────────────

test('memoryBridgeStep：它多命中一条我就抬一点，同样的事只抬一次', () => {
  const c = cfg({ memoryBridge: true, moodMemoryBoost: 0.05 })
  const first = memoryBridgeStep(0, 1, c)
  assert.equal(first.boost, 0.05)
  assert.equal(first.seen, 1)
  // 同一个 seen 再走一遍不该重复加分
  assert.equal(memoryBridgeStep(first.seen, 1, c).boost, 0)
})

test('memoryBridgeStep：一次涨很多也有上限，别一晚上跳到顶', () => {
  const c = cfg({ moodMemoryBoost: 0.05 })
  assert.equal(memoryBridgeStep(0, 10, c).boost, 0.15)
  const big = cfg({ moodMemoryBoost: 0.3 })
  assert.equal(memoryBridgeStep(0, 5, big).boost, 0.2)
})

test('memoryBridgeStep：跨天归零只是把计数重设，不该扣分', () => {
  const c = cfg({ moodMemoryBoost: 0.05 })
  const s = memoryBridgeStep(7, 0, c)
  assert.equal(s.boost, 0)
  assert.equal(s.seen, 0)
})

test('memoryBridgeStep：关掉搭桥就完全不动', () => {
  const c = cfg({ memoryBridge: false, moodMemoryBoost: 0.05 })
  assert.equal(memoryBridgeStep(0, 3, c).boost, 0)
})
