'use strict';

/* 值班员工作台 */
let STATE = null;
let selectedRouteId = null;
let chosenSwitchPos = {};   // 值班员为当前进路选择的道岔位置
let selectedSection = null; // 右侧手工事件/状态操作用
let pollTimer = null;
let countdownTimer = null;
let clockOffsetMs = 0;      // 服务器时钟 - 本地时钟（倒计时按服务器时间校准）

const svg = document.getElementById('yard');
const side = document.getElementById('side');
const { el, html, api, toast, OCC_TEXT, SIG_TEXT, POS_TEXT } = App;

/* ------------------------------- 初始化 ------------------------------- */

async function boot() {
  document.getElementById('meName').textContent = '值班员：' + App.name();
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('refreshBtn').addEventListener('click', () => load(true));
  if (!App.token() || App.role() !== 'dispatcher') {
    location.href = '/index.html';
    return;
  }
  await load(true);
  pollTimer = setInterval(() => load(false), 2000);
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  App.clearSession();
  location.href = '/index.html';
}

async function load(manual) {
  try {
    const data = await api('/api/state');
    STATE = data.state;
    // 服务器时钟与本地时钟偏差，倒计时据此校准（页面常开也不会漂）
    clockOffsetMs = (Date.parse(STATE.serverTime) || Date.now()) - (STATE.serverTimeMs || Date.now());
    renderYard();
    renderSide();
    const ps = document.getElementById('pollState');
    ps.textContent = '已同步 ' + new Date().toLocaleTimeString();
    startCountdown();
  } catch (e) {
    if (manual) toast(e.message, 'err');
  }
}

/** 每 0.5s 只刷新倒计时文字（不重新拉取状态，避免输入框失焦） */
function startCountdown() {
  if (countdownTimer) return;
  countdownTimer = setInterval(() => {
    document.querySelectorAll('[data-countdown-to]').forEach((node) => {
      const to = Number(node.getAttribute('data-countdown-to'));
      const ms = to - (Date.now() + clockOffsetMs);
      node.textContent = ms <= 0 ? '到期处理中…' : formatRemaining(ms);
    });
  }, 500);
}

function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}

function pendingCancellationOf(instanceId) {
  const all = STATE.pendingCancellations || {};
  return all[String(instanceId)] || all[instanceId] || null;
}

/* ------------------------------ 站场图渲染 ------------------------------ */

function lockedSectionSet() {
  const s = new Map(); // sectionId -> instanceId
  STATE.openInstances.forEach((i) => i.lockedSections.forEach((id) => s.set(id, i.id)));
  return s;
}
function lockedSwitchSet() {
  const s = new Map();
  STATE.openInstances.forEach((i) => i.lockedSwitches.forEach((id) => s.set(id, i.id)));
  return s;
}

function signalLampColor(sig) {
  // 该信号机作为某条开放进路的入口信号：绿，否则红
  const inst = STATE.openInstances.find((i) => {
    const r = STATE.routes.find((rr) => rr.id === i.routeId);
    return r && r.entry_signal_id === sig.id;
  });
  return inst ? { color: inst.signalState === 'green' ? '#1f9d55' : '#d64545', inst: inst.id }
              : { color: '#d64545', inst: null };
}

function currentRouteObj() {
  return STATE.routes.find((r) => r.id === selectedRouteId) || null;
}

function renderYard() {
  svg.innerHTML = '';
  if (!STATE) return;

  const locks = lockedSectionSet();
  const swLocks = lockedSwitchSet();
  const curRoute = currentRouteObj();
  const hiSections = curRoute ? new Set(curRoute.steps.map((s) => s.section_id)) : new Set();
  const hiSwitches = curRoute ? new Set(curRoute.switchReqs.map((s) => s.switch_id)) : new Set();

  // 先画道岔的股道连线（压在区段下方）
  for (const sw of STATE.switches) {
    const locked = swLocks.has(sw.id);
    const req = curRoute && curRoute.switchReqs.find((r) => r.switch_id === sw.id);
    // 定位(直股)线
    if ([sw.nx1, sw.ny1, sw.nx2, sw.ny2].every((v) => v != null)) {
      const activeN = req && req.req_position === 'N';
      svg.appendChild(el('line', {
        x1: sw.nx1, y1: sw.ny1, x2: sw.nx2, y2: sw.ny2,
        class: `sw-line ${locked ? 'locked' : ''} ${activeN ? 'active' : ''}`
      }));
    }
    // 反位(弯股)线
    if ([sw.rx1, sw.ry1, sw.rx2, sw.ry2].every((v) => v != null)) {
      const activeR = req && req.req_position === 'R';
      svg.appendChild(el('line', {
        x1: sw.rx1, y1: sw.ry1, x2: sw.rx2, y2: sw.ry2,
        class: `sw-line ${locked ? 'locked' : ''} ${activeR ? 'active' : ''}`
      }));
    }
  }

  // 区段
  for (const sec of STATE.sections) {
    const lockedBy = locks.get(sec.id);
    const cls = [
      'sec-line',
      `state-${sec.occ_state}`,
      lockedBy ? 'locked' : '',
      !lockedBy && hiSections.has(sec.id) ? 'route-hi' : ''
    ].filter(Boolean).join(' ');
    const line = el('line', { x1: sec.x1, y1: sec.y1, x2: sec.x2, y2: sec.y2, class: cls });
    line.addEventListener('click', () => { selectedSection = sec.id; renderSide(); });
    svg.appendChild(line);

    const mx = (sec.x1 + sec.x2) / 2;
    const my = (sec.y1 + sec.y2) / 2 - 14;
    const tag = el('text', { x: mx, y: my, class: 'tag-label' }, `${sec.id}`);
    tag.addEventListener('click', () => { selectedSection = sec.id; renderSide(); });
    svg.appendChild(tag);

    // 临时封锁标记
    const blk = blockadeOf(sec.id);
    if (blk) {
      const t = el('text', { x: mx, y: (sec.y1 + sec.y2) / 2 + 16, class: 'blk-tag' },
        blk.status === 'active' ? '⊘封锁中' : '⊘封锁待生效');
      t.appendChild(el('title', {}, `临时封锁申请 #${blk.id}：${blk.reason}`));
      svg.appendChild(t);
    }
  }

  // 道岔核心
  for (const sw of STATE.switches) {
    const lockedBy = swLocks.get(sw.id);
    const c = el('circle', {
      cx: sw.x, cy: sw.y, r: 7,
      class: `sw-core ${lockedBy ? 'locked' : ''}`,
      title: `道岔 ${sw.id} 当前位置 ${sw.position}`
    });
    const tip = el('title', {}, `道岔 ${sw.id}（${sw.label}）实际位置 ${sw.position}` +
      (lockedBy ? `，已被进路 #${lockedBy} 锁闭` : ''));
    c.appendChild(tip);
    c.addEventListener('click', () => { selectedSection = null; renderSide(); focusSwitch(sw.id); });
    svg.appendChild(c);
    svg.appendChild(el('text', { x: sw.x, y: sw.y - 14, class: 'sw-label' },
      `${sw.label}${sw.position}`));
  }

  // 信号机：圆圈，上红下绿两盏灯，亮当前灯
  for (const sig of STATE.signals) {
    const lamp = signalLampColor(sig);
    const g = el('g', {});
    g.appendChild(el('circle', { cx: sig.x, cy: sig.y, r: 11, class: 'sig-body' }));
    g.appendChild(el('circle', {
      cx: sig.x, cy: sig.y - 4, r: 3.4, class: 'sig-lamp',
      fill: lamp.color === '#d64545' ? '#d64545' : '#5b2626', stroke: '#8a3030'
    }));
    g.appendChild(el('circle', {
      cx: sig.x, cy: sig.y + 4, r: 3.4, class: 'sig-lamp',
      fill: lamp.color === '#1f9d55' ? '#1f9d55' : '#20503a', stroke: '#2f7a50'
    }));
    const tip = el('title', {},
      `信号机 ${sig.id}：` + (lamp.inst ? `进路 #${lamp.inst} ` + SIG_TEXT[
        STATE.openInstances.find((i) => i.id === lamp.inst).signalState] : '红灯(未开放)'));
    g.appendChild(tip);
    svg.appendChild(g);
    svg.appendChild(el('text', { x: sig.x, y: sig.y + 28, class: 'sig-label' }, sig.label));
  }

  // 已开放进路的列车位置：在当前占用区段上画车头标记
  for (const inst of STATE.openInstances) {
    const occ = inst.events.filter((e) => e.action === 'occupy')
      .filter((e) => !inst.events.some((x) => x.action === 'clear' && x.section_id === e.section_id));
    for (const e of occ) {
      const sec = STATE.sections.find((s) => s.id === e.section_id);
      if (!sec) continue;
      const mx = (sec.x1 + sec.x2) / 2, my = (sec.y1 + sec.y2) / 2;
      svg.appendChild(el('circle', { cx: mx, cy: my, r: 9, fill: '#1d5fd1', opacity: 0.9 }));
      svg.appendChild(el('text', { x: mx, y: my + 4, 'font-size': 11,
        fill: '#fff', 'text-anchor': 'middle', 'pointer-events': 'none' }, '车'));
    }
  }
}

/* ------------------------------- 右侧面板 ------------------------------- */

function renderSide() {
  side.innerHTML = '';
  if (!STATE) return;

  side.appendChild(renderRoutePicker());
  if (currentRouteObj()) {
    side.appendChild(renderRouteOps());
  }
  side.appendChild(renderHandoverPanel());
  side.appendChild(renderBlockadePanel());
  side.appendChild(renderWaitingPanel());
  side.appendChild(renderCancellationPanel());
  side.appendChild(renderSwitchPanel());
  side.appendChild(renderSectionPanel());
  side.appendChild(renderInstances());
}

/* ------------------------------- 值班交接单 ------------------------------- */

const HANDOVER_STATUS = {
  pending: ['amber', '待签收'],
  signed: ['green', '已签收'],
  expired: ['unknown', '已过期']
};

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function renderHandoverPanel() {
  const box = html('div', {});
  box.appendChild(html('div', { class: 'section-title' }, '③ 交接班（交接单）'));

  const genRow = html('div', { class: 'row', style: 'margin:4px 0 8px;' });
  const genBtn = html('button', { class: 'primary small' }, '交班：生成交接单');
  genBtn.addEventListener('click', generateHandover);
  genRow.appendChild(genBtn);
  genRow.appendChild(html('span', { class: 'hint' },
    '快照当前区段占用、道岔位置、开放进路信号/走行进度、等待申请、待处理延时取消与未结束封锁'));
  box.appendChild(genRow);

  const list = STATE.handovers || [];
  if (!list.length) {
    box.appendChild(html('div', { class: 'hint' }, '暂无交接单。交班值班员点上方按钮即可生成（不影响任何正在进行的操作）。'));
    return box;
  }
  list.slice(0, 8).forEach((h) => box.appendChild(renderHandoverCard(h)));
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    '接班人姓名须与交班人不同；生成后上述任一类状态变化，签收将被拒绝、列出变化类别并标记过期，需交班人重新生成。' +
    '站场重置会使未签收单过期，已签收单保留供复盘。'));
  return box;
}

function renderHandoverCard(h) {
  const me = App.name();
  const [cls, txt] = HANDOVER_STATUS[h.status] || ['unknown', h.status];
  const card = html('div', {
    class: `instance-card ${h.shiftFrom === me || h.shiftTo === me ? 'mine' : ''}`,
    id: 'handover-' + h.id
  });

  const head = html('div', { class: 'row' });
  head.appendChild(html('b', {}, `交接单 #${h.id}`));
  head.appendChild(html('span', { class: 'muted' },
    `交班 ${h.shiftFrom}${h.shiftFrom === me ? '（我）' : ''}`));
  head.appendChild(html('span', { class: 'muted' }, '→'));
  head.appendChild(html('span', { class: 'muted' },
    h.shiftTo ? `接班 ${h.shiftTo}${h.shiftTo === me ? '（我）' : ''}` : '未签收'));
  head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
  head.appendChild(html('span', { class: `badge ${cls}` }, txt));
  card.appendChild(head);

  card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
    `生成于 ${fmtTime(h.generatedAt)}` + (h.signedAt ? `；签收于 ${fmtTime(h.signedAt)}` : '')));

  // 交接内容摘要（六类状态计数 + 明细折叠）
  const snap = h.snapshot || {};
  const summary = html('div', { class: 'hint', style: 'margin-top:4px;' });
  summary.appendChild(document.createTextNode(
    `交接内容：区段 ${snap.sections ? snap.sections.length : 0} 个、` +
    `道岔 ${snap.switches ? snap.switches.length : 0} 个、` +
    `开放进路 ${snap.openInstances ? snap.openInstances.length : 0} 条、` +
    `等待申请 ${snap.waiting ? snap.waiting.length : 0} 条、` +
    `待处理延时取消 ${snap.cancellations ? snap.cancellations.length : 0} 条、` +
    `未结束封锁 ${snap.blockades ? snap.blockades.length : 0} 项。`));
  card.appendChild(summary);

  const det = html('details', { style: 'margin-top:4px;' });
  det.appendChild(html('summary', { class: 'hint', style: 'cursor:pointer;' }, '查看交接时完整盘面'));
  det.appendChild(renderHandoverSnapshot(snap));
  card.appendChild(det);

  if (h.expireReason) {
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;color:var(--red);' },
      '过期原因：' + h.expireReason));
  }

  // 操作行
  if (h.status === 'pending') {
    const row = html('div', { class: 'row', style: 'margin-top:6px;' });
    const signBtn = html('button', { class: 'primary small' }, '接班：签收此交接单');
    signBtn.addEventListener('click', () => signHandover(h.id));
    row.appendChild(signBtn);
    if (h.shiftFrom === me) {
      row.appendChild(html('span', { class: 'hint' }, '交班人本人不能签收自己的交接单'));
    } else {
      row.appendChild(html('span', { class: 'hint' }, `以当前值班员 ${me} 名义签收`));
    }
    card.appendChild(row);
  }
  return card;
}

/** 渲染交接单快照明细（只读） */
function renderHandoverSnapshot(snap) {
  const box = html('div', { style: 'margin-top:4px;' });

  box.appendChild(html('div', { class: 'hint' },
    '区段占用：' + (snap.sections || []).map((s) =>
      `${s.id}=${OCC_TEXT[s.occState] || s.occState}`).join('，') || '无'));
  box.appendChild(html('div', { class: 'hint' },
    '道岔位置：' + (snap.switches || []).map((s) => `${s.id}=${s.position}`).join('，') || '无'));

  const insts = snap.openInstances || [];
  if (insts.length) {
    for (const i of insts) {
      box.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
        `开放进路 #${i.id} ${i.routeId}（${i.openedBy}）：信号 ${SIG_TEXT[i.signalState]}，` +
        `下一序号 ${i.nextSeq}，锁闭区段 [${i.lockedSections.join(',')}]，` +
        `锁闭道岔 [${i.lockedSwitches.join(',')}]，走行 ` +
        (i.events.length ? i.events.map((e) =>
          `#${e.seq}${e.action === 'occupy' ? '占' : '清'}${e.sectionId}`).join(',') : '尚无')));
    }
  } else {
    box.appendChild(html('div', { class: 'hint' }, '开放进路：无'));
  }

  box.appendChild(html('div', { class: 'hint' },
    '等待申请：' + ((snap.waiting || []).map((w) =>
      `#${w.id} ${w.routeId}(${w.applicant})`).join('，') || '无')));
  box.appendChild(html('div', { class: 'hint' },
    '待处理延时取消：' + ((snap.cancellations || []).map((c) =>
      `#${c.id} 实例#${c.instanceId}（${c.applicant}，最早解除 ${new Date(c.releaseAt).toLocaleTimeString()}）`).join('，') || '无')));
  box.appendChild(html('div', { class: 'hint' },
    '未结束封锁：' + ((snap.blockades || []).map((b) =>
      `#${b.id} 区段${b.sectionId}(${b.status === 'active' ? '已生效' : '待生效'}，${b.reason})`).join('，') || '无')));
  return box;
}

async function generateHandover() {
  if (!confirm('确认按当前盘面生成交接单？\n将快照区段占用、道岔位置、开放进路信号与走行进度、等待申请、待处理延时取消与未结束封锁。' +
    '\n（不会影响任何正在进行的进路与申请；本人此前未签收的交接单将被新单取代）')) return;
  try {
    const data = await api('/api/handovers', { method: 'POST' });
    const n = (data.superseded || []).length;
    toast(`交接单 #${data.handover.id} 已生成（${n ? `此前 #${data.superseded.join('、#')} 待签收单被取代` : '无待签收单被取代'}），等待接班值班员签收`, 'ok', 6000);
    await load(true);
    setTimeout(() => {
      const node = document.getElementById('handover-' + data.handover.id);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  } catch (e) { toast(e.message, 'err', 7000); }
}

async function signHandover(id) {
  if (!confirm(`签收交接单 #${id}？签收人：${App.name()}。\n` +
    '系统将在同一时刻原子核对生成后的盘面状态；若任一类状态已变化，签收会被拒绝、列出变化类别，该单标记过期，需交班人重新生成。')) return;
  try {
    const data = await api(`/api/handovers/${id}/sign`, { method: 'POST' });
    toast(data.repeated
      ? `你已签收过交接单 #${id}，返回原签收结果（幂等）`
      : `交接单 #${id} 签收成功，接班人 ${data.handover.shiftTo}`, 'ok', 6000);
    await load(true);
  } catch (e) {
    if (e.data && e.data.code === 'HANDOVER_STALE') {
      const changes = (e.data.changes || []).map((c) => `· ${c.label}：${c.detail}`).join('\n');
      toast(`交接单 #${id} 已过期，不能签收：\n${changes || e.message}\n请交班人重新生成。`, 'err', 12000);
    } else {
      toast(e.message, 'err', 7000);
    }
    await load(true);
  }
}

/* ------------------------------- 临时封锁 ------------------------------- */

function blockadeOf(sectionId) {
  return (STATE.blockadesBySection || {})[sectionId] || null;
}

function renderBlockadePanel() {
  const box = html('div', {});
  const all = (STATE.blockades || []).filter((b) => b.status !== 'ended');
  box.appendChild(html('div', { class: 'section-title' }, `临时封锁（管理员发布，${all.length} 项未结束）`));
  if (!all.length) {
    box.appendChild(html('div', { class: 'hint' }, '当前无临时封锁。'));
    return box;
  }
  for (const b of all) {
    const card = html('div', { class: 'instance-card', id: 'blockade-' + b.id });
    const head = html('div', { class: 'row' });
    head.appendChild(html('b', {}, `区段 ${b.sectionId}`));
    head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
    head.appendChild(html('span', { class: `badge ${b.status === 'active' ? 'red' : 'amber'}` },
      b.status === 'active' ? '封锁已生效' : '封锁待生效'));
    card.appendChild(head);
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
      `原因：${b.reason}（申请 #${b.id}，${b.applicant}）`));
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:2px;' },
      '该区段暂不能参与新的预检/开放/等待兑现；已开放进路不受影响。'));
    box.appendChild(card);
  }
  return box;
}

function sectionBadge(sec) {
  const map = { free: ['green', '空闲'], occupied: ['red', '占用'], unknown: ['unknown', '未知'] };
  const [cls, txt] = map[sec.occ_state];
  return html('span', { class: `badge ${cls}` }, txt);
}

function renderRoutePicker() {
  const box = html('div', {});
  box.appendChild(html('div', { class: 'section-title' }, '① 选择进路（起点 → 终点）'));
  const sel = html('select', { style: 'width:100%;' });
  sel.appendChild(html('option', { value: '' }, '— 请选择进路 —'));
  for (const r of STATE.routes) {
    const o = html('option', { value: r.id }, `${r.id} ${r.label}（${r.origin}→${r.destination}）`);
    if (r.id === selectedRouteId) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    selectedRouteId = sel.value || null;
    chosenSwitchPos = {};
    renderSide();
  });
  box.appendChild(sel);
  return box;
}

function renderRouteOps() {
  const r = currentRouteObj();
  const box = html('div', {});

  // 途经区段
  box.appendChild(html('div', { class: 'section-title' }, '② 进路要素'));
  const stepLine = html('div', { class: 'kv' },
    '途经区段：',
    ...r.steps.flatMap((s, idx) => {
      const sec = STATE.sections.find((x) => x.id === s.section_id);
      const blk = blockadeOf(s.section_id);
      const nodes = [html('b', { style: sec.occ_state !== 'free' || blk ? 'color:var(--red)' : '' },
        s.section_id + (blk ? '⊘' : ''))];
      if (blk) {
        nodes.push(html('span', { class: `badge ${blk.status === 'active' ? 'red' : 'amber'}`,
          title: `临时封锁申请 #${blk.id}：${blk.reason}` }, '封锁'));
      }
      if (idx < r.steps.length - 1) nodes.push(document.createTextNode(' → '));
      return nodes;
    })
  );
  box.appendChild(stepLine);

  // 道岔位置选择
  if (r.switchReqs.length) {
    box.appendChild(html('div', { class: 'kv', style: 'margin-top:6px;' }, '道岔位置（按进路要求选择）：'));
    const swWrap = html('div', { class: 'row', style: 'margin-top:4px;' });
    for (const req of r.switchReqs) {
      const sw = STATE.switches.find((x) => x.id === req.switch_id);
      const actual = sw ? sw.position : '?';
      const sel = html('select', {});
      ['N', 'R'].forEach((p) => {
        const o = html('option', { value: p }, `${req.switch_id}=${p === 'N' ? '定位' : '反位'}`);
        if ((chosenSwitchPos[req.switch_id] || req.req_position) === p) o.selected = true;
        sel.appendChild(o);
      });
      // 默认带出进路要求位置
      if (!chosenSwitchPos[req.switch_id]) chosenSwitchPos[req.switch_id] = req.req_position;
      sel.addEventListener('change', () => { chosenSwitchPos[req.switch_id] = sel.value; doCheck(); });
      const actualCls = actual === req.req_position ? 'green' : 'red';
      swWrap.appendChild(html('span', { class: 'kv' },
        sel,
        ' 要求:', html('b', {}, req.req_position),
        ' 实际:', html('span', { class: `badge ${actualCls}` }, actual)));
    }
    box.appendChild(swWrap);
  }

  // 按钮
  const btns = html('div', { class: 'row', style: 'margin-top:10px;' });
  const checkBtn = html('button', { class: 'ghost' }, '预检能否开放');
  const openBtn = html('button', { class: 'primary' }, '开放进路（原子锁闭）');
  const waitBtn = html('button', { class: 'ghost', title: '提交后不预锁资源；条件具备时系统自动按序兑现' },
    '提交等待申请（不预锁）');
  checkBtn.addEventListener('click', doCheck);
  openBtn.addEventListener('click', doOpen);
  waitBtn.addEventListener('click', doWait);
  btns.appendChild(checkBtn);
  btns.appendChild(openBtn);
  btns.appendChild(waitBtn);
  box.appendChild(btns);

  // 预检结果区
  const resultBox = html('div', { id: 'checkResult', style: 'margin-top:8px;' });
  box.appendChild(resultBox);

  async function doCheck() {
    try {
      const data = await api(`/api/routes/${r.id}/check`, {
        method: 'POST', body: JSON.stringify({ switchPositions: chosenSwitchPos })
      });
      renderCheck(data.check);
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderCheck(check) {
    resultBox.innerHTML = '';
    const entry = check.requirements.entrySignal;
    const head = html('div', { class: 'row' },
      '入口信号 ',
      entry ? html('b', {}, entry.id) : html('span', { class: 'muted' }, '(未指定)'),
      ' 预检信号：',
      html('span', { class: `badge ${check.ok ? 'green' : 'red'}` },
        check.ok ? '绿灯 可开放' : '红灯 不可开放')
    );
    resultBox.appendChild(head);

    const ul = html('ul', { class: `reasons ${check.ok ? 'ok' : ''}` });
    if (check.ok) {
      ul.appendChild(html('li', {}, '✓ 沿途区段均空闲、未被其他进路锁定；道岔选择/实际位置全部符合要求，可以开放'));
    } else {
      check.reasons.forEach((reason) => ul.appendChild(html('li', {}, '✗ ' + reason)));
    }
    resultBox.appendChild(ul);
  }

  async function doOpen() {
    if (!confirm(`确认开放进路 ${r.id}（${r.label}）？将原子锁定沿途全部区段与道岔。`)) return;
    try {
      const data = await api(`/api/routes/${r.id}/open`, {
        method: 'POST', body: JSON.stringify({ switchPositions: chosenSwitchPos })
      });
      toast(`进路 #${data.instance.id} 已开放，入口信号转绿`, 'ok');
      await load(true);
      // 定位到新实例的事件提交区
      setTimeout(() => {
        const node = document.getElementById('inst-' + data.instance.id);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    } catch (e) {
      toast(e.message, 'err', 6500);
      doCheck(); // 开放失败后刷新预检原因
    }
  }

  async function doWait() {
    try {
      const data = await api(`/api/routes/${r.id}/waiting`, {
        method: 'POST', body: JSON.stringify({ switchPositions: chosenSwitchPos })
      });
      const w = data.waiting;
      if (w.status === 'fulfilled') {
        toast(`等待申请 #${w.id} 已自动兑现为进路 #${w.instanceId}，入口信号转绿`, 'ok', 5200);
      } else {
        const why = w.blockReasons && w.blockReasons.length
          ? '；当前阻断：' + w.blockReasons[0] : '';
        toast(`等待申请 #${w.id} 已提交（顺位 ${w.position}），不预锁资源${why}`, 'info', 6000);
      }
      await load(true);
      setTimeout(() => {
        const node = document.getElementById('waiting-' + w.id);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    } catch (e) {
      toast(e.message, 'err', 6500);
    }
  }

  return box;
}

/* ------------------------------- 等待申请 ------------------------------- */

const WAITING_STATUS = {
  waiting: ['amber', '等待中'],
  fulfilled: ['green', '已兑现'],
  cancelled: ['unknown', '已撤销'],
  invalid: ['red', '已失效']
};

function renderWaitingPanel() {
  const box = html('div', {});
  box.appendChild(html('div', { class: 'section-title' }, '③ 等待申请（提交后不预锁，自动按序兑现）'));
  const apps = STATE.waitingApplications || [];
  if (!apps.length) {
    box.appendChild(html('div', { class: 'hint' },
      '暂无等待申请。在上方选择进路并核对道岔位置后，可点"提交等待申请（不预锁）"。'));
    return box;
  }
  apps.forEach((w) => box.appendChild(renderWaitingCard(w)));
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    '共享区段/道岔的申请按提交顺序排队（顺位随兑现/撤销前移）；资源互不相交者可先兑现。' +
    '区段状态变化、道岔扳动、进路解除或服务重启后自动尝试兑现。'));
  return box;
}

function renderWaitingCard(w) {
  const mine = w.applicant === App.name();
  const card = html('div', {
    class: `instance-card ${mine ? 'mine' : ''}`,
    id: 'waiting-' + w.id
  });
  const [cls, txt] = WAITING_STATUS[w.status] || ['unknown', w.status];

  const head = html('div', { class: 'row' });
  head.appendChild(html('b', {}, `等待#${w.seq}`));
  head.appendChild(html('span', { class: 'muted' }, `${w.routeId}`));
  head.appendChild(html('span', { class: 'muted' }, `${w.applicant}${mine ? '（我）' : ''}`));
  head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
  if (w.status === 'waiting') {
    head.appendChild(html('span', { class: 'badge amber' }, `顺位 ${w.position}`));
  }
  head.appendChild(html('span', { class: `badge ${cls}` }, txt));
  card.appendChild(head);

  // 道岔选择
  const swText = Object.entries(w.switchPositions)
    .map(([sid, p]) => `${sid}=${p}`).join('，');
  if (swText) card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' }, '道岔选择：' + swText));

  // 阻断原因
  if (w.status === 'waiting' && w.blockReasons && w.blockReasons.length) {
    const ul = html('ul', { class: 'reasons', style: 'margin-top:6px;' });
    w.blockReasons.forEach((reason) => ul.appendChild(html('li', {}, reason)));
    card.appendChild(ul);
  }

  // 兑现结果
  if (w.status === 'fulfilled' && w.instance) {
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
      `已兑现为进路实例 #${w.instance.id}（${w.instance.routeId}，${w.instance.openedBy}），入口信号：`,
      html('span', { class: `badge ${w.instance.signalState === 'green' ? 'green' : 'red'}` },
        w.instance.signalState === 'green' ? '绿灯' : '红灯')));
  }

  // 撤销/失效说明
  if (w.endReason) {
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;color:var(--red);' },
      (w.status === 'invalid' ? '失效原因：' : '说明：') + w.endReason));
  }

  // 本人未兑现可撤销
  if (w.status === 'waiting' && mine) {
    const row = html('div', { class: 'row', style: 'margin-top:6px;' });
    const btn = html('button', { class: 'danger small' }, '撤销本人申请');
    btn.addEventListener('click', () => cancelWaiting(w));
    row.appendChild(btn);
    card.appendChild(row);
  }

  return card;
}

async function cancelWaiting(w) {
  if (!confirm(`撤销等待申请 #${w.seq}（进路 ${w.routeId}）？`)) return;
  try {
    await api(`/api/waiting/${w.id}/cancel`, { method: 'POST' });
    toast(`等待申请 #${w.seq} 已撤销`, 'ok');
    await load(true);
  } catch (e) { toast(e.message, 'err', 6500); }
}

/* ------------------------------- 延时取消 ------------------------------- */

const CANCEL_STATUS = {
  pending: ['amber', '延时取消中'],
  released: ['green', '到期已解除'],
  aborted: ['red', '取消终止·锁闭保留']
};

function renderCancellationPanel() {
  const box = html('div', {});
  box.appendChild(html('div', { class: 'section-title' },
    `④ 延时取消申请（保护时长 ${STATE.cancelProtectionSeconds} 秒）`));
  const all = STATE.cancellationRequests || [];
  const mine = all.filter((c) => c.applicant === App.name());
  const shown = mine.length ? mine : all.slice(0, 6);
  if (!shown.length) {
    box.appendChild(html('div', { class: 'hint' },
      '暂无延时取消申请。对"已开放且尚无走行占用记录"的进路，可在下方进路卡片中点"申请延时取消"。'));
    return box;
  }
  shown.forEach((c) => box.appendChild(renderCancellationCard(c)));
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    '申请后入口信号立即回红、区段与道岔锁继续保留，等待申请不会提前兑现；' +
    '保护期满系统在同一事务内重查（仍开放/无走行占用/沿途区段均空闲）才解除并触发等待兑现，' +
    '条件不符则终止取消并保留锁闭；保护期内收到首段占用事件同样终止。' +
    (mine.length ? '' : '（当前展示全员申请）')));
  return box;
}

function renderCancellationCard(c) {
  const mine = c.applicant === App.name();
  const card = html('div', {
    class: `instance-card ${mine ? 'mine' : ''}`, id: 'cancel-' + c.id
  });
  const [cls, txt] = CANCEL_STATUS[c.status] || ['unknown', c.status];

  const head = html('div', { class: 'row' });
  head.appendChild(html('b', {}, `延时取消#${c.id}`));
  head.appendChild(html('span', { class: 'muted' }, `进路实例 #${c.instanceId}（${c.applicant}${mine ? '·我' : ''}）`));
  head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
  head.appendChild(html('span', { class: `badge ${cls}` }, txt));
  card.appendChild(head);

  const line = html('div', { class: 'hint', style: 'margin-top:4px;' });
  line.appendChild(document.createTextNode(
    `保护时长 ${c.durationSeconds} 秒，申请于 ${new Date(c.requestedAt).toLocaleTimeString()}，` +
    `最早解除 ${new Date(c.releaseAt).toLocaleTimeString()}（`));
  if (c.status === 'pending') {
    line.appendChild(document.createTextNode('剩余 '));
    line.appendChild(html('b', { 'data-countdown-to': String(c.releaseAt) },
      formatRemaining(c.releaseAt - (Date.now() + clockOffsetMs))));
    line.appendChild(document.createTextNode('）'));
  } else {
    line.appendChild(document.createTextNode('已处理）'));
  }
  card.appendChild(line);

  if (c.endReason) {
    card.appendChild(html('div', {
      class: 'hint', style: `margin-top:4px;color:${c.status === 'released' ? 'var(--green)' : 'var(--red)'};`
    }, (c.status === 'released' ? '解除说明：' : '终止原因：') + c.endReason));
  }
  return card;
}

/* ------------------------------- 道岔操作 ------------------------------- */

function focusSwitch(switchId) {
  // 点击图上道岔仅滚动定位到对应操作行（扳动由用户显式操作）
  const node = document.getElementById('sw-row-' + switchId);
  if (node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.style.background = '#fff6e0';
    setTimeout(() => (node.style.background = ''), 1200);
  }
}

function renderSwitchPanel() {
  const box = html('div', {});
  box.appendChild(html('div', { class: 'section-title' }, '⑤ 道岔操作'));
  if (STATE.switches.length === 0) {
    box.appendChild(html('div', { class: 'hint' }, '站场尚无道岔'));
    return box;
  }
  const locks = lockedSwitchSet();
  for (const sw of STATE.switches) {
    const lockedBy = locks.get(sw.id);
    const row = html('div', { class: 'row', id: 'sw-row-' + sw.id,
      style: 'padding:5px 0;border-bottom:1px dotted #e6eaf0;' });
    row.appendChild(html('b', { style: 'width:52px;' }, sw.id));
    row.appendChild(html('span', { class: 'muted', style: 'width:70px;' }, POS_TEXT[sw.position]));
    if (lockedBy) {
      row.appendChild(html('span', { class: 'badge lock' }, `进路#${lockedBy}锁闭`));
    } else {
      const btn = html('button', { class: 'ghost small' },
        '扳至 ' + (sw.position === 'N' ? 'R 反位' : 'N 定位'));
      btn.addEventListener('click', () => moveSwitch(sw, sw.position === 'N' ? 'R' : 'N'));
      row.appendChild(btn);
    }
    box.appendChild(row);
  }
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    '已开放进路锁闭的道岔不能扳动；扳动后请在所选进路中核对位置。'));
  return box;
}

async function moveSwitch(sw, pos) {
  try {
    await api(`/api/switches/${sw.id}/move`, {
      method: 'POST', body: JSON.stringify({ position: pos })
    });
    toast(`道岔 ${sw.id} 已扳至 ${pos}`, 'ok');
    await load(true);
  } catch (e) { toast(e.message, 'err', 6000); }
}

/* --------------------------- 排路前区段状态操作 --------------------------- */

function renderSectionPanel() {
  const box = html('div', {});
  box.appendChild(html('div', { class: 'section-title' }, '区段占用状态（排路前核实）'));
  const locks = lockedSectionSet();

  const selWrap = html('div', { class: 'row' });
  const sel = html('select', {});
  sel.appendChild(html('option', { value: '' }, '选择区段…'));
  for (const s of STATE.sections) {
    const o = html('option', { value: s.id },
      `${s.id}（${OCC_TEXT[s.occ_state]}）${locks.has(s.id) ? ' [锁闭中]' : ''}${blockadeOf(s.id) ? ' [封锁]' : ''}`);
    if (s.id === selectedSection) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { selectedSection = sel.value || null; renderSide(); });
  selWrap.appendChild(sel);
  box.appendChild(selWrap);

  if (selectedSection) {
    const sec = STATE.sections.find((s) => s.id === selectedSection);
    const lockedBy = locks.get(sec.id);
    const blk = blockadeOf(sec.id);
    const info = html('div', { class: 'kv', style: 'margin-top:6px;' },
      '区段 ', html('b', {}, sec.id), ' 当前：', sectionBadge(sec),
      lockedBy ? html('span', { class: 'badge lock', style: 'margin-left:6px;' }, `进路#${lockedBy}锁闭中`) : null,
      blk ? html('span', { class: `badge ${blk.status === 'active' ? 'red' : 'amber'}`,
        style: 'margin-left:6px;', title: `申请 #${blk.id}：${blk.reason}` },
        blk.status === 'active' ? '封锁中' : '封锁待生效') : null);
    box.appendChild(info);
    if (blk) {
      box.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;color:var(--red);' },
        `临时封锁 #${blk.id}：${blk.reason}（该区段暂不能排新进路）`));
    }
    if (!lockedBy) {
      const btns = html('div', { class: 'row', style: 'margin-top:6px;' });
      const occBtn = html('button', { class: 'ghost small' }, '置为占用');
      const clearBtn = html('button', { class: 'ghost small' }, '核实清空（未知→空闲）');
      occBtn.addEventListener('click', () => setSec(sec.id, 'occupy'));
      clearBtn.addEventListener('click', () => setSec(sec.id, 'clear'));
      btns.appendChild(occBtn); btns.appendChild(clearBtn);
      box.appendChild(btns);
    }
    box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
      '新建区段初始为"未知"，联锁按占用处理；值班员现场核实空闲后点"核实清空"方可排路。'));
  }
  return box;
}

async function setSec(id, action) {
  try {
    await api(`/api/sections/${id}/state`, {
      method: 'POST', body: JSON.stringify({ action })
    });
    toast(`区段 ${id} 已${action === 'occupy' ? '置为占用' : '核实为空闲'}`, 'ok');
    await load(true);
  } catch (e) { toast(e.message, 'err', 6000); }
}

/* ----------------------------- 已开放进路 ----------------------------- */

function renderInstances() {
  const box = html('div', {});
  box.appendChild(html('div', { class: 'section-title' }, '⑦ 已开放进路与走行事件'));
  if (STATE.openInstances.length === 0) {
    box.appendChild(html('div', { class: 'hint' }, '当前无已开放进路'));
  }
  STATE.openInstances.forEach((inst) => box.appendChild(renderInstanceCard(inst)));

  if (STATE.recentReleased.length) {
    box.appendChild(html('div', { class: 'section-title' }, '最近解除（复盘）'));
    for (const inst of STATE.recentReleased.slice(0, 3)) {
      box.appendChild(html('div', { class: 'hint' },
        `#${inst.id} ${inst.routeId}（${inst.openedBy}）已解除，共 ${inst.events.length} 个事件`));
    }
  }
  return box;
}

function renderInstanceCard(inst) {
  const mine = inst.openedBy === App.name();
  const card = html('div', { class: `instance-card ${mine ? 'mine' : ''}`, id: 'inst-' + inst.id });
  const route = STATE.routes.find((r) => r.id === inst.routeId);
  const cancelReq = pendingCancellationOf(inst.id);

  const head = html('div', { class: 'row' });
  head.appendChild(html('b', {}, `#${inst.id} ${inst.routeId}`));
  head.appendChild(html('span', { class: 'muted' }, route ? route.label : ''));
  head.appendChild(html('span', { class: 'muted' }, `${inst.openedBy}${mine ? '（我）' : ''}`));
  head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
  head.appendChild(html('span', { class: `badge ${inst.signalState === 'green' ? 'green' : 'red'}` },
    inst.signalState === 'green' ? '信号绿' : '信号红'));
  if (cancelReq) head.appendChild(html('span', { class: 'badge amber' }, '延时取消中'));
  card.appendChild(head);

  // 延时取消状态条：剩余时间实时倒计时 + 最早解除时刻
  if (cancelReq) {
    const bar = html('div', {
      class: 'reasons', id: 'cancel-bar-' + cancelReq.id, style: 'margin-top:8px;'
    });
    const li = html('li', { style: 'background:#fdf4e3;border-color:#ecd2a5;color:#8a520a;' });
    li.appendChild(document.createTextNode(
      `⏳ 延时取消申请 #${cancelReq.id}（${cancelReq.applicant}）：入口信号已回红，区段/道岔锁保留，` +
      '等待期内不会提前兑现；剩余 '));
    li.appendChild(html('b', { 'data-countdown-to': String(cancelReq.releaseAt) },
      formatRemaining(cancelReq.releaseAt - (Date.now() + clockOffsetMs))));
    li.appendChild(document.createTextNode(
      `，最早 ${new Date(cancelReq.releaseAt).toLocaleTimeString()} 解除。` +
      '期间收到首段走行占用即终止取消；到期重查不满足（区段占用/未知）则终止并保留锁闭。'));
    bar.appendChild(li);
    card.appendChild(bar);
  }

  // 区段走行状态表
  const tbl = html('table', { class: 'grid', style: 'margin-top:8px;' });
  tbl.innerHTML = '<tr><th>步</th><th>区段</th><th>锁闭</th><th>占用</th></tr>';
  inst.sections.forEach((s) => {
    const sec = STATE.sections.find((x) => x.id === s.section_id);
    const locked = inst.lockedSections.includes(s.section_id);
    const tr = html('tr', {});
    tr.appendChild(html('td', {}, String(s.step_order)));
    tr.appendChild(html('td', {}, s.section_id));
    tr.appendChild(html('td', {}, html('span', { class: `badge ${locked ? 'lock' : ''}` },
      locked ? '锁闭' : '已解锁')));
    tr.appendChild(html('td', {}, sec ? sectionBadge(sec) : '?'));
    tbl.appendChild(tr);
  });
  card.appendChild(tbl);

  // 下一个事件提示
  const nextSec = inst.sections[inst.headStep - 1];
  const tailSec = inst.sections[inst.tailStep - 1];
  const hint = html('div', { class: 'hint', style: 'margin-top:6px;' });
  hint.appendChild(document.createTextNode(
    `下一序号：${inst.nextSeq}。` +
    (nextSec ? `应提交：占用 区段 ${nextSec.section_id}（进入）；` : '车列已全部进入；') +
    (tailSec ? `或清空 区段 ${tailSec.section_id}（出清并解锁）。` : '')));
  card.appendChild(hint);

  // 事件提交快捷按钮（按当前走行位置生成，保证正确序号）
  const btns = html('div', { class: 'row', style: 'margin-top:6px;' });
  if (nextSec) {
    const b = html('button', { class: 'primary small' },
      `提交 #${inst.nextSeq} 占用 ${nextSec.section_id}`);
    b.addEventListener('click', () => submitEvent(inst, inst.nextSeq, nextSec.section_id, 'occupy'));
    btns.appendChild(b);
  }
  if (tailSec) {
    // tail 紧邻 head（如首段刚进入）时清空首段同样允许：出清即逐段解锁
    const b = html('button', { class: 'ghost small' },
      `提交 #${inst.nextSeq} 清空 ${tailSec.section_id}`);
    b.addEventListener('click', () => submitEvent(inst, inst.nextSeq, tailSec.section_id, 'clear'));
    btns.appendChild(b);
  }
  card.appendChild(btns);

  // 手工事件（用于重传/跳号/异内容等培训验证）
  const manual = html('details', { style: 'margin-top:6px;' });
  const summary = html('summary', { class: 'hint', style: 'cursor:pointer;' },
    '手工提交事件（验证同号重传/同号异内容/跳号拒绝）');
  manual.appendChild(summary);
  const mrow = html('div', { class: 'row', style: 'margin-top:6px;' });
  const seqIn = html('input', { type: 'number', min: '1', value: String(inst.nextSeq), style: 'width:70px;' });
  const secSel = html('select', {});
  inst.sections.forEach((s) => secSel.appendChild(html('option', { value: s.section_id },
    `区段 ${s.section_id}`)));
  const actSel = html('select', {});
  actSel.appendChild(html('option', { value: 'occupy' }, '占用'));
  actSel.appendChild(html('option', { value: 'clear' }, '清空'));
  const send = html('button', { class: 'ghost small' }, '提交');
  send.addEventListener('click', () =>
    submitEvent(inst, Number(seqIn.value), secSel.value, actSel.value));
  mrow.appendChild(html('span', { class: 'hint' }, '序号'));
  mrow.appendChild(seqIn); mrow.appendChild(secSel); mrow.appendChild(actSel); mrow.appendChild(send);
  manual.appendChild(mrow);
  card.appendChild(manual);

  // 事件流水
  if (inst.events.length) {
    const log = html('div', { class: 'hint', style: 'margin-top:6px;' },
      '事件流水：' + inst.events.map((e) =>
        `#${e.seq}${e.action === 'occupy' ? '占' : '清'}${e.section_id}`).join('，'));
    card.appendChild(log);
  }

  // 人工解除（末段未清空会被拒绝）
  const relRow = html('div', { class: 'row', style: 'margin-top:8px;' });
  const rel = html('button', { class: 'danger small' }, '请求人工解除整条进路');
  rel.addEventListener('click', () => release(inst));
  relRow.appendChild(rel);
  relRow.appendChild(html('span', { class: 'hint' }, '末段未清空前将被拒绝'));
  card.appendChild(relRow);

  // 延时取消（仅尚无走行占用记录的开放进路可申请；pending 中按钮禁用）
  const hasOccupy = inst.events.some((e) => e.action === 'occupy');
  const dcRow = html('div', { class: 'row', style: 'margin-top:6px;' });
  const dc = html('button', { class: 'ghost small' },
    cancelReq ? '延时取消申请中…' : '申请延时取消（信号立即回红，锁闭保留）');
  if (cancelReq || hasOccupy) {
    dc.disabled = true;
    dc.title = cancelReq
      ? '该进路已有待处理的延时取消申请，重复申请不会缩短保护期或产生第二笔申请'
      : '已有走行占用记录（车列已进入），不能再申请延时取消';
  } else {
    dc.addEventListener('click', () => requestDelayedCancel(inst));
  }
  dcRow.appendChild(dc);
  dcRow.appendChild(html('span', { class: 'hint' },
    `保护时长 ${STATE.cancelProtectionSeconds} 秒（管理员设置）；到期重查满足条件才解除`));
  card.appendChild(dcRow);

  return card;
}

async function requestDelayedCancel(inst) {
  if (!confirm(`对进路 #${inst.id}（${inst.routeId}）申请延时取消？\n` +
    `入口信号将立即回红，区段与道岔锁继续保留；保护时长 ${STATE.cancelProtectionSeconds} 秒，` +
    '到期重查“仍开放、无走行占用、沿途区段均空闲”后才解除。')) return;
  try {
    const data = await api(`/api/instances/${inst.id}/cancel-delayed`, { method: 'POST' });
    if (data.created) toast('延时取消申请已受理，入口信号已回红', 'ok', 5000);
    else toast(`该进路已有延时取消申请 #${data.cancellation.id}，不缩短期限、不重复申请`, 'info', 5000);
    await load(true);
    setTimeout(() => {
      const node = document.getElementById('cancel-bar-' + data.cancellation.id);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  } catch (e) { toast(e.message, 'err', 7000); }
}

async function submitEvent(inst, seq, sectionId, action) {
  try {
    const data = await api(`/api/instances/${inst.id}/events`, {
      method: 'POST', body: JSON.stringify({ seq, sectionId, action })
    });
    const r = data.result;
    if (r.idempotent) {
      toast(`序号 ${seq} 同号同内容重传：幂等，未重复生效`, 'info', 5000);
    } else if (r.routeReleased) {
      toast(`末段 ${sectionId} 已清空，整条进路 #${inst.id} 自动解除`, 'ok', 5000);
    } else if (r.signalTurnedRed) {
      toast(r.cancellationAborted
        ? `列车进入首段 ${sectionId}，信号已回红；保护期内延时取消申请 #${r.cancellationAborted} 终止，锁闭保留`
        : `列车进入首段 ${sectionId}，信号已回红`, 'ok', 6000);
    } else if (r.sectionUnlocked) {
      toast(`区段 ${sectionId} 已清空并逐段解锁`, 'ok');
    } else {
      toast('事件已接受', 'ok');
    }
    await load(true);
  } catch (e) {
    toast(e.message, 'err', 7000);
    await load(true);
  }
}

async function release(inst) {
  if (!confirm(`请求解除进路 #${inst.id}？末段未清空前联锁将拒绝。`)) return;
  try {
    await api(`/api/instances/${inst.id}/release`, { method: 'POST' });
    toast('进路已解除', 'ok');
    await load(true);
  } catch (e) { toast(e.message, 'err', 7000); }
}

boot();
