'use strict';

/**
 * 值班交接单 HTTP 集成测试：
 *   临时库启动真实服务 → 交班人生成交接单 → 接班人查看/签收 →
 *   验证：六类状态快照内容、本人不能签收、同一人重复签收幂等返回原结果、
 *   其他人重复签收拒绝、任一状态变化即原子拒绝签收并列出变化类别且标记过期、
 *   重新生成取代旧单、站场重置只令未签收单过期（已签收保留）、重启可查询、
 *   并发签收/并发状态变化的原子仲裁、交接单不阻塞既有操作。
 *
 * 运行：node test/handover-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3921;
const DB_PATH = process.env.SMOKE_DB_HANDOVER ||
  path.join(__dirname, '..', 'data', 'handover-test.db');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
      }
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code !== 0) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}

async function api(pathName, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + pathName, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}

async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const { status, data } = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (status !== 200) throw new Error('登录失败: ' + data.error);
  return data.token;
}

async function getState(token) {
  return (await api('/api/state', { token })).data.state;
}

async function getHandover(token, id) {
  return (await api(`/api/handovers/${id}`, { token })).data.handover;
}

async function generate(token) {
  const r = await api('/api/handovers', { token, method: 'POST' });
  if (r.status !== 201) throw new Error('生成交接单失败: ' + JSON.stringify(r.data));
  return r.data;
}

async function resetTraining(admin) {
  const r = await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  if (r.status !== 200) throw new Error('重置失败: ' + JSON.stringify(r.data));
}

async function openR1(token) {
  const r = await api('/api/routes/R1/open', {
    token, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  if (r.status !== 200) throw new Error('开放 R1 失败: ' + JSON.stringify(r.data));
  return r.data.instance.id;
}

function labelsOf(resp) {
  return (resp.data.changes || []).map((c) => c.label);
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');
  const bing = await login('dispatcher', '值班员丙');

  console.log('\n[1] 鉴权：未登录 401、管理员 403');
  let r = await api('/api/handovers', { method: 'POST' });
  eq('未登录生成 401', r.status, 401);
  r = await api('/api/handovers', { token: admin });
  eq('管理员查看 403', r.status, 403);
  r = await api('/api/handovers/1/sign', { token: admin, method: 'POST' });
  eq('管理员签收 403', r.status, 403);

  console.log('\n[2] 生成：记录六类状态快照、生成时间与交班人');
  await resetTraining(admin);
  const t0 = Date.now();
  const g1 = await generate(jia);
  const h1 = g1.handover;
  eq('h1 待签收', h1.status, 'pending');
  eq('h1 交班人', h1.shiftFrom, '值班员甲');
  eq('h1 接班人为空', h1.shiftTo, null);
  ok('h1 生成时间为当前时刻', Math.abs(h1.generatedAt - t0) < 5000, { generatedAt: h1.generatedAt });
  eq('快照区段数 5', h1.snapshot.sections.length, 5);
  eq('快照道岔数 2', h1.snapshot.switches.length, 2);
  ok('快照含六类键',
    ['sections', 'switches', 'openInstances', 'waiting', 'cancellations', 'blockades']
      .every((k) => Array.isArray(h1.snapshot[k])));
  eq('初始无开放进路', h1.snapshot.openInstances.length, 0);
  ok('快照含指纹（64 位 hex）', /^[0-9a-f]{64}$/.test(h1.digest), h1.digest);
  let st = await getState(jia);
  ok('/api/state 下发交接单', Array.isArray(st.handovers) && st.handovers.some((x) => x.id === h1.id));

  console.log('\n[3] 签收：姓名须不同；本人 400');
  r = await api(`/api/handovers/${h1.id}/sign`, { token: jia, method: 'POST' });
  eq('本人签收 400', r.status, 400);
  eq('错误码 HANDOVER_SAME_PERSON', r.data.code, 'HANDOVER_SAME_PERSON');
  eq('单据仍 pending（未误标过期）', (await getHandover(yi, h1.id)).status, 'pending');

  console.log('\n[4] 他人签收成功；同一人重复签收返回原结果；其他人重复签收拒绝');
  r = await api(`/api/handovers/${h1.id}/sign`, { token: yi, method: 'POST' });
  eq('乙签收 201', r.status, 201);
  eq('repeated=false', r.data.repeated, false);
  ok('签收时间已写', r.data.handover.signedAt >= h1.generatedAt);
  eq('接班人写入', r.data.handover.shiftTo, '值班员乙');
  r = await api(`/api/handovers/${h1.id}/sign`, { token: yi, method: 'POST' });
  eq('乙重复签收 200', r.status, 200);
  eq('重复签收 repeated=true', r.data.repeated, true);
  eq('重复返回原签收结果（接班人不变）', r.data.handover.shiftTo, '值班员乙');
  r = await api(`/api/handovers/${h1.id}/sign`, { token: bing, method: 'POST' });
  eq('丙再签收 409', r.status, 409);
  eq('错误码 HANDOVER_ALREADY_SIGNED', r.data.code, 'HANDOVER_ALREADY_SIGNED');
  eq('返回原签收人', r.data.signedBy, '值班员乙');

  console.log('\n[5] 列表筛选与不存在单据');
  r = await api('/api/handovers?status=signed', { token: yi });
  ok('signed 筛选只含已签收', r.data.handovers.every((h) => h.status === 'signed'));
  ok('signed 筛选含 h1', r.data.handovers.some((h) => h.id === h1.id));
  r = await api('/api/handovers?status=pending', { token: yi });
  ok('pending 筛选只含待签收', r.data.handovers.every((h) => h.status === 'pending'));
  r = await api('/api/handovers?mine=1', { token: bing });
  eq('丙本人相关为空', r.data.handovers.length, 0);
  r = await api('/api/handovers?mine=1', { token: yi });
  ok('乙本人相关含 h1（接班）', r.data.handovers.some((h) => h.id === h1.id));
  r = await api('/api/handovers/99999', { token: yi });
  eq('不存在单据 404', r.status, 404);
  r = await api('/api/handovers/99999/sign', { token: yi, method: 'POST' });
  eq('签收不存在单据 404', r.status, 404);
  eq('错误码 HANDOVER_NOT_FOUND', r.data.code, 'HANDOVER_NOT_FOUND');

  console.log('\n[6] 状态变化①：区段占用变化 → 拒绝、列类别、标记过期，再签仍拒绝');
  await resetTraining(admin);
  let g = await generate(jia);
  const hs = g.handover.id;
  r = await api('/api/sections/2/state', { token: bing, method: 'POST', body: { action: 'occupy' } });
  eq('交接单不阻塞：独立置占用成功', r.status, 200);
  r = await api(`/api/handovers/${hs}/sign`, { token: yi, method: 'POST' });
  eq('区段变化签收 409', r.status, 409);
  eq('错误码 HANDOVER_STALE', r.data.code, 'HANDOVER_STALE');
  ok('变化类别含"区段占用"', labelsOf(r).includes('区段占用'), labelsOf(r));
  ok('明细指出区段 2', r.data.changes[0].detail.includes('区段 2'), r.data.changes);
  eq('单据标记过期', (await getHandover(yi, hs)).status, 'expired');
  r = await api(`/api/handovers/${hs}/sign`, { token: yi, method: 'POST' });
  eq('过期单再签 409 HANDOVER_EXPIRED', r.status, 409);
  eq('错误码 HANDOVER_EXPIRED', r.data.code, 'HANDOVER_EXPIRED');
  // 交班人重新生成（状态已稳定），签收成功
  g = await generate(jia);
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: yi, method: 'POST' });
  eq('重新生成后签收成功', r.status, 201);

  console.log('\n[7] 状态变化②：道岔位置变化');
  await resetTraining(admin);
  g = await generate(jia);
  await api('/api/switches/SW7/move', { token: yi, method: 'POST', body: { position: 'R' } });
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: bing, method: 'POST' });
  eq('道岔变化签收 409', r.status, 409);
  ok('变化类别含"道岔位置"', labelsOf(r).includes('道岔位置'), labelsOf(r));
  ok('明细指出 SW7', r.data.changes[0].detail.includes('SW7'), r.data.changes);

  console.log('\n[8] 状态变化③：开放进路出现 / 信号与走行进度变化');
  await resetTraining(admin);
  g = await generate(jia);
  const iid = await openR1(yi);
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: bing, method: 'POST' });
  eq('新增开放进路签收 409', r.status, 409);
  ok('变化类别含"开放进路的信号与走行进度"',
    labelsOf(r).includes('开放进路的信号与走行进度'), labelsOf(r));
  // 重新快照于"已开放、信号绿"，再提交首段占用：信号回红+走行事件+进度推进
  g = await generate(jia);
  ok('新单快照含该开放实例', g.handover.snapshot.openInstances.some((x) => x.id === iid));
  eq('快照中实例信号绿', g.handover.snapshot.openInstances[0].signalState, 'green');
  r = await api(`/api/instances/${iid}/events`, {
    token: yi, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('交接单不阻塞：走行事件受理', r.status, 200);
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: bing, method: 'POST' });
  eq('走行后签收 409', r.status, 409);
  const chOpen = (r.data.changes || []).find((c) => c.category === 'openRoutes');
  ok('开放进路类别明细含信号变化', chOpen && chOpen.detail.includes('信号'), r.data.changes);
  ok('开放进路类别明细含走行', chOpen && /走行|事件/.test(chOpen.detail), chOpen && chOpen.detail);

  console.log('\n[9] 状态变化④：等待申请');
  await resetTraining(admin);
  g = await generate(jia);
  r = await api('/api/routes/R1/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('交接单不阻塞：等待申请立即兑现', r.status, 201);
  eq('空场等待申请直接兑现', r.data.waiting.status, 'fulfilled');
  // 以全新交接单隔离等待集合变化：先重置再造一个等待
  await resetTraining(admin);
  const iid2 = await openR1(jia);
  g = await generate(yi); // 快照：1 条开放进路、无等待
  r = await api('/api/routes/R1/waiting', {
    token: bing, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('等待申请保持等待', r.data.waiting.status, 'waiting');
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: jia, method: 'POST' });
  eq('等待变化签收 409', r.status, 409);
  ok('变化类别含"等待申请"', labelsOf(r).includes('等待申请'), labelsOf(r));
  const waitCh = r.data.changes.find((c) => c.category === 'waiting');
  ok('等待明细指出申请编号与新增',
    waitCh && waitCh.detail.includes(`等待申请 #`) && waitCh.detail.includes('新增'), waitCh);
  // 清理：走行解除开放实例
  await api(`/api/instances/${iid2}/events`, {
    token: jia, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });

  console.log('\n[10] 状态变化⑤：待处理延时取消申请');
  await resetTraining(admin);
  const iid3 = await openR1(jia);
  g = await generate(yi); // 快照：开放进路、无 pending 取消
  r = await api(`/api/instances/${iid3}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('交接单不阻塞：延时取消可申请', r.status, 201);
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: bing, method: 'POST' });
  eq('延时取消变化签收 409', r.status, 409);
  ok('变化类别含"延时取消申请"', labelsOf(r).includes('延时取消申请'), labelsOf(r));

  console.log('\n[11] 状态变化⑥：未结束封锁');
  await resetTraining(admin);
  g = await generate(jia);
  r = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '3', reason: '交接验证施工' }
  });
  eq('交接单不阻塞：封锁可发起', r.status, 201);
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: yi, method: 'POST' });
  eq('封锁变化签收 409', r.status, 409);
  ok('变化类别含"未结束封锁"', labelsOf(r).includes('未结束封锁'), labelsOf(r));
  ok('封锁明细指出区段 3',
    (r.data.changes.find((c) => c.category === 'blockades') || {}).detail?.includes('区段 3'),
    r.data.changes);
  // 封锁结束后旧单仍处于过期（不会自动复活）
  r = await api('/api/admin/blockades', { token: admin });
  const bid = r.data.blockades.find((b) => b.sectionId === '3' && b.status !== 'ended').id;
  await api(`/api/admin/blockades/${bid}/end`, { token: admin, method: 'POST' });
  r = await api(`/api/handovers/${g.handover.id}/sign`, { token: yi, method: 'POST' });
  eq('状态恢复后旧过期单仍拒绝', r.status, 409);
  eq('错误码 HANDOVER_EXPIRED', r.data.code, 'HANDOVER_EXPIRED');

  console.log('\n[12] 交班人重新生成：本人此前未签收单被取代');
  await resetTraining(admin);
  const ga = await generate(jia);
  await sleep(5);
  const gb = await generate(jia);
  ok('第二次生成返回被取代列表', gb.superseded.includes(ga.handover.id), gb.superseded);
  const oldA = await getHandover(yi, ga.handover.id);
  eq('旧单 expired', oldA.status, 'expired');
  ok('旧单过期原因写明被新单取代', oldA.expireReason.includes('新单取代'), oldA.expireReason);
  r = await api(`/api/handovers/${gb.handover.id}/sign`, { token: yi, method: 'POST' });
  eq('新单签收成功', r.status, 201);

  console.log('\n[13] 并发原子仲裁：签收 vs 状态变化，只可能"成功签收"或"拒绝并过期"');
  for (let i = 0; i < 8; i++) {
    await resetTraining(admin);
    const gc = await generate(jia);
    const id = gc.handover.id;
    const [sr, cr] = await Promise.all([
      api(`/api/handovers/${id}/sign`, { token: yi, method: 'POST' }),
      api('/api/sections/4/state', { token: bing, method: 'POST', body: { action: 'occupy' } })
    ]);
    eq('状态变化请求始终成功', cr.status, 200);
    ok('签收只可能 201 或 409', sr.status === 201 || sr.status === 409, { i, status: sr.status });
    const after = await getHandover(bing, id);
    if (sr.status === 201) {
      eq('签收成功 ⇒ 单据已签收', after.status, 'signed');
      eq('签收成功 ⇒ 接班人为乙', after.shiftTo, '值班员乙');
    } else {
      eq('签收失败 ⇒ HANDOVER_STALE', sr.data.code, 'HANDOVER_STALE');
      eq('签收失败 ⇒ 单据已过期', after.status, 'expired');
    }
  }

  console.log('\n[14] 并发原子仲裁：两名接班人同时签收同一单，恰好一人成功');
  for (let i = 0; i < 6; i++) {
    await resetTraining(admin);
    const gc = await generate(jia);
    const id = gc.handover.id;
    const [s1, s2] = await Promise.all([
      api(`/api/handovers/${id}/sign`, { token: yi, method: 'POST' }),
      api(`/api/handovers/${id}/sign`, { token: bing, method: 'POST' })
    ]);
    const codes = [s1.status, s2.status].sort().join(',');
    ok('恰好一个 201 一个 409', codes === '201,409', { i, codes });
    const loser = s1.status === 409 ? s1 : s2;
    eq('失败者为已被他人签收', loser.data.code, 'HANDOVER_ALREADY_SIGNED');
    const after = await getHandover(jia, id);
    eq('最终状态已签收', after.status, 'signed');
    ok('最终签收人为乙或丙', ['值班员乙', '值班员丙'].includes(after.shiftTo), after);
  }

  console.log('\n[15] 并发原子仲裁：同一人并发重复签收，均返回同一签收结果');
  for (let i = 0; i < 4; i++) {
    await resetTraining(admin);
    const gc = await generate(jia);
    const id = gc.handover.id;
    const [s1, s2] = await Promise.all([
      api(`/api/handovers/${id}/sign`, { token: yi, method: 'POST' }),
      api(`/api/handovers/${id}/sign`, { token: yi, method: 'POST' })
    ]);
    ok('同一人两次请求均 2xx', [s1.status, s2.status].every((x) => x === 200 || x === 201),
      [s1.status, s2.status]);
    ok('两次结果接班人均为乙',
      s1.data.handover.shiftTo === '值班员乙' && s2.data.handover.shiftTo === '值班员乙');
  }

  console.log('\n[16] 站场重置：未签收单过期，已签收单保留供复盘');
  await resetTraining(admin);
  const keep = await generate(jia);           // 将被签收保留
  await api(`/api/handovers/${keep.handover.id}/sign`, { token: yi, method: 'POST' });
  const p1 = await generate(bing);            // 待签收 → 重置过期
  const p2 = await generate(yi);              // 待签收 → 重置过期
  r = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('清空重置成功', r.status, 200);
  const kAfter = await getHandover(jia, keep.handover.id);
  eq('已签收单保留', kAfter.status, 'signed');
  eq('已签收单接班人仍在', kAfter.shiftTo, '值班员乙');
  ok('已签收单快照仍可复盘', Array.isArray(kAfter.snapshot.sections));
  for (const p of [p1.handover.id, p2.handover.id]) {
    const row = await getHandover(jia, p);
    eq(`待签收单 #${p} 过期`, row.status, 'expired');
    ok(`#${p} 过期原因写明站场重置`, row.expireReason.includes('重置'), row.expireReason);
  }
  // 重置后生成的新单不受影响
  const gAfter = await generate(jia);
  r = await api(`/api/handovers/${gAfter.handover.id}/sign`, { token: bing, method: 'POST' });
  eq('重置后新单可正常签收（重置把区段置未知，快照同样未知）', r.status, 201);

  console.log('\n[17] 重启后记录仍可查询、待签收单可继续签收');
  await resetTraining(admin);
  const persistSigned = await generate(jia);
  await api(`/api/handovers/${persistSigned.handover.id}/sign`,
    { token: yi, method: 'POST' });
  const persistExpired = await generate(bing);
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  await api(`/api/handovers/${persistExpired.handover.id}/sign`,
    { token: yi, method: 'POST' }).catch(() => {});
  const persistPending = await generate(jia);
  await stopServer();
  await startServer(true);
  st = await getState(yi);
  ok('重启后已签收单仍在',
    st.handovers.some((h) => h.id === persistSigned.handover.id && h.status === 'signed'));
  ok('重启后已过期单仍在',
    st.handovers.some((h) => h.id === persistExpired.handover.id && h.status === 'expired'));
  ok('重启后待签收单仍在',
    st.handovers.some((h) => h.id === persistPending.handover.id && h.status === 'pending'));
  // 重启期间状态未变（占用的是区段3，与待签收单之后的快照一致），待签收单可签收
  r = await api(`/api/handovers/${persistPending.handover.id}/sign`,
    { token: bing, method: 'POST' });
  eq('重启后待签收单签收成功（同一时刻原子判定）', r.status, 201);

  console.log(`\n值班交接单全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
