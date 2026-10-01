'use strict';

const express = require('express');
const { requireAuth } = require('../auth');
const inter = require('../interlocking');
const waiting = require('../waiting');
const cancellation = require('../cancellation');
const blockade = require('../blockade');
const handover = require('../handover');
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

/* ------------------------------ 值班交接单 ------------------------------ */

// 交班：生成交接单（记录当时六类状态快照与生成时间、交班人；
// 同一交班人此前未签收单标记为被新单取代）。交接单不阻塞任何既有操作。
router.post('/handovers', wrap((req, res) => {
  const result = handover.generateHandover(req.session.name);
  res.status(201).json({
    ok: true,
    handover: result.handover,
    superseded: result.superseded
  });
}));

// 查看交接单列表（值班台全员可见）：
// ?status=pending|signed|expired；?mine=1 仅本人交班或接班相关；?scope=all 显式全员（默认即全员）
router.get('/handovers', wrap((req, res) => {
  const status = ['pending', 'signed', 'expired'].includes(req.query.status)
    ? req.query.status : null;
  const filter = { status };
  if (String(req.query.mine || '') === '1') {
    // 本人相关（交班或接班），在服务层过滤
    const name = req.session.name;
    const list = handover.listHandovers({ status })
      .filter((h) => h.shiftFrom === name || h.shiftTo === name);
    return res.json({ ok: true, handovers: list, me: name });
  }
  res.json({ ok: true, handovers: handover.listHandovers(filter), me: req.session.name });
}));

// 查看单张交接单（含完整快照，供接班值班员核对/复盘）
router.get('/handovers/:id', wrap((req, res) => {
  const h = handover.getHandover(Number(req.params.id));
  if (!h) throw new InterlockError(404, 'HANDOVER_NOT_FOUND',
    `交接单 ${req.params.id} 不存在`);
  res.json({ ok: true, handover: h, me: req.session.name });
}));

// 接班：签收交接单（签收人即当前登录值班员，姓名须与交班人不同；
// 同一人重复签收返回原结果，其他人重复签收拒绝；状态变化则拒绝、列变化类别并标记过期。
// 生成与签收的"快照采集→指纹判定→落库"在同一 SQLite 同步事务内原子完成。
router.post('/handovers/:id/sign', wrap((req, res) => {
  const result = handover.signHandover(Number(req.params.id), req.session.name);
  res.status(result.repeated ? 200 : 201).json({
    ok: true,
    handover: result.handover,
    repeated: result.repeated
  });
}));

module.exports = router;
