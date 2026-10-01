'use strict';

/**
 * 值班交接单。
 *
 * 语义（与需求一一对应）：
 *  - 交班值班员交班时可生成交接单，记录当时的：
 *      ① 区段占用（sections.occ_state，未知按占用）
 *      ② 道岔实际位置（switches.position）
 *      ③ 开放进路的信号与走行进度（open 实例：信号红/绿、事件流水/序号、
 *         head/tail、仍锁闭的区段与道岔）
 *      ④ 等待申请（waiting，含顺位）
 *      ⑤ 延时取消申请（pending 待处理）
 *      ⑥ 未结束封锁（pending/active）
 *    并记录生成时间与交班人。
 *  - 接班值班员可查看并签收：签收人姓名必须与交班人不同；
 *    同一人重复签收返回原结果（幂等），其他人重复签收拒绝。
 *  - 签收时在【同一时刻、同一事务】内重算上述六类状态的指纹并与生成时快照比对：
 *    任一状态发生变化 → 拒绝签收、列出变化类别（细到区段/道岔/实例/申请编号），
 *    并将该单标记为 expired，由交班人重新生成。生成与签收的"快照→判定"原子执行，
 *    better-sqlite3 的同步事务串行化，签收事务与开放/事件/扳岔/申请等写事务
 *    不可能交错，因而并发操作不可能使过时交接单签收成功。
 *  - 交接单不阻塞任何既有操作（开放、走行、等待、取消、封锁均不因交接单改变行为）。
 *  - 站场重置：未签收单标记 expired（写明原因），已签收单保留供复盘。
 *  - 同一交班人再次生成交接单时，其此前尚未签收的交接单标记 expired（被新单取代），
 *    保证"重新生成"语义清晰；其他人的待签收单不受影响。
 *  - 全部落 SQLite，刷新/重启后仍可查询；快照编号仅作文本溯源，不设外键级联。
 */

const crypto = require('crypto');
const { getDb } = require('./db');
const { InterlockError } = require('./interlocking');

const LIST_LIMIT = 100; // 列表上限（最近 100 条），避免全量历史拖大 /api/state

/* ------------------------------ 状态快照 ------------------------------ */

/**
 * 采集六类状态的完整快照（读取全部在同一调用点，生成/签收各在一个事务内调用）。
 * 仅纳入与交接语义相关的稳定字段（阻断原因文案等易变派生信息不纳入指纹）。
 */
function buildSnapshot() {
  const db = getDb();

  // ① 区段占用
  const sections = db.prepare(
    `SELECT id, occ_state FROM sections ORDER BY id`
  ).all().map((s) => ({ id: s.id, occState: s.occ_state }));

  // ② 道岔实际位置
  const switches = db.prepare(
    `SELECT id, position FROM switches ORDER BY id`
  ).all().map((s) => ({ id: s.id, position: s.position }));

  // ③ 开放进路的信号与走行进度
  const openInstances = db.prepare(
    `SELECT id FROM route_instances WHERE status='open' ORDER BY id`
  ).all().map((r) => {
    const inst = require('./interlocking').getInstanceDetail(r.id);
    return {
      id: inst.id,
      routeId: inst.routeId,
      openedBy: inst.openedBy,
      signalState: inst.signalState,
      nextSeq: inst.nextSeq,
      headStep: inst.headStep,
      tailStep: inst.tailStep,
      lockedSections: [...inst.lockedSections].sort(),
      lockedSwitches: [...inst.lockedSwitches].sort(),
      events: inst.events
        .map((e) => ({ seq: e.seq, sectionId: e.section_id, action: e.action }))
        .sort((a, b) => a.seq - b.seq)
    };
  });

  // ④ 等待申请（只与交接语义相关字段；顺位是提交集合的确定性函数，一并快照）
  const waiting = db.prepare(
    `SELECT id, route_id, applicant, switch_positions, status, instance_id
       FROM waiting_applications WHERE status='waiting' ORDER BY id`
  ).all().map((w) => ({
    id: w.id,
    routeId: w.route_id,
    applicant: w.applicant,
    switchPositions: parseJson(w.switch_positions, {}),
    status: w.status,
    instanceId: w.instance_id
  }));

  // ⑤ 待处理延时取消申请
  const cancellations = db.prepare(
    `SELECT id, instance_id, applicant, duration_seconds, requested_at, release_at
       FROM cancellation_applications WHERE status='pending' ORDER BY id`
  ).all().map((c) => ({
    id: c.id,
    instanceId: c.instance_id,
    applicant: c.applicant,
    durationSeconds: c.duration_seconds,
    requestedAt: c.requested_at,
    releaseAt: c.release_at
  }));

  // ⑥ 未结束封锁（待生效/已生效）
  const blockades = db.prepare(
    `SELECT id, section_id, applicant, reason, status
       FROM blockade_applications WHERE status IN ('pending','active') ORDER BY id`
  ).all().map((b) => ({
    id: b.id,
    sectionId: b.section_id,
    applicant: b.applicant,
    reason: b.reason,
    status: b.status
  }));

  return { sections, switches, openInstances, waiting, cancellations, blockades };
}

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/**
 * 规范化 JSON：对象键递归排序，保证同一逻辑状态在任何插入顺序下指纹一致。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** 六类状态指纹：对规范化快照取 SHA-256 */
function digestOf(snapshot) {
  return crypto.createHash('sha256').update(stableStringify(snapshot), 'utf8').digest('hex');
}

/* ------------------------------ 变化类别比对 ------------------------------ */

const CATEGORY_LABELS = {
  sections: '区段占用',
  switches: '道岔位置',
  openRoutes: '开放进路的信号与走行进度',
  waiting: '等待申请',
  cancellations: '延时取消申请',
  blockades: '未结束封锁'
};

/**
 * 比对生成时快照与当前快照，列出全部变化类别（含明细，供拒绝签收时展示）。
 * @returns {Array<{category:string, label:string, detail:string}>}
 */
function diffSnapshots(before, now) {
  const changes = [];

  // ① 区段占用
  const secNow = new Map(now.sections.map((s) => [s.id, s.occState]));
  const secBefore = new Map(before.sections.map((s) => [s.id, s.occState]));
  const secDetails = [];
  for (const [id, st] of secBefore) {
    if (!secNow.has(id)) secDetails.push(`区段 ${id} 已删除（原状态：${occText(st)}）`);
    else if (secNow.get(id) !== st) secDetails.push(`区段 ${id}：${occText(st)} → ${occText(secNow.get(id))}`);
  }
  for (const id of secNow.keys()) {
    if (!secBefore.has(id)) secDetails.push(`区段 ${id}：新增（当前 ${occText(secNow.get(id))}）`);
  }
  if (secDetails.length) changes.push(change('sections', secDetails.join('；')));

  // ② 道岔位置
  const swNow = new Map(now.switches.map((s) => [s.id, s.position]));
  const swBefore = new Map(before.switches.map((s) => [s.id, s.position]));
  const swDetails = [];
  for (const [id, pos] of swBefore) {
    if (!swNow.has(id)) swDetails.push(`道岔 ${id} 已删除（原位置 ${pos}）`);
    else if (swNow.get(id) !== pos) swDetails.push(`道岔 ${id}：${pos} → ${swNow.get(id)}`);
  }
  for (const id of swNow.keys()) {
    if (!swBefore.has(id)) swDetails.push(`道岔 ${id}：新增（当前位置 ${swNow.get(id)}）`);
  }
  if (swDetails.length) changes.push(change('switches', swDetails.join('；')));

  // ③ 开放进路的信号与走行进度
  const instNow = new Map(now.openInstances.map((i) => [i.id, i]));
  const instBefore = new Map(before.openInstances.map((i) => [i.id, i]));
  const instDetails = [];
  for (const [id, b] of instBefore) {
    const n = instNow.get(id);
    if (!n) {
      instDetails.push(`进路实例 #${id}（${b.routeId}）已解除/不存在`);
      continue;
    }
    const parts = [];
    if (b.signalState !== n.signalState) {
      parts.push(`信号 ${sigText(b.signalState)} → ${sigText(n.signalState)}`);
    }
    if (b.nextSeq !== n.nextSeq || b.headStep !== n.headStep || b.tailStep !== n.tailStep) {
      parts.push(`走行进度 (下一序号 ${b.nextSeq}/${n.nextSeq}，` +
        `可进入步 ${b.headStep}/${n.headStep}，可出清步 ${b.tailStep}/${n.tailStep})`);
    }
    if (!sameOrdered(b.events, n.events, (x) => `${x.seq}:${x.sectionId}:${x.action}`)) {
      parts.push(`走行事件 ${describeEvents(b.events)} → ${describeEvents(n.events)}`);
    }
    if (!sameSet(b.lockedSections, n.lockedSections)) {
      parts.push(`锁闭区段 [${b.lockedSections.join(',')}] → [${n.lockedSections.join(',')}]`);
    }
    if (!sameSet(b.lockedSwitches, n.lockedSwitches)) {
      parts.push(`锁闭道岔 [${b.lockedSwitches.join(',')}] → [${n.lockedSwitches.join(',')}]`);
    }
    if (parts.length) instDetails.push(`进路实例 #${id}（${b.routeId}）：` + parts.join('；'));
  }
  for (const [id, n] of instNow) {
    if (!instBefore.has(id)) {
      instDetails.push(`新增开放进路实例 #${id}（${n.routeId}，${n.openedBy}，信号${sigText(n.signalState)}）`);
    }
  }
  if (instDetails.length) changes.push(change('openRoutes', instDetails.join('；')));

  // ④ 等待申请
  const waitDetails = diffEntitySet(before.waiting, now.waiting,
    (w) => `等待申请 #${w.id}（进路 ${w.routeId}，${w.applicant}）`,
    (b, n) => {
      const parts = [];
      if (b.status !== n.status) parts.push(`状态 ${b.status} → ${n.status}`);
      if (b.instanceId !== n.instanceId) {
        parts.push(`兑现实例 ${b.instanceId === null ? '无' : '#' + b.instanceId} → ` +
          `${n.instanceId === null ? '无' : '#' + n.instanceId}`);
      }
      return parts.join('；');
    },
    (w) => w.id);
  if (waitDetails.length) changes.push(change('waiting', waitDetails.join('；')));

  // ⑤ 延时取消申请（待处理集合的出现/消失）
  const cancelDetails = diffEntitySet(before.cancellations, now.cancellations,
    (c) => `延时取消申请 #${c.id}（实例 #${c.instanceId}，${c.applicant}，` +
      `最早解除 ${new Date(c.releaseAt).toLocaleString()}）`,
    (b, n) => {
      const parts = [];
      if (b.releaseAt !== n.releaseAt) parts.push(`最早解除时刻变化`);
      if (b.instanceId !== n.instanceId) parts.push(`所属实例 #${b.instanceId} → #${n.instanceId}`);
      return parts.join('；');
    },
    (c) => c.id);
  if (cancelDetails.length) changes.push(change('cancellations', cancelDetails.join('；')));

  // ⑥ 未结束封锁
  const blkDetails = diffEntitySet(before.blockades, now.blockades,
    (b) => `封锁申请 #${b.id}（区段 ${b.sectionId}，${b.status === 'active' ? '已生效' : '待生效'}，原因：${b.reason}）`,
    (b, n) => {
      if (b.status !== n.status) {
        return `区段 ${n.sectionId} 封锁状态 ${b.status === 'active' ? '已生效' : '待生效'} → ` +
          `${n.status === 'active' ? '已生效' : '待生效'}`;
      }
      return null;
    },
    (b) => b.id);
  if (blkDetails.length) changes.push(change('blockades', blkDetails.join('；')));

  return changes;
}

function change(category, detail) {
  return { category, label: CATEGORY_LABELS[category] || category, detail };
}

function occText(st) {
  return st === 'free' ? '空闲' : st === 'occupied' ? '占用' : '未知(按占用)';
}
function sigText(st) {
  return st === 'green' ? '绿灯' : '红灯';
}
function describeEvents(events) {
  if (!events.length) return '无';
  return events.map((e) => `#${e.seq}${e.action === 'occupy' ? '占' : '清'}${e.sectionId}`).join(',');
}
function sameSet(a, b) {
  return a.length === b.length && a.every((v) => b.includes(v));
}
function sameOrdered(a, b, key) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => key(v) === key(b[i]));
}
/**
 * 按编号比对两个实体集合（Map 按 id 对齐）：消失/新增/同一 id 内容变化。
 * @param {Function} describe 实体 → 人类可读描述
 * @param {Function} compare (before, now) → 变化说明；null 表示无变化
 * @param {Function} keyOf 实体 → 编号
 */
function diffEntitySet(before, now, describe, compare, keyOf) {
  const details = [];
  const nowMap = new Map(now.map((x) => [keyOf(x), x]));
  const beforeIds = new Set(before.map(keyOf));
  for (const b of before) {
    const n = nowMap.get(keyOf(b));
    if (!n) {
      details.push(`${describe(b)} 已结束/消失`);
    } else {
      const text = compare(b, n);
      if (text) details.push(`${describe(b)}：${text}`);
    }
  }
  for (const n of now) {
    if (!beforeIds.has(keyOf(n))) details.push(`${describe(n)} 新增`);
  }
  return details;
}

/* -------------------------------- 生成 -------------------------------- */

/**
 * 交班人生成交接单：同一事务内采集六类状态、写完整快照与指纹；
 * 同一交班人此前未签收的交接单标记为"被新单取代"（其他人的待签收单不动）。
 * @returns {{handover:Object, superseded:number[]}}
 */
function generateHandover(fromName) {
  const db = getDb();
  const generatedAt = Date.now();

  const run = db.transaction(() => {
    const snapshot = buildSnapshot();
    const digest = digestOf(snapshot);

    // 本人此前待签收单：被本单取代（交接单不阻塞操作，允许随时重新生成）
    const supersededRows = db.prepare(
      `SELECT id FROM handover_documents WHERE shift_from=? AND status='pending' ORDER BY id`
    ).all(fromName);
    const superseded = supersededRows.map((r) => r.id);
    if (superseded.length) {
      db.prepare(
        `UPDATE handover_documents SET status='expired', expire_reason='交班人重新生成交接单，本单被新单取代'
          WHERE id IN (${superseded.map(() => '?').join(',')})`
      ).run(...superseded);
    }

    const info = db.prepare(
      `INSERT INTO handover_documents
         (shift_from, shift_to, status, generated_at, snapshot, digest)
       VALUES(?, NULL, 'pending', ?, ?, ?)`
    ).run(fromName, generatedAt, JSON.stringify(snapshot), digest);

    return { id: Number(info.lastInsertRowid), superseded };
  });

  const { id, superseded } = run();
  return { handover: getHandover(id), superseded };
}

/* -------------------------------- 签收 -------------------------------- */

/**
 * 接班人签收交接单。全部判定在单个同步事务内完成（只读判定 + 必要写入一次提交），
 * 事务函数只返回结论、不在内部抛业务错误（否则 better-sqlite3 会把"标记过期"
 * 的写入一并回滚）；提交后由调用方根据结论返回结果或在事务外抛出对应错误。
 *  1) 单据存在性；
 *  2) 接班人姓名必须与交班人不同；
 *  3) 已签收：同一人重复签收返回原结果（signed，repeated:true），其他人拒绝；
 *  4) 已过期：拒绝（附过期原因与变化类别）；
 *  5) 重算当前六类状态指纹与生成时比对：不一致 → 拒绝、列出变化类别、标记过期；
 *  6) 一致 → 原子写入签收人与签收时刻。
 *
 * @returns {{handover:Object, repeated:boolean}}
 */
function signHandover(handoverId, toName) {
  const db = getDb();
  const signedAt = Date.now();

  const run = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM handover_documents WHERE id=?`).get(handoverId);
    if (!row) return { kind: 'not_found', handoverId };
    if (!toName || !String(toName).trim()) return { kind: 'signer_required' };
    if (toName === row.shift_from) {
      return { kind: 'same_person', id: row.id, shiftFrom: row.shift_from, shiftTo: toName };
    }

    // 已签收：同一人重复签收返回原结果，其他人重复签收拒绝
    if (row.status === 'signed') {
      return row.shift_to === toName
        ? { kind: 'repeated', id: row.id }
        : { kind: 'already_signed', id: row.id, signedBy: row.shift_to };
    }

    if (row.status === 'expired') {
      return { kind: 'expired', id: row.id, expireReason: row.expire_reason };
    }

    // 原子判定：在本事务此刻重算指纹，与生成时快照比对
    const before = parseJson(row.snapshot, null);
    const nowSnapshot = buildSnapshot();
    const changes = before ? diffSnapshots(before, nowSnapshot) : [];
    if (digestOf(nowSnapshot) !== row.digest || changes.length) {
      // 关键：标记过期必须随本事务提交成功，故先写入、返回结论，事务外再抛错
      db.prepare(
        `UPDATE handover_documents SET status='expired', expire_reason=? WHERE id=?`
      ).run('生成后站场状态已变化，签收时校验未通过，本单标记过期；请交班人重新生成', row.id);
      return { kind: 'stale', id: row.id, changes };
    }

    db.prepare(
      `UPDATE handover_documents SET status='signed', shift_to=?, signed_at=? WHERE id=?`
    ).run(toName, signedAt, row.id);
    return { kind: 'signed', id: row.id };
  });

  const result = run();

  switch (result.kind) {
    case 'not_found':
      throw new InterlockError(404, 'HANDOVER_NOT_FOUND',
        `交接单 ${result.handoverId} 不存在`, { handoverId: result.handoverId });
    case 'signer_required':
      throw new InterlockError(400, 'HANDOVER_SIGNER_REQUIRED', '签收需要接班人姓名');
    case 'same_person':
      throw new InterlockError(400, 'HANDOVER_SAME_PERSON',
        `接班值班员（${result.shiftTo}）与交班值班员（${result.shiftFrom}）为同一人，不能自行签收交接单 #${result.id}；` +
        '请由另一名值班员签收',
        { handoverId: result.id, shiftFrom: result.shiftFrom });
    case 'already_signed':
      throw new InterlockError(409, 'HANDOVER_ALREADY_SIGNED',
        `交接单 #${result.id} 已由值班员 ${result.signedBy} 签收，其他人不能重复签收`,
        { handoverId: result.id, signedBy: result.signedBy });
    case 'expired':
      throw new InterlockError(409, 'HANDOVER_EXPIRED',
        `交接单 #${result.id} 已过期（${result.expireReason || '状态已变化'}），不能签收，请由交班人重新生成`,
        { handoverId: result.id, expireReason: result.expireReason, changes: [] });
    case 'stale':
      throw new InterlockError(409, 'HANDOVER_STALE',
        `交接单 #${result.id} 自生成后站场状态已变化，签收被拒绝，本单已标记过期；` +
        `变化类别：${result.changes.map((c) => c.label).join('、') || '未知'}；请交班人核对后重新生成`,
        { handoverId: result.id, changes: result.changes });
    case 'repeated':
      return { handover: getHandover(result.id), repeated: true };
    case 'signed':
      return { handover: getHandover(result.id), repeated: false };
    default:
      throw new Error('未知签收结论: ' + result.kind);
  }
}

/* ------------------------ 站场重置：未签收单过期 ------------------------ */

/**
 * 管理员重置推演：全部未签收交接单标记过期（已签收单保留供复盘）。
 * 应在重置事务内调用。
 */
function expirePendingByReset(reasonText) {
  getDb().prepare(
    `UPDATE handover_documents SET status='expired', expire_reason=?
      WHERE status='pending'`
  ).run(reasonText || '站场重置，未签收交接单过期');
  return true;
}

/* ------------------------------ 查询 / 快照 ------------------------------ */

function rowToHandover(row) {
  if (!row) return null;
  const snapshot = parseJson(row.snapshot, null);
  return {
    id: row.id,
    shiftFrom: row.shift_from,
    shiftTo: row.shift_to,
    status: row.status,                // pending / signed / expired
    generatedAt: row.generated_at,
    signedAt: row.signed_at,
    expireReason: row.expire_reason,
    digest: row.digest,
    snapshot,                          // 完整快照（查看交接内容/复盘）
    createdAt: row.created_at
  };
}

function getHandover(id) {
  return rowToHandover(getDb().prepare(`SELECT * FROM handover_documents WHERE id=?`).get(id));
}

/**
 * 交接单列表：待签收在前（新→旧），已签收/已过期在后（新→旧）。
 * @param {{status?:string, shiftFrom?:string, shiftTo?:string, limit?:number}} filter
 */
function listHandovers(filter = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (filter.status) { where.push('status=?'); params.push(filter.status); }
  if (filter.shiftFrom) { where.push('shift_from=?'); params.push(filter.shiftFrom); }
  if (filter.shiftTo) { where.push('shift_to=?'); params.push(filter.shiftTo); }
  const limit = Math.min(Number(filter.limit) || LIST_LIMIT, 500);
  const sql = `SELECT * FROM handover_documents
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                        CASE status WHEN 'pending' THEN -id ELSE -id END, id DESC
               LIMIT ${limit}`;
  return db.prepare(sql).all(...params).map(rowToHandover);
}

/** 最近交接单（随 /api/state 下发，值班台交接面板据此渲染） */
function recentHandovers(limit = 30) {
  return listHandovers({ limit });
}

module.exports = {
  buildSnapshot,
  digestOf,
  stableStringify,
  diffSnapshots,
  CATEGORY_LABELS,
  generateHandover,
  signHandover,
  expirePendingByReset,
  getHandover,
  listHandovers,
  recentHandovers,
  LIST_LIMIT
};
