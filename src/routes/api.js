'use strict';

const express = require('express');
const { requireAuth } = require('../auth');
const inter = require('../interlocking');
const waiting = require('../waiting');
const cancellation = require('../cancellation');
const blockade = require('../blockade');
const { InterlockError } = require('../interlocking');

const router = express.Router();
router.use(requireAuth('dispatcher'));

function wrap(fn) {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (e) {
      next(e);
    }
  };
}

// 全量状态（刷新页面后恢复已提交状态）
router.get('/state', (req, res) => {
  res.json({ ok: true, state: inter.getState(), me: req.session.name });
});

// 预检：不产生任何锁
router.post('/routes/:id/check', wrap((req, res) => {
  const result = inter.checkOpen(req.params.id, req.body.switchPositions || {});
  res.json({ ok: true, check: result });
}));

// 开放进路（原子锁定）
router.post('/routes/:id/open', wrap((req, res) => {
  const detail = inter.openRoute(req.params.id, req.body.switchPositions || {}, req.session.name);
  res.json({ ok: true, instance: detail });
}));

// 扳动道岔（锁闭中拒绝）
router.post('/switches/:id/move', wrap((req, res) => {
  const position = String(req.body.position || '').toUpperCase();
  const result = inter.moveSwitch(req.params.id, position, req.session.name);
  res.json({ ok: true, result });
}));

// 排路前独立设置区段占用/清空（主要用于把"未知"核实为空闲）
router.post('/sections/:id/state', wrap((req, res) => {
  const action = String(req.body.action || '');
  if (!['occupy', 'clear'].includes(action)) {
    throw new InterlockError(400, 'BAD_ACTION', 'action 只能是 occupy 或 clear');
  }
  const result = inter.setSectionState(req.params.id, action, req.session.name);
  res.json({ ok: true, result });
}));

// 进路走行：按序号提交占用/清空事件
router.post('/instances/:id/events', wrap((req, res) => {
  const seq = Number(req.body.seq);
  const sectionId = String(req.body.sectionId || '');
  const action = String(req.body.action || '');
  if (!Number.isInteger(seq)) {
    throw new InterlockError(400, 'BAD_SEQ', `事件序号必须是整数（收到 ${req.body.seq}）`);
  }
  const result = inter.submitSectionEvent(
    Number(req.params.id), seq, sectionId, action, req.session.name
  );
  res.json({ ok: true, result });
}));

// 人工解除进路（末段未清空前拒绝）
router.post('/instances/:id/release', wrap((req, res) => {
  const detail = inter.releaseInstance(Number(req.params.id), req.session.name);
  res.json({ ok: true, instance: detail });
}));

/* ------------------------------ 延时取消 ------------------------------ */

// 申请延时取消（仅已开放且尚无走行占用记录的进路）；重复申请返回原 pending
router.post('/instances/:id/cancel-delayed', wrap((req, res) => {
  const result = cancellation.requestCancellation(Number(req.params.id), req.session.name);
  res.status(result.created ? 201 : 200).json({
    ok: true,
    created: result.created,
    cancellation: result.request
  });
}));

// 查看延时取消申请：默认本人全部；?scope=all 全员（值班台仲裁展示）；
// 可选 ?status=pending|released|aborted
router.get('/cancellations', wrap((req, res) => {
  const scope = String(req.query.scope || 'mine');
  const status = ['pending', 'released', 'aborted'].includes(req.query.status)
    ? req.query.status : null;
  const list = cancellation.listRequests({
    applicant: scope === 'all' ? undefined : req.session.name,
    status
  });
  res.json({
    ok: true,
    cancellations: list,
    protectionSeconds: cancellation.getProtectionSeconds(),
    me: req.session.name
  });
}));

/* ------------------------------ 临时封锁（只读） ------------------------------ */

// 查看临时封锁：未结束在前；可选 ?status=pending|active|ended
// （全量状态 /api/state 的 blockades / blockadesBySection 也一并下发）
router.get('/blockades', wrap((req, res) => {
  const status = ['pending', 'active', 'ended'].includes(req.query.status)
    ? req.query.status : null;
  res.json({ ok: true, blockades: blockade.listBlockades({ status }) });
}));

/* ------------------------------ 等待申请 ------------------------------ */

// 提交等待申请（不预锁资源；提交后立即尝试兑现）
router.post('/routes/:id/waiting', wrap((req, res) => {
  const app = waiting.submitApplication(
    req.params.id, req.body.switchPositions || {}, req.session.name
  );
  res.status(201).json({ ok: true, waiting: app });
}));

// 查看等待申请：默认返回本人全部；?scope=all 返回所有人（值班台仲裁展示用）；
// 可选 ?status=waiting|fulfilled|cancelled|invalid
router.get('/waiting', wrap((req, res) => {
  const scope = String(req.query.scope || 'mine');
  const status = ['waiting', 'fulfilled', 'cancelled', 'invalid'].includes(req.query.status)
    ? req.query.status : null;
  const list = waiting.listApplications({
    applicant: scope === 'all' ? undefined : req.session.name,
    status
  });
  res.json({ ok: true, waiting: list, me: req.session.name });
}));

// 撤销本人未兑现的等待申请（非本人 / 已结束均拒绝）
router.post('/waiting/:id/cancel', wrap((req, res) => {
  const app = waiting.cancelApplication(Number(req.params.id), req.session.name);
  res.json({ ok: true, waiting: app });
}));

module.exports = router;
