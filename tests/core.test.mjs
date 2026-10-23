import test from 'node:test'
import assert from 'node:assert/strict'
import { MINUTE, DEFAULT_CFG, pickDelayMs, hourOf, inWindow, nextWindowStart, dayKey, decide } from '../lib/core.js'

const cfg = { ...DEFAULT_CFG }
const at = (h, m = 0) => new Date(2026, 9, 23, h, m, 0, 0).getTime()
// 按顺序吐出固定的骰子结果，最后一次重复使用
const dice = (...vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)] }

test('pickDelayMs 落在 [min,max] 分钟之间', () => {
  assert.equal(pickDelayMs(cfg, () => 0), 40 * MINUTE)
  assert.equal(pickDelayMs(cfg, () => 0.999999), 200 * MINUTE)
  for (let i = 0; i < 200; i++) {
    const ms = pickDelayMs(cfg, Math.random)
    assert.ok(ms >= 40 * MINUTE && ms <= 200 * MINUTE, '越界: ' + ms)
  }
})

test('pickDelayMs 对坏配置兜底不炸', () => {
  assert.equal(pickDelayMs({ minMinutes: 0, maxMinutes: -3 }, () => 0), MINUTE)
})

test('inWindow 普通时段 + 跨午夜 + 关闭判定', () => {
  assert.equal(inWindow(cfg, at(12)), true)
  assert.equal(inWindow(cfg, at(3)), false)      // 9-25，凌晨 3 点在 25 之后，不在
  const night = { ...cfg, activeStart: 21, activeEnd: 26 }
  assert.equal(inWindow(night, at(23)), true)
  assert.equal(inWindow(night, at(1)), true)     // 跨午夜
  assert.equal(inWindow(night, at(12)), false)
  assert.equal(inWindow({ ...cfg, activeStart: 9, activeEnd: 9 }, at(4)), true) // 起止相同 = 全天
})

test('nextWindowStart：窗口内返回 now，窗口外推到当天/次日 9 点', () => {
  assert.equal(nextWindowStart(cfg, at(12)), at(12))
  assert.equal(nextWindowStart(cfg, at(3)), at(9))
  assert.equal(nextWindowStart(cfg, at(2)), at(9))
})

test('dayKey 用本地日期', () => {
  assert.equal(dayKey(at(23, 59)), '2026-10-23')
})

test('decide：窗口外不开口', () => {
  const v = decide(cfg, { day: '', spoken: 0 }, at(4), () => 0)
  assert.equal(v.speak, false)
  assert.equal(v.reason, 'outside-window')
  assert.ok(v.nextAt > at(4))
})

test('decide：一天够数了就等明天', () => {
  const v = decide(cfg, { day: dayKey(at(12)), spoken: 5 }, at(12), () => 0)
  assert.equal(v.reason, 'daily-cap')
})

test('decide：刚说过话在冷却里', () => {
  const v = decide(cfg, { day: dayKey(at(12)), spoken: 1, lastSpokenAt: at(12) - 5 * MINUTE }, at(12), () => 0)
  assert.equal(v.reason, 'cooldown')
})

test('decide：主人刚说过话就让开', () => {
  const v = decide(cfg, { day: dayKey(at(12)), spoken: 0, lastUserAt: at(12) - 3 * MINUTE }, at(12), () => 0)
  assert.equal(v.reason, 'user-active')
})

test('decide：骰子掷到沉默（不花钱）', () => {
  const v = decide(cfg, { day: dayKey(at(12)), spoken: 0 }, at(12), dice(0.9, 0))
  assert.equal(v.speak, false)
  assert.equal(v.reason, 'silent')
  assert.ok(v.nextAt - at(12) >= 40 * MINUTE)
})

test('decide：掷到开口，计数 +1，下一次至少隔一个冷却', () => {
  const v = decide(cfg, { day: dayKey(at(12)), spoken: 2 }, at(12), dice(0, 0))
  assert.equal(v.speak, true)
  assert.equal(v.spoken, 3)
  assert.ok(v.nextAt - at(12) >= cfg.cooldownMinutes * MINUTE)
})

test('decide：跨天把计数归零', () => {
  const v = decide(cfg, { day: '2026-10-22', spoken: 9 }, at(12), () => 0)
  assert.equal(v.spoken, 1) // 旧计数清零后从 0 起算，掷到开口 → 1
})
