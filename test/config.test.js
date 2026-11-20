/**
 * 离线单测：不碰真机桥，只验证判定逻辑。
 * 跑法：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'

test('默认配置：后台才拉、正常完成才触发、停止不抢屏', () => {
  const o = normalizeConfig(undefined)
  assert.equal(o.enabled, true)
  assert.equal(o.packageName, 'dsh.android.client')
  assert.equal(o.onlyWhenBackground, true)
  assert.equal(o.onCompleted, true)
  assert.equal(o.onAborted, false)
  assert.equal(o.attempts, 3)
})

test('空对象与未传配置等价', () => {
  assert.deepEqual(normalizeConfig({}), normalizeConfig(undefined))
})

test('false 值不被真值判断吞掉', () => {
  const o = normalizeConfig({ enabled: false, onlyWhenBackground: false, onCompleted: false })
  assert.equal(o.enabled, false)
  assert.equal(o.onlyWhenBackground, false)
  assert.equal(o.onCompleted, false)
})

test('onAborted 必须显式写 true 才开', () => {
  assert.equal(normalizeConfig({ onAborted: 'true' }).onAborted, false)
  assert.equal(normalizeConfig({ onAborted: true }).onAborted, true)
})

test('attempts 被夹到 1..6，非整数回落 3', () => {
  // 0 次尝试等于不做事，夹到 1；超上限夹到 6。
  assert.equal(normalizeConfig({ attempts: 0 }).attempts, 1)
  assert.equal(normalizeConfig({ attempts: 99 }).attempts, 6)
  assert.equal(normalizeConfig({ attempts: 2.5 }).attempts, 3)
  assert.equal(normalizeConfig({ attempts: 1 }).attempts, 1)
})

test('空白包名回落默认值', () => {
  assert.equal(normalizeConfig({ packageName: '   ' }).packageName, 'dsh.android.client')
  assert.equal(normalizeConfig({ packageName: ' com.other.app ' }).packageName, 'com.other.app')
})

test('负数时长回落默认值', () => {
  assert.equal(normalizeConfig({ cooldownMs: -1 }).cooldownMs, 8000)
  assert.equal(normalizeConfig({ minTurnMs: -5 }).minTurnMs, 0)
  assert.equal(normalizeConfig({ minTurnMs: 3000 }).minTurnMs, 3000)
})
