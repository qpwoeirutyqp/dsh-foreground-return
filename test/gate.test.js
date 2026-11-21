/**
 * 白名单/黑名单判定与前台包名解析的离线单测。
 * 跑法：node --test "test/*.test.js"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseForegroundPackage, matchPackages } from '../foreground-package.js'
import { normalizeConfig, foregroundGate } from '../index.js'

// ---------- 前台包名解析 ----------

test('解析 mResumedActivity 行', () => {
  const line = '    mResumedActivity: ActivityRecord{dd97dce u0 com.ss.android.ugc.aweme/.splash.SplashActivity t1720 d0}'
  assert.equal(parseForegroundPackage(line), 'com.ss.android.ugc.aweme')
})

test('解析 mFocusedApp 行（没有 mResumedActivity 时退路）', () => {
  const line = '  mFocusedApp=ActivityRecord{abc u0 com.android.settings/.Settings t1 d0}'
  assert.equal(parseForegroundPackage(line), 'com.android.settings')
})

test('优先 mResumedActivity 而不是 mFocusedApp', () => {
  const text = [
    '  mFocusedApp=ActivityRecord{a u0 com.android.settings/.Settings t1 d0}',
    '    mResumedActivity: ActivityRecord{b u0 com.tencent.mm/.ui.LauncherUI t2 d0}'
  ].join('\n')
  assert.equal(parseForegroundPackage(text), 'com.tencent.mm')
})

test('没有前台行或空输入返回 undefined', () => {
  assert.equal(parseForegroundPackage('随便什么东西'), undefined)
  assert.equal(parseForegroundPackage(''), undefined)
  assert.equal(parseForegroundPackage(undefined), undefined)
})

test('不把 u0 这类非包名当成包名', () => {
  const line = '    mResumedActivity: ActivityRecord{abc t1 d0}'
  assert.equal(parseForegroundPackage(line), undefined)
})

// ---------- 包名匹配 ----------

test('精确匹配', () => {
  assert.equal(matchPackages(['com.tencent.mm'], 'com.tencent.mm'), true)
  assert.equal(matchPackages(['com.tencent.mm'], 'com.tencent.mm2'), false)
})

test('尾部通配只匹配前缀', () => {
  assert.equal(matchPackages(['com.tencent.*'], 'com.tencent.mm'), true)
  assert.equal(matchPackages(['com.tencent.*'], 'com.tencent'), false)
  assert.equal(matchPackages(['com.*'], 'com.android.settings'), true)
})

test('空规则表返回 undefined（区分"没配"与"没命中"）', () => {
  assert.equal(matchPackages([], 'com.tencent.mm'), undefined)
  assert.equal(matchPackages(undefined, 'com.tencent.mm'), undefined)
})

test('空白包名与脏规则不会误命中', () => {
  assert.equal(matchPackages([''], ''), false)
  assert.equal(matchPackages(['  com.tencent.mm  '], 'com.tencent.mm'), true)
})

// ---------- 配置收敛 ----------

test('白名单默认空，表示不启用', () => {
  const o = normalizeConfig(undefined)
  assert.deepEqual(o.allowForegroundPackages, [])
  assert.deepEqual(o.denyForegroundPackages, [])
  assert.equal(o.allowWhenUnknown, true)
})

test('白名单去掉空白项和非字符串', () => {
  const o = normalizeConfig({ allowForegroundPackages: ['  com.tencent.mm ', '', 42, null, 'com.tencent.*'] })
  assert.deepEqual(o.allowForegroundPackages, ['com.tencent.mm', 'com.tencent.*'])
})

test('allowWhenUnknown 只有显式 false 才关', () => {
  assert.equal(normalizeConfig({}).allowWhenUnknown, true)
  assert.equal(normalizeConfig({ allowWhenUnknown: 'false' }).allowWhenUnknown, true)
  assert.equal(normalizeConfig({ allowWhenUnknown: false }).allowWhenUnknown, false)
})

// ---------- 判定流程（注入假的前台查询）----------

const fakeShell = pkg => ({ shellPath: '/bin/echo', _pkg: pkg })

/** 用假执行器替换 currentForegroundPackage 的输入：直接调 foregroundGate 并给 shellPath。 */
async function gate(options, pkg) {
  // shellPath 指向一个把包名原样打出来的脚本；parseForegroundPackage 需要 mResumedActivity 行。
  const shellPath = await makeEchoShell(pkg)
  return foregroundGate({ ...options, shellPath })
}

import { writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let seq = 0
async function makeEchoShell(pkg) {
  const file = join(tmpdir(), 'fg-echo-' + (++seq) + '.sh')
  const line = pkg === undefined
    ? 'echo "nothing here"'
    : `echo "    mResumedActivity: ActivityRecord{abc u0 ${pkg}/.Main t1 d0}"`
  await writeFile(file, '#!/bin/sh\n' + line + '\n', { mode: 0o755 })
  await chmod(file, 0o755)
  return file
}

test('没配任何名单：直接放行，不查前台应用', async () => {
  const r = await gate({}, 'com.any.app')
  assert.equal(r.verdict, 'allow')
})

test('白名单命中才放行', async () => {
  const allow = ['com.tencent.mm', 'com.tencent.*']
  assert.equal((await gate({ allowForegroundPackages: allow }, 'com.tencent.mm')).verdict, 'allow')
  assert.equal((await gate({ allowForegroundPackages: allow }, 'com.tencent.mm2')).verdict, 'allow')
  const miss = await gate({ allowForegroundPackages: allow }, 'com.android.settings')
  assert.equal(miss.verdict, 'denied')
  assert.equal(miss.reason, 'not-whitelisted')
})

test('黑名单优先于白名单', async () => {
  const r = await gate({
    allowForegroundPackages: ['com.tencent.*'],
    denyForegroundPackages: ['com.tencent.mm']
  }, 'com.tencent.mm')
  assert.equal(r.verdict, 'denied')
  assert.equal(r.reason, 'blacklisted')
})

test('只配黑名单：不在名单里就放行', async () => {
  assert.equal((await gate({ denyForegroundPackages: ['com.tencent.mm'] }, 'com.android.settings')).verdict, 'allow')
  assert.equal((await gate({ denyForegroundPackages: ['com.tencent.mm'] }, 'com.tencent.mm')).verdict, 'denied')
})

test('读不出前台应用：默认放行', async () => {
  const r = await gate({ allowForegroundPackages: ['com.tencent.mm'] }, undefined)
  assert.equal(r.verdict, 'allow')
})

test('读不出前台应用且 allowWhenUnknown=false：拒绝', async () => {
  const r = await gate({ allowForegroundPackages: ['com.tencent.mm'], allowWhenUnknown: false }, undefined)
  assert.equal(r.verdict, 'denied')
  assert.equal(r.reason, 'whitelist-unknown')
})
