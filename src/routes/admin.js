'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const { getState, triggerWaitingSweep } = require('../interlocking');
const waiting = require('../waiting');
const cancellation = require('../cancellation');
const blockade = require('../blockade');

const router = express.Router();
router.use(requireAuth('admin'));

const ID_RE = /^[A-Za-z0-9_一-龥-]{1,20}$/;
const NUM = (v) => typeof v === 'number' && Number.isFinite(v);

function badId(kind, id) {
  return !id || !ID_RE.test(String(id));
}

/** 有开放进路时禁止改动拓扑（防止改动正在使用的线路） */
function assertNoOpenInstances() {
  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM route_instances WHERE status='open'`).get().n;
  if (n > 0) {
    const err = new Error(`存在 ${n} 条已开放进路，锁闭期间不能修改站场图或进路定义，请待进路解除后再操作`);
    err.status = 409;
    throw err;
  }
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/* --------------------------------- 状态 --------------------------------- */

router.get('/state', (req, res) => {
  res.json({ ok: true, state: getState() });
});

/* ----------------------------- 延时取消设置 ----------------------------- */

// 查询延时取消保护时长（秒）
router.get('/settings/cancel-protection', (req, res) => {
  res.json({
    ok: true,
    protectionSeconds: cancellation.getProtectionSeconds(),
    defaultSeconds: cancellation.DEFAULT_DURATION_SECONDS,
    maxSeconds: cancellation.MAX_DURATION_SECONDS
  });
});

// 修改保护时长（正整数秒；仅影响之后新申请，不追改已有申请）
router.put('/settings/cancel-protection', wrap((req, res) => {
  const seconds = cancellation.setProtectionSeconds((req.body || {}).protectionSeconds);
  res.json({
    ok: true,
    protectionSeconds: seconds,
    note: '已更新；仅对之后提交的延时取消申请生效，已有申请的解除时刻保持不变'
  });
}));

/* -------------------------------- 区段 ---------------------------------- */

function validateSection(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  if (badId('区段', id)) return { error: '区段编号需为 1~20 位字母数字/下划线/中文' };
  for (const k of ['x1', 'y1', 'x2', 'y2']) {
    if (!NUM(body[k])) return { error: `区段 ${id} 坐标 ${k} 必须是数字` };
  }
  return { value: { id, label, x1: body.x1, y1: body.y1, x2: body.x2, y2: body.y2 } };
}

router.post('/sections', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateSection(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  try {
    // 新建区段占用状态未知（按占用处理），需值班员核实清空后方可排路
    db.prepare(`INSERT INTO sections(id,label,x1,y1,x2,y2,occ_state)
                VALUES(@id,@label,@x1,@y1,@x2,@y2,'unknown')`).run(value);
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `区段 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true, section: db.prepare(`SELECT * FROM sections WHERE id=?`).get(value.id) });
}));

router.put('/sections/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateSection(body);
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  const r = db.prepare(`UPDATE sections SET label=@label,x1=@x1,y1=@y1,x2=@x2,y2=@y2 WHERE id=@id`).run(value);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `区段 ${value.id} 不存在` });
  res.json({ ok: true, section: db.prepare(`SELECT * FROM sections WHERE id=?`).get(value.id) });
}));

router.delete('/sections/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const used = db.prepare(`SELECT route_id FROM route_steps WHERE section_id=?`).all(req.params.id);
  if (used.length) {
    return res.status(409).json({ ok: false,
      error: `区段 ${req.params.id} 仍被进路 ${used.map((u) => u.route_id).join('、')} 引用，请先修改这些进路` });
  }
  db.transaction(() => {
    const r = db.prepare(`DELETE FROM sections WHERE id=?`).run(req.params.id);
    if (r.changes === 0) {
      const err = new Error(`区段 ${req.params.id} 不存在`);
      err.status = 404;
      throw err;
    }
    // 区段删除：其未结束封锁同事务标记结束（保留记录与原因）
    blockade.endBySectionDelete(req.params.id);
  })();
  res.json({ ok: true });
}));

/* -------------------------------- 道岔 ---------------------------------- */

function validateSwitch(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  if (badId('道岔', id)) return { error: '道岔编号需为 1~20 位字母数字/下划线/中文' };
  for (const k of ['x', 'y']) {
    if (!NUM(body[k])) return { error: `道岔 ${id} 坐标 ${k} 必须是数字` };
  }
  // 直股/弯股端点为可选项（画图用）
  const coords = {};
  for (const k of ['nx1', 'ny1', 'nx2', 'ny2', 'rx1', 'ry1', 'rx2', 'ry2']) {
    coords[k] = NUM(body[k]) ? body[k] : null;
  }
  return { value: { id, label, x: body.x, y: body.y, ...coords } };
}

router.post('/switches', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateSwitch(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  try {
    db.prepare(`INSERT INTO switches(id,label,x,y,position,nx1,ny1,nx2,ny2,rx1,ry1,rx2,ry2)
                VALUES(@id,@label,@x,@y,'N',@nx1,@ny1,@nx2,@ny2,@rx1,@ry1,@rx2,@ry2)`).run(value);
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `道岔 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true, switch: db.prepare(`SELECT * FROM switches WHERE id=?`).get(value.id) });
}));

router.put('/switches/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateSwitch(body);
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  const r = db.prepare(
    `UPDATE switches SET label=@label,x=@x,y=@y,nx1=@nx1,ny1=@ny1,nx2=@nx2,ny2=@ny2,
            rx1=@rx1,ry1=@ry1,rx2=@rx2,ry2=@ry2 WHERE id=@id`
  ).run(value);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `道岔 ${value.id} 不存在` });
  res.json({ ok: true, switch: db.prepare(`SELECT * FROM switches WHERE id=?`).get(value.id) });
}));

router.delete('/switches/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const used = db.prepare(`SELECT route_id FROM route_switch_reqs WHERE switch_id=?`).all(req.params.id);
  if (used.length) {
    return res.status(409).json({ ok: false,
      error: `道岔 ${req.params.id} 仍被进路 ${[...new Set(used.map((u) => u.route_id))].join('、')} 引用，请先修改这些进路` });
  }
  const r = db.prepare(`DELETE FROM switches WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `道岔 ${req.params.id} 不存在` });
  res.json({ ok: true });
}));

/* -------------------------------- 信号机 -------------------------------- */

function validateSignal(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  const dir = ['right', 'left', 'up', 'down'].includes(body.direction) ? body.direction : 'right';
  if (badId('信号机', id)) return { error: '信号机编号需为 1~20 位字母数字/下划线/中文' };
  if (!NUM(body.x) || !NUM(body.y)) return { error: `信号机 ${id} 坐标必须是数字` };
  return { value: { id, label, x: body.x, y: body.y, direction: dir } };
}

router.post('/signals', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateSignal(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  try {
    db.prepare(`INSERT INTO signals(id,label,x,y,direction) VALUES(@id,@label,@x,@y,@direction)`).run(value);
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `信号机 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true, signal: db.prepare(`SELECT * FROM signals WHERE id=?`).get(value.id) });
}));

router.put('/signals/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateSignal(body);
  if (error) return res.status(400).json({ ok: false, error });
  const db = getDb();
  const r = db.prepare(`UPDATE signals SET label=@label,x=@x,y=@y,direction=@direction WHERE id=@id`).run(value);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `信号机 ${value.id} 不存在` });
  res.json({ ok: true, signal: db.prepare(`SELECT * FROM signals WHERE id=?`).get(value.id) });
}));

router.delete('/signals/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const r = db.prepare(`DELETE FROM signals WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: `信号机 ${req.params.id} 不存在` });
  res.json({ ok: true });
}));

/* --------------------------------- 进路 --------------------------------- */

function validateRoute(body) {
  const id = String(body.id || '').trim();
  const label = String(body.label || id).trim();
  const origin = String(body.origin || '').trim();
  const destination = String(body.destination || '').trim();
  if (badId('进路', id)) return { error: '进路编号需为 1~20 位字母数字/下划线/中文' };
  if (!origin || !destination) return { error: '进路必须填写起点和终点' };
  const steps = Array.isArray(body.steps) ? body.steps.map(String) : [];
  if (steps.length === 0) return { error: '进路至少包含一个区段' };
  if (new Set(steps).size !== steps.length) return { error: '进路区段不能重复' };
  const switchReqs = Array.isArray(body.switchReqs) ? body.switchReqs : [];
  for (const r of switchReqs) {
    if (!r.switchId || !['N', 'R'].includes(r.position)) {
      return { error: '道岔位置要求格式为 {switchId, position: N|R}' };
    }
  }
  const entrySignalId = body.entrySignalId || null;
  return { value: { id, label, origin, destination, entrySignalId, steps,
    switchReqs: [...new Map(switchReqs.map((r) => [String(r.switchId), r.position])).entries()]
      .map(([switchId, position]) => ({ switchId, position })) } };
}

function assertRouteRefs(value) {
  const db = getDb();
  for (const sid of value.steps) {
    if (!db.prepare(`SELECT 1 FROM sections WHERE id=?`).get(sid)) {
      return `进路引用了不存在的区段 ${sid}`;
    }
  }
  for (const r of value.switchReqs) {
    if (!db.prepare(`SELECT 1 FROM switches WHERE id=?`).get(r.switchId)) {
      return `进路引用了不存在的道岔 ${r.switchId}`;
    }
  }
  if (value.entrySignalId &&
      !db.prepare(`SELECT 1 FROM signals WHERE id=?`).get(value.entrySignalId)) {
    return `进路入口信号机 ${value.entrySignalId} 不存在`;
  }
  return null;
}

router.post('/routes', wrap((req, res) => {
  assertNoOpenInstances();
  const { value, error } = validateRoute(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  const refError = assertRouteRefs(value);
  if (refError) return res.status(400).json({ ok: false, error: refError });
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO routes(id,label,origin,destination,entry_signal_id)
                VALUES(@id,@label,@origin,@destination,@entrySignalId)`).run(value);
    value.steps.forEach((sid, i) =>
      db.prepare(`INSERT INTO route_steps(route_id,step_order,section_id) VALUES(?,?,?)`).run(value.id, i + 1, sid));
    value.switchReqs.forEach((r) =>
      db.prepare(`INSERT INTO route_switch_reqs(route_id,switch_id,req_position) VALUES(?,?,?)`)
        .run(value.id, r.switchId, r.position));
  });
  try {
    tx();
  } catch (e) {
    if (String(e.code) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ ok: false, error: `进路 ${value.id} 已存在` });
    }
    throw e;
  }
  res.json({ ok: true });
}));

router.put('/routes/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const body = { ...req.body, id: req.params.id };
  const { value, error } = validateRoute(body);
  if (error) return res.status(400).json({ ok: false, error });
  const refError = assertRouteRefs(value);
  if (refError) return res.status(400).json({ ok: false, error: refError });
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM routes WHERE id=?`).get(value.id);
  if (!exists) return res.status(404).json({ ok: false, error: `进路 ${value.id} 不存在` });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE routes SET label=@label,origin=@origin,destination=@destination,
                entry_signal_id=@entrySignalId WHERE id=@id`).run(value);
    db.prepare(`DELETE FROM route_steps WHERE route_id=?`).run(value.id);
    db.prepare(`DELETE FROM route_switch_reqs WHERE route_id=?`).run(value.id);
    value.steps.forEach((sid, i) =>
      db.prepare(`INSERT INTO route_steps(route_id,step_order,section_id) VALUES(?,?,?)`).run(value.id, i + 1, sid));
    value.switchReqs.forEach((r) =>
      db.prepare(`INSERT INTO route_switch_reqs(route_id,switch_id,req_position) VALUES(?,?,?)`)
        .run(value.id, r.switchId, r.position));
    // 定义变更：该进路既有等待申请全部失效（与新定义可能不符）
    waiting.invalidateByRouteChange(value.id,
      `管理员修改了进路 ${value.id} 的定义，原等待申请失效`);
  });
  tx();
  // 失效的是前项时后项可能因此可以兑现
  triggerWaitingSweep('route_changed');
  res.json({ ok: true });
}));

router.delete('/routes/:id', wrap((req, res) => {
  assertNoOpenInstances();
  const db = getDb();
  const tx = db.transaction(() => {
    // 已解除的历史实例对进路有外键引用；删除定义时一并清理其复盘记录
    // （开放中的实例已在上面被 assertNoOpenInstances 拒绝）。
    db.prepare(`DELETE FROM route_instances WHERE route_id=? AND status='released'`)
      .run(req.params.id);
    const r = db.prepare(`DELETE FROM routes WHERE id=?`).run(req.params.id);
    if (r.changes === 0) {
      // 抛错回滚（无其他写入，仅作 404 判定）
      const err = new Error(`进路 ${req.params.id} 不存在`);
      err.status = 404;
      throw err;
    }
    // 进路删除：相关等待申请失效并说明原因
    waiting.invalidateByRouteDelete(req.params.id);
  });
  try {
    tx();
  } catch (e) {
    if (e && e.status === 404) return res.status(404).json({ ok: false, error: e.message });
    throw e;
  }
  triggerWaitingSweep('route_deleted');
  res.json({ ok: true });
}));

/* ------------------------------ 临时封锁 ------------------------------ */

// 发起临时封锁：按区段编号 + 封锁原因；未知区段/空白原因拒绝；
// 同一区段存在未结束封锁时返回原申请（200，created:false），不产生第二笔
router.post('/blockades', wrap((req, res) => {
  const result = blockade.submitBlockade(
    (req.body || {}).sectionId, (req.body || {}).reason, req.session.name
  );
  res.status(result.created ? 201 : 200).json({
    ok: true,
    created: result.created,
    blockade: result.blockade
  });
}));

// 封锁列表：未结束在前；可选 ?status=pending|active|ended
router.get('/blockades', wrap((req, res) => {
  const status = ['pending', 'active', 'ended'].includes(req.query.status)
    ? req.query.status : null;
  res.json({ ok: true, blockades: blockade.listBlockades({ status }) });
}));

// 结束待生效/已生效封锁；结束后按现有联锁规则重试等待兑现（不改写区段占用状态）
router.post('/blockades/:id/end', wrap((req, res) => {
  const b = blockade.endBlockade(Number(req.params.id));
  res.json({ ok: true, blockade: b });
}));

/* ------------------------------ 推演状态重置 ------------------------------ */

/**
 * 清空推演状态：删除全部进路实例/事件/锁，区段恢复未知（按占用），道岔回定位 N。
 * 拓扑（区段/道岔/信号机/进路定义）保留。
 */
router.post('/reset/state', wrap((req, res) => {
  const db = getDb();
  db.transaction(() => {
    // 先清除待处理的延时取消申请（随后删除实例也会级联清除，这里显式清理语义清晰）
    cancellation.clearAllByReset();
    db.prepare(`DELETE FROM route_instances`).run(); // 级联删除锁与事件
    db.prepare(`UPDATE sections SET occ_state='unknown'`).run();
    db.prepare(`UPDATE switches SET position='N'`).run();
    // 管理员重置推演：撤销全部等待申请
    waiting.cancelAllByReset('管理员清空推演状态，全部等待申请撤销');
    // 管理员重置推演：清除全部临时封锁记录
    blockade.clearAllByReset();
  })();
  res.json({ ok: true, state: getState() });
}));

/**
 * 培训重开：在清空推演状态基础上，把全部区段置为空闲、道岔回定位，
 * 得到"线路空闲、信号关闭"的初始盘面（适合重新开始一轮演练）。
 */
router.post('/reset/training', wrap((req, res) => {
  const db = getDb();
  db.transaction(() => {
    cancellation.clearAllByReset();
    db.prepare(`DELETE FROM route_instances`).run();
    db.prepare(`UPDATE sections SET occ_state='free'`).run();
    db.prepare(`UPDATE switches SET position='N'`).run();
    // 管理员重置推演：撤销全部等待申请
    waiting.cancelAllByReset('管理员恢复示例初始状态（培训重开），全部等待申请撤销');
    // 管理员重置推演：清除全部临时封锁记录
    blockade.clearAllByReset();
  })();
  res.json({ ok: true, state: getState() });
}));

module.exports = router;
