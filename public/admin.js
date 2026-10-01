'use strict';

/* 管理员工作台：绘制站场图、定义进路、重置推演状态 */
let STATE = null;
let tool = 'select';
let drawFirst = null;        // 画区段时的第一个端点
let routeBuilder = null;     // {steps:[sectionId], switches:[{switchId,position}]}
let editing = null;          // 当前右键/点击编辑对象

const svg = document.getElementById('yard');
const side = document.getElementById('side');
const { el, html, api, toast, OCC_TEXT } = App;

async function boot() {
  document.getElementById('meName').textContent = '管理员';
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('refreshBtn').addEventListener('click', () => load(true));
  if (!App.token() || App.role() !== 'admin') {
    location.href = '/index.html';
    return;
  }
  await load(true);
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  App.clearSession();
  location.href = '/index.html';
}

async function load(manual) {
  try {
    const data = await api('/api/admin/state');
    STATE = data.state;
    drawFirst = null;
    renderYard();
    renderSide();
  } catch (e) { if (manual) toast(e.message, 'err'); }
}

/* ============================== 站场图绘制 ============================== */

function renderYard() {
  svg.innerHTML = '';
  svg.onclick = onSvgClick;

  // 道岔股道线
  for (const sw of STATE.switches) {
    if ([sw.nx1, sw.ny1, sw.nx2, sw.ny2].every((v) => v != null)) {
      svg.appendChild(el('line', { x1: sw.nx1, y1: sw.ny1, x2: sw.nx2, y2: sw.ny2, class: 'sw-line' }));
    }
    if ([sw.rx1, sw.ry1, sw.rx2, sw.ry2].every((v) => v != null)) {
      svg.appendChild(el('line', { x1: sw.rx1, y1: sw.ry1, x2: sw.rx2, y2: sw.ry2, class: 'sw-line' }));
    }
  }

  // 区段
  for (const sec of STATE.sections) {
    const line = el('line', {
      x1: sec.x1, y1: sec.y1, x2: sec.x2, y2: sec.y2,
      class: `sec-line state-${sec.occ_state}`,
      'data-id': sec.id
    });
    line.addEventListener('click', (ev) => { ev.stopPropagation(); onEntityClick('section', sec.id); });
    svg.appendChild(line);
    svg.appendChild(el('text', {
      x: (sec.x1 + sec.x2) / 2, y: (sec.y1 + sec.y2) / 2 - 14, class: 'tag-label'
    }, sec.id));
    // 临时封锁标记
    const blk = (STATE.blockadesBySection || {})[sec.id];
    if (blk) {
      const t = el('text', {
        x: (sec.x1 + sec.x2) / 2, y: (sec.y1 + sec.y2) / 2 + 16, class: 'blk-tag'
      }, blk.status === 'active' ? '⊘封锁中' : '⊘封锁待生效');
      t.appendChild(el('title', {}, `临时封锁申请 #${blk.id}：${blk.reason}`));
      svg.appendChild(t);
    }
  }

  // 道岔
  for (const sw of STATE.switches) {
    const c = el('circle', { cx: sw.x, cy: sw.y, r: 8, class: 'sw-core' });
    c.addEventListener('click', (ev) => { ev.stopPropagation(); onEntityClick('switch', sw.id); });
    c.appendChild(el('title', {}, `道岔 ${sw.id}，点击编辑/删除`));
    svg.appendChild(c);
    svg.appendChild(el('text', { x: sw.x, y: sw.y - 14, class: 'sw-label' }, `${sw.label}${sw.position}`));
  }

  // 信号机
  for (const sig of STATE.signals) {
    const g = el('g', {});
    g.appendChild(el('rect', {
      x: sig.x - 6, y: sig.y - 10, width: 12, height: 20, rx: 3, class: 'sig-body'
    }));
    g.appendChild(el('circle', { cx: sig.x, cy: sig.y - 4, r: 2.8, fill: '#d64545' }));
    g.appendChild(el('circle', { cx: sig.x, cy: sig.y + 4, r: 2.8, fill: '#20503a' }));
    g.addEventListener('click', (ev) => { ev.stopPropagation(); onEntityClick('signal', sig.id); });
    g.appendChild(el('title', {}, `信号机 ${sig.id}，点击编辑/删除`));
    svg.appendChild(g);
    svg.appendChild(el('text', { x: sig.x, y: sig.y + 28, class: 'sig-label' }, sig.label));
  }

  // 画区段时的第一个端点标记
  if (drawFirst) {
    svg.appendChild(el('circle', {
      cx: drawFirst.x, cy: drawFirst.y, r: 6, fill: '#1d5fd1', 'pointer-events': 'none'
    }));
  }

  // 进路构建高亮
  if (routeBuilder) {
    for (const sid of routeBuilder.steps) {
      const sec = STATE.sections.find((s) => s.id === sid);
      if (sec) svg.appendChild(el('line', {
        x1: sec.x1, y1: sec.y1, x2: sec.x2, y2: sec.y2,
        class: 'sec-line route-hi', style: 'pointer-events:none;'
      }));
    }
  }
}

function svgPoint(ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** 吸附到既有区段端点（方便把区段接起来） */
function snapEndpoint(p) {
  for (const sec of STATE.sections) {
    for (const [x, y] of [[sec.x1, sec.y1], [sec.x2, sec.y2]]) {
      if (Math.hypot(x - p.x, y - p.y) <= 24) return { x, y, snapped: true };
    }
  }
  return { ...p, snapped: false };
}

function onSvgClick(ev) {
  if (tool === 'select') return;
  const raw = svgPoint(ev);

  if (tool === 'draw-section') {
    if (!drawFirst) {
      drawFirst = snapEndpoint(raw);
      toast(drawFirst.snapped ? '已吸附到既有端点，再点一下确定区段终点'
                              : '已确定起点，再点一下确定区段终点', 'info', 2600);
      renderYard();
      return;
    }
    const end = snapEndpoint(raw);
    openSectionModal(null, { x1: drawFirst.x, y1: drawFirst.y, x2: end.x, y2: end.y });
    drawFirst = null;
    renderYard();
    return;
  }

  if (tool === 'draw-switch') { openSwitchModal(null, { x: raw.x, y: raw.y }); return; }
  if (tool === 'draw-signal') { openSignalModal(null, { x: raw.x, y: raw.y }); return; }

  // 进路构建模式：点击区段加入/移除路径（只做局部刷新，避免输入框失焦）
  if (tool === 'build-route' && routeBuilder) {
    // 找到点击位置附近的区段
    const hit = nearestSection(raw, 16);
    if (hit) {
      const idx = routeBuilder.steps.indexOf(hit.id);
      if (idx >= 0) {
        // 只允许移除最后一段
        if (idx === routeBuilder.steps.length - 1) routeBuilder.steps.pop();
        else toast('只能从末尾移除区段', 'err');
      } else {
        routeBuilder.steps.push(hit.id);
      }
      renderYard();
      refreshBuilderSteps();
    }
  }
}

function nearestSection(p, maxDist) {
  let best = null, bestD = maxDist;
  for (const sec of STATE.sections) {
    const d = distToSegment(p, sec);
    if (d < bestD) { bestD = d; best = sec; }
  }
  return best;
}

function distToSegment(p, s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = s.x1 + t * dx, y = s.y1 + t * dy;
  return Math.hypot(p.x - x, p.y - y);
}

function onEntityClick(kind, id) {
  if (tool === 'select') {
    if (kind === 'section') {
      openSectionModal(STATE.sections.find((s) => s.id === id));
    } else if (kind === 'switch') {
      openSwitchModal(STATE.switches.find((s) => s.id === id));
    } else if (kind === 'signal') {
      openSignalModal(STATE.signals.find((s) => s.id === id));
    }
  } else if (tool === 'build-route' && routeBuilder) {
    if (kind === 'section') {
      const idx = routeBuilder.steps.indexOf(id);
      if (idx >= 0) {
        if (idx === routeBuilder.steps.length - 1) routeBuilder.steps.pop();
      } else routeBuilder.steps.push(id);
      renderYard();
      refreshBuilderSteps();
    }
  }
}

/* ============================== 通用弹窗 ============================== */

function modal(title, contentNode, onOk, opts = {}) {
  if (typeof opts === 'string') opts = { okText: opts };
  const okText = opts.okText || '保存';
  const mask = html('div', { class: 'modal-mask' });
  const box = html('div', { class: 'modal' });
  box.appendChild(html('h3', {}, title));
  box.appendChild(contentNode);
  const actions = html('div', { class: 'actions' });
  const cancel = html('button', { class: 'ghost' }, '取消');
  const ok = html('button', { class: 'primary' }, okText);
  function close() { mask.remove(); }
  cancel.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  ok.addEventListener('click', async () => {
    try {
      const keep = await onOk();
      if (keep === false) return; // 校验失败，保留弹窗
      close();
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  if (opts.onDelete) {
    const del = html('button', { class: 'danger', style: 'margin-right:auto;' }, opts.deleteText || '删除');
    del.addEventListener('click', async () => {
      try {
        const keep = await opts.onDelete(close);
        if (keep === false) return;
        close();
      } catch (e) { toast(e.message, 'err', 6000); }
    });
    actions.appendChild(del);
  }
  actions.appendChild(cancel); actions.appendChild(ok);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  return { close };
}

function fld(labelText, input, hint) {
  const f = html('div', { class: 'fld' });
  f.appendChild(html('label', {}, labelText));
  f.appendChild(input);
  if (hint) f.appendChild(html('div', { class: 'hint' }, hint));
  return f;
}

function suggestedId(prefix) {
  let n = 1;
  const existing = new Set();
  if (prefix === 'sec') STATE.sections.forEach((s) => existing.add(s.id));
  if (prefix === 'sw') STATE.switches.forEach((s) => existing.add(s.id));
  if (prefix === 'sig') STATE.signals.forEach((s) => existing.add(s.id));
  const map = { sec: '', sw: 'SW', sig: 'S' };
  while (existing.has(map[prefix] + n)) n++;
  return map[prefix] + n;
}

/* ============================== 区段弹窗 ============================== */

function openSectionModal(sec, coords) {
  const isEdit = !!sec;
  const idIn = html('input', { type: 'text', value: sec ? sec.id : suggestedId('sec') });
  if (isEdit) idIn.disabled = true;
  const labelIn = html('input', { type: 'text', value: sec ? sec.label : '' });
  const c = sec || coords;
  const x1 = html('input', { type: 'number', value: c.x1 });
  const y1 = html('input', { type: 'number', value: c.y1 });
  const x2 = html('input', { type: 'number', value: c.x2 });
  const y2 = html('input', { type: 'number', value: c.y2 });

  const content = html('div', {});
  content.appendChild(fld('区段编号', idIn, '进路中通过此编号引用区段'));
  content.appendChild(fld('显示名称（可空）', labelIn));
  const coordRow = html('div', { class: 'row' });
  [['起点X', x1], ['起点Y', y1], ['终点X', x2], ['终点Y', y2]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp);
    inp.style.width = '86px';
    coordRow.appendChild(w);
  });
  content.appendChild(coordRow);
  if (isEdit) {
    content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
      `当前占用状态：${OCC_TEXT[sec.occ_state]}`));
  } else {
    content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
      '新建区段初始占用状态为"未知"（按占用处理），需值班员核实清空。'));
  }

  modal(isEdit ? `编辑区段 ${sec.id}` : '新建区段', content, async () => {
    const body = {
      id: idIn.value.trim(), label: labelIn.value.trim() || idIn.value.trim(),
      x1: Number(x1.value), y1: Number(y1.value), x2: Number(x2.value), y2: Number(y2.value)
    };
    if (isEdit) await api(`/api/admin/sections/${sec.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/sections', { method: 'POST', body: JSON.stringify(body) });
    toast(isEdit ? '区段已更新' : '区段已创建', 'ok');
    await load(true);
  }, isEdit ? '保存' : '创建');
}

/* ============================== 道岔弹窗 ============================== */

function openSwitchModal(sw, point) {
  const isEdit = !!sw;
  const cur = sw || {
    x: point.x, y: point.y,
    nx1: point.x - 40, ny1: point.y, nx2: point.x + 40, ny2: point.y,
    rx1: point.x, ry1: point.y + 10, rx2: point.x, ry2: point.y + 60
  };
  const idIn = html('input', { type: 'text', value: sw ? sw.id : suggestedId('sw') });
  if (isEdit) idIn.disabled = true;
  const labelIn = html('input', { type: 'text', value: sw ? sw.label : '' });
  const num = (v) => html('input', { type: 'number', value: v });
  const x = num(cur.x), y = num(cur.y);
  const nx1 = num(cur.nx1), ny1 = num(cur.ny1), nx2 = num(cur.nx2), ny2 = num(cur.ny2);
  const rx1 = num(cur.rx1), ry1 = num(cur.ry1), rx2 = num(cur.rx2), ry2 = num(cur.ry2);

  const content = html('div', {});
  content.appendChild(fld('道岔编号', idIn));
  content.appendChild(fld('显示名称（可空）', labelIn));
  const center = html('div', { class: 'row' });
  [['岔心X', x], ['岔心Y', y]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '100px'; center.appendChild(w);
  });
  content.appendChild(center);
  content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
    '定位 N=直股 两端点（用于画直股连线，可留空）'));
  const nRow = html('div', { class: 'row' });
  [['NX1', nx1], ['NY1', ny1], ['NX2', nx2], ['NY2', ny2]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '80px'; nRow.appendChild(w);
  });
  content.appendChild(nRow);
  content.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
    '反位 R=弯股 两端点（可留空）'));
  const rRow = html('div', { class: 'row' });
  [['RX1', rx1], ['RY1', ry1], ['RX2', rx2], ['RY2', ry2]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '80px'; rRow.appendChild(w);
  });
  content.appendChild(rRow);

  const v = () => ({
    id: idIn.value.trim(), label: labelIn.value.trim() || idIn.value.trim(),
    x: Number(x.value), y: Number(y.value),
    nx1: valOrNull(nx1), ny1: valOrNull(ny1), nx2: valOrNull(nx2), ny2: valOrNull(ny2),
    rx1: valOrNull(rx1), ry1: valOrNull(ry1), rx2: valOrNull(rx2), ry2: valOrNull(ry2)
  });

  modal(isEdit ? `编辑道岔 ${sw.id}` : '新建道岔', content, async () => {
    const body = v();
    if (isEdit) await api(`/api/admin/switches/${sw.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/switches', { method: 'POST', body: JSON.stringify(body) });
    toast(isEdit ? '道岔已更新' : '道岔已创建（初始位置 N 定位）', 'ok');
    await load(true);
  }, {
    okText: isEdit ? '保存' : '创建',
    deleteText: '删除该道岔',
    onDelete: isEdit ? async () => {
      if (!confirm(`确定删除道岔 ${sw.id}？被进路引用时会被拒绝。`)) return false;
      await api(`/api/admin/switches/${sw.id}`, { method: 'DELETE' });
      toast('道岔已删除', 'ok'); await load(true);
    } : null
  });
}

function valOrNull(inp) {
  const v = inp.value.trim();
  return v === '' ? null : Number(v);
}

/* ============================== 信号机弹窗 ============================== */

function openSignalModal(sig, point) {
  const isEdit = !!sig;
  const cur = sig || { x: point.x, y: point.y, direction: 'right' };
  const idIn = html('input', { type: 'text', value: sig ? sig.id : suggestedId('sig') });
  if (isEdit) idIn.disabled = true;
  const labelIn = html('input', { type: 'text', value: sig ? sig.label : '' });
  const dirSel = html('select', {});
  [['right', '朝右'], ['left', '朝左'], ['up', '朝上'], ['down', '朝下']].forEach(([v, t]) => {
    const o = html('option', { value: v }, t);
    if (cur.direction === v) o.selected = true;
    dirSel.appendChild(o);
  });
  const x = html('input', { type: 'number', value: cur.x });
  const y = html('input', { type: 'number', value: cur.y });

  const content = html('div', {});
  content.appendChild(fld('信号机编号', idIn));
  content.appendChild(fld('显示名称（可空，建议带端部名，如 S1/X1）', labelIn));
  const row = html('div', { class: 'row' });
  [['X', x], ['Y', y]].forEach(([t, inp]) => {
    const w = html('div', {}, html('label', {}, t), inp); inp.style.width = '100px'; row.appendChild(w);
  });
  const wd = html('div', {}, html('label', {}, '朝向（画图用）'), dirSel);
  row.appendChild(wd);
  content.appendChild(row);

  modal(isEdit ? `编辑信号机 ${sig.id}` : '新建信号机', content, async () => {
    const body = {
      id: idIn.value.trim(), label: labelIn.value.trim() || idIn.value.trim(),
      x: Number(x.value), y: Number(y.value), direction: dirSel.value
    };
    if (isEdit) await api(`/api/admin/signals/${sig.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api(`/api/admin/signals`, { method: 'POST', body: JSON.stringify(body) });
    toast(isEdit ? '信号机已更新' : '信号机已创建（未开放时显示红灯）', 'ok');
    await load(true);
  }, {
    okText: isEdit ? '保存' : '创建',
    deleteText: '删除该信号机',
    onDelete: isEdit ? async () => {
      if (!confirm(`确定删除信号机 ${sig.id}？`)) return false;
      await api(`/api/admin/signals/${sig.id}`, { method: 'DELETE' });
      toast('信号机已删除', 'ok'); await load(true);
    } : null
  });
}

/* ============================== 右侧面板 ============================== */

function setTool(t) {
  tool = t;
  drawFirst = null;
  if (t !== 'build-route') routeBuilder = null;
  renderYard();
  renderSide();
}

function renderSide() {
  side.innerHTML = '';

  const locked = STATE.openInstances.length > 0;
  if (locked) {
    const warn = html('div', { class: 'reasons' });
    warn.appendChild(html('li', {},
      `⚠ 当前有 ${STATE.openInstances.length} 条已开放进路，站场图与进路定义已锁定，解除后方可编辑`));
    side.appendChild(warn);
  }

  // 工具
  side.appendChild(html('div', { class: 'section-title' }, '绘制工具'));
  const tools = html('div', { class: 'tools' });
  const defs = [
    ['select', '选择/编辑'],
    ['draw-section', '＋ 画区段'],
    ['draw-switch', '＋ 放道岔'],
    ['draw-signal', '＋ 放信号机'],
    ['build-route', '⛓ 定义进路']
  ];
  defs.forEach(([t, label]) => {
    const b = html('button', { class: `tool-btn ${tool === t ? 'active' : ''}` }, label);
    b.disabled = locked && t !== 'select';
    b.addEventListener('click', () => {
      if (t === 'build-route') startRouteBuilder();
      else setTool(t);
    });
    tools.appendChild(b);
  });
  side.appendChild(tools);
  side.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    tool === 'draw-section'
      ? '在图上依次点击两个端点画区段（靠近既有端点会自动吸附）。'
      : tool === 'draw-switch'
      ? '在图上点击放置道岔，弹窗中可编辑直股/弯股端点坐标。'
      : tool === 'draw-signal'
      ? '在图上点击放置信号机。'
      : tool === 'build-route'
      ? '在图上按走行顺序依次点击区段构建进路路径；再在下方选择道岔位置与入口信号。'
      : '点击图上的区段/道岔/信号机可编辑或删除。'));

  if (tool === 'build-route' && routeBuilder) side.appendChild(renderRouteBuilder());

  // 实体清单
  side.appendChild(html('div', { class: 'section-title' }, `区段（${STATE.sections.length}）`));
  const secList = html('div', { class: 'entity-list' });
  for (const s of STATE.sections) {
    const blk = (STATE.blockadesBySection || {})[s.id];
    secList.appendChild(html('div', { class: 'ent' },
      html('b', { class: 'grow' }, `${s.id} ${s.label !== s.id ? s.label : ''}`),
      blk ? html('span', { class: `badge ${blk.status === 'active' ? 'red' : 'amber'}` },
        blk.status === 'active' ? '封锁中' : '封锁待生效') : null,
      html('span', { class: `badge ${s.occ_state === 'free' ? 'green' : s.occ_state === 'occupied' ? 'red' : 'unknown'}` },
        OCC_TEXT[s.occ_state])));
  }
  if (STATE.sections.length === 0) secList.appendChild(html('div', { class: 'hint' }, '尚无区段'));
  side.appendChild(secList);

  side.appendChild(html('div', { class: 'section-title' },
    `道岔（${STATE.switches.length}） / 信号机（${STATE.signals.length}）`));
  const swList = html('div', { class: 'entity-list' });
  for (const s of STATE.switches) {
    swList.appendChild(html('div', { class: 'ent' },
      html('span', { class: 'grow' }, `${s.id} ${s.label}　位置 ${s.position}`)));
  }
  for (const s of STATE.signals) {
    swList.appendChild(html('div', { class: 'ent' },
      html('span', { class: 'grow' }, `${s.id} ${s.label}`)));
  }
  if (!STATE.switches.length && !STATE.signals.length) {
    swList.appendChild(html('div', { class: 'hint' }, '尚无道岔/信号机'));
  }
  side.appendChild(swList);

  // 进路清单
  side.appendChild(html('div', { class: 'section-title' }, `进路定义（${STATE.routes.length}）`));
  const rtList = html('div', { class: 'entity-list' });
  for (const r of STATE.routes) {
    const ent = html('div', { class: 'ent', style: 'align-items:flex-start;flex-direction:column;gap:3px;' });
    const editBtn = html('button', { class: 'ghost small' }, '编辑');
    if (locked) editBtn.disabled = true;
    editBtn.addEventListener('click', () => startRouteBuilder(r));
    ent.appendChild(html('div', { style: 'width:100%;display:flex;gap:8px;align-items:center;' },
      html('b', { class: 'grow' }, `${r.id} ${r.label}`), editBtn));
    const info = html('div', { class: 'hint' },
      `${r.origin} → ${r.destination}｜区段: ${r.steps.map((s) => s.section_id).join(',') || '(空)'}` +
      `｜道岔: ${r.switchReqs.map((q) => `${q.switch_id}=${q.req_position}`).join(',') || '无'}` +
      `｜入口信号: ${r.entry_signal_id || '无'}`);
    ent.appendChild(info);
    rtList.appendChild(ent);
  }
  if (STATE.routes.length === 0) rtList.appendChild(html('div', { class: 'hint' }, '尚无进路'));
  side.appendChild(rtList);

  // 临时封锁
  side.appendChild(renderBlockadePanel());

  // 推演管理
  side.appendChild(html('div', { class: 'section-title' }, '推演管理'));

  // 延时取消保护时长设置（正整数秒；只对之后新申请生效）
  const secNow = STATE.cancelProtectionSeconds || 60;
  const secBox = html('div', { style: 'margin-bottom:10px;' });
  const secRow = html('div', { class: 'row' });
  const secIn = html('input', { type: 'number', min: '1', max: '604800', value: String(secNow), style: 'width:110px;' });
  const secBtn = html('button', { class: 'ghost small' }, '保存保护时长');
  secRow.appendChild(html('span', {}, '延时取消保护时长（秒，正整数）：'));
  secRow.appendChild(secIn);
  secRow.appendChild(secBtn);
  secBox.appendChild(secRow);
  secBox.appendChild(html('div', { class: 'hint' },
    '值班员对"已开放且尚无走行占用"的进路申请延时取消后，信号立即回红、锁闭保留；' +
    '保护期满且重查满足条件才解除。修改只对之后新申请生效，不追改已有申请。'));
  secBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/settings/cancel-protection', {
        method: 'PUT', body: JSON.stringify({ protectionSeconds: Number(secIn.value) })
      });
      toast(`保护时长已设为 ${data.protectionSeconds} 秒（仅影响新申请）`, 'ok', 5000);
      STATE.cancelProtectionSeconds = data.protectionSeconds;
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  side.appendChild(secBox);

  const mgmt = html('div', {});
  const b1 = html('button', { class: 'ghost' }, '清空推演状态（区段→未知，道岔→N）');
  const b2 = html('button', { class: 'ghost' }, '培训重开（区段→空闲，道岔→N）');
  b1.addEventListener('click', () => resetState('/api/admin/reset/state',
    '将删除全部进路实例与事件、撤销等待与延时取消申请、清除临时封锁记录，区段恢复"未知"，确定？'));
  b2.addEventListener('click', () => resetState('/api/admin/reset/training',
    '将删除全部进路实例与事件、撤销等待与延时取消申请、清除临时封锁记录，区段全部置为空闲，确定重新开始一轮演练？'));
  mgmt.appendChild(html('div', { class: 'row' }, b1));
  mgmt.appendChild(html('div', { class: 'row', style: 'margin-top:8px;' }, b2));
  side.appendChild(mgmt);
}

async function resetState(url, msg) {
  if (!confirm(msg)) return;
  try {
    await api(url, { method: 'POST' });
    toast('推演状态已重置', 'ok');
    await load(true);
  } catch (e) { toast(e.message, 'err', 6000); }
}

/* ============================== 临时封锁 ============================== */

const BLOCKADE_STATUS = {
  pending: ['amber', '待生效'],
  active: ['red', '已生效'],
  ended: ['unknown', '已结束']
};

function renderBlockadePanel() {
  const box = html('div', {});
  const all = STATE.blockades || [];
  const unfinished = all.filter((b) => b.status !== 'ended');
  box.appendChild(html('div', { class: 'section-title' }, `临时封锁（${unfinished.length} 未结束）`));

  // 发表单：区段 + 原因
  const form = html('div', { class: 'row' });
  const secSel = html('select', { style: 'width:96px;' });
  for (const s of STATE.sections) {
    const blk = (STATE.blockadesBySection || {})[s.id];
    secSel.appendChild(html('option', { value: s.id }, `${s.id}${blk ? '（已封锁）' : ''}`));
  }
  const reasonIn = html('input', { type: 'text', placeholder: '封锁原因（必填）',
    style: 'flex:1;min-width:120px;' });
  const submitBtn = html('button', { class: 'primary small' }, '发起封锁');
  submitBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/blockades', {
        method: 'POST',
        body: JSON.stringify({ sectionId: secSel.value, reason: reasonIn.value })
      });
      const b = data.blockade;
      toast(data.created
        ? `封锁申请 #${b.id} 已提交（${b.status === 'active' ? '已生效' : '待生效'}）：` +
          `区段 ${b.sectionId} 立即禁止排新进路`
        : `区段 ${b.sectionId} 已有未结束封锁申请 #${b.id}，返回原申请`,
        data.created ? 'ok' : 'info', 5200);
      reasonIn.value = '';
      await load(true);
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  form.appendChild(secSel);
  form.appendChild(reasonIn);
  form.appendChild(submitBtn);
  box.appendChild(form);
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' },
    '提交后立即阻止该区段参与新的预检/开放/等待兑现；已开放进路不受影响。' +
    '区段空闲且无进路锁时自动转为"已生效"，否则保持"待生效"并持续复核。'));

  if (!all.length) {
    box.appendChild(html('div', { class: 'hint', style: 'margin-top:6px;' }, '暂无封锁记录'));
    return box;
  }
  for (const b of all.slice(0, 12)) {
    const [cls, txt] = BLOCKADE_STATUS[b.status] || ['unknown', b.status];
    const card = html('div', { class: 'instance-card', id: 'blockade-' + b.id,
      style: 'margin-top:8px;' });
    const head = html('div', { class: 'row' });
    head.appendChild(html('b', {}, `封锁#${b.id}`));
    head.appendChild(html('span', { class: 'muted' }, `区段 ${b.sectionId}`));
    head.appendChild(html('span', { class: 'muted', style: 'flex:1;' }));
    head.appendChild(html('span', { class: `badge ${cls}` }, txt));
    card.appendChild(head);
    card.appendChild(html('div', { class: 'hint', style: 'margin-top:4px;' },
      `原因：${b.reason}（${b.applicant}，${b.createdAt}）`));
    if (b.status === 'ended' && b.endReason) {
      card.appendChild(html('div', { class: 'hint', style: 'margin-top:2px;' }, b.endReason));
    }
    if (b.status !== 'ended') {
      const row = html('div', { class: 'row', style: 'margin-top:6px;' });
      const endBtn = html('button', { class: 'danger small' }, '结束封锁');
      endBtn.addEventListener('click', async () => {
        if (!confirm(`结束封锁申请 #${b.id}（区段 ${b.sectionId}）？\n` +
          '结束后将按现有联锁规则重试等待兑现，区段占用状态保持不变。')) return;
        try {
          await api(`/api/admin/blockades/${b.id}/end`, { method: 'POST' });
          toast(`封锁申请 #${b.id} 已结束`, 'ok');
          await load(true);
        } catch (e) { toast(e.message, 'err', 6000); }
      });
      row.appendChild(endBtn);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
  return box;
}

/* ============================== 进路构建器 ============================== */

function refreshBuilderSteps() {
  if (typeof window.__refreshBuilderSteps === 'function') window.__refreshBuilderSteps();
}

function startRouteBuilder(existing) {
  tool = 'build-route';
  if (existing) {
    routeBuilder = {
      editId: existing.id,
      id: existing.id,
      label: existing.label,
      origin: existing.origin,
      destination: existing.destination,
      entrySignalId: existing.entry_signal_id || '',
      steps: existing.steps.map((s) => s.section_id),
      switches: existing.switchReqs.map((q) => ({ switchId: q.switch_id, position: q.req_position }))
    };
  } else {
    routeBuilder = {
      editId: null, id: '', label: '', origin: '', destination: '',
      entrySignalId: '', steps: [], switches: []
    };
  }
  drawFirst = null;
  renderYard();
  renderSide();
}

function renderRouteBuilder() {
  const rb = routeBuilder;
  const box = html('div', {
    style: 'border:1px solid #b9cdf5;background:#f3f7ff;border-radius:9px;padding:10px;margin-top:10px;'
  });
  box.appendChild(html('div', { class: 'section-title', style: 'margin-top:0;' },
    rb.editId ? `编辑进路 ${rb.editId}` : '新建进路'));

  const idIn = html('input', { type: 'text', value: rb.id || '', placeholder: '如 R4', style: 'width:100%;' });
  const labelIn = html('input', { type: 'text', value: rb.label, placeholder: '如 正线通过 X1→X3', style: 'width:100%;' });
  const originIn = html('input', { type: 'text', value: rb.origin, placeholder: '起点 如 X1', style: 'width:100%;' });
  const destIn = html('input', { type: 'text', value: rb.destination, placeholder: '终点 如 X3', style: 'width:100%;' });
  if (rb.editId) idIn.disabled = true;
  box.appendChild(fld('进路编号', idIn));
  box.appendChild(fld('名称', labelIn));
  box.appendChild(fld('起点', originIn));
  box.appendChild(fld('终点', destIn));

  const sigSel = html('select', { style: 'width:100%;' });
  sigSel.appendChild(html('option', { value: '' }, '（无入口信号机）'));
  for (const s of STATE.signals) {
    const o = html('option', { value: s.id }, `${s.id} ${s.label}`);
    if (s.id === rb.entrySignalId) o.selected = true;
    sigSel.appendChild(o);
  }
  box.appendChild(fld('入口信号机（开放时转绿，进入首段后回红）', sigSel));

  box.appendChild(html('div', { class: 'hint' },
    '路径（在图上按走行顺序点击区段，再点可从末尾移除）：'));
  const pathBox = html('div', { class: 'picked-list', id: 'rb-steps' });
  box.appendChild(pathBox);
  window.__refreshBuilderSteps = () => {
    if (!document.body.contains(pathBox) || routeBuilder !== rb) return;
    pathBox.innerHTML = '';
    if (rb.steps.length === 0) pathBox.textContent = '尚未选择区段';
    rb.steps.forEach((sid, i) => {
      pathBox.appendChild(html('span', { class: 'pick-chip' }, `${i + 1}. ${sid}`));
    });
  };
  window.__refreshBuilderSteps();

  // 道岔要求
  box.appendChild(html('div', { class: 'hint', style: 'margin-top:8px;' },
    '道岔位置要求（仅需列入本进路涉及的道岔）：'));
  const swBox = html('div', { id: 'rb-switches' });
  box.appendChild(swBox);
  const renderSwitches = () => {
    swBox.innerHTML = '';
    for (const sw of STATE.switches) {
      const cur = rb.switches.find((x) => x.switchId === sw.id);
      const row = html('div', { class: 'row', style: 'padding:3px 0;' });
      const chk = html('input', { type: 'checkbox' });
      chk.checked = !!cur;
      const sel = html('select', {});
      ['N', 'R'].forEach((p) => {
        const o = html('option', { value: p }, p === 'N' ? 'N 定位/直股' : 'R 反位/弯股');
        if ((cur ? cur.position : 'N') === p) o.selected = true;
        sel.appendChild(o);
      });
      chk.addEventListener('change', () => {
        if (chk.checked) rb.switches.push({ switchId: sw.id, position: sel.value });
        else rb.switches = rb.switches.filter((x) => x.switchId !== sw.id);
      });
      sel.addEventListener('change', () => {
        const item = rb.switches.find((x) => x.switchId === sw.id);
        if (item) item.position = sel.value;
      });
      row.appendChild(chk);
      row.appendChild(html('b', { style: 'width:52px;' }, sw.id));
      row.appendChild(sel);
      swBox.appendChild(row);
    }
    if (!STATE.switches.length) swBox.appendChild(html('div', { class: 'hint' }, '（站场无道岔）'));
  };
  renderSwitches();

  // 每次 renderSide 会重建 builder 面板，需把输入即时同步回 rb
  idIn.addEventListener('input', () => { rb.id = idIn.value.trim(); });
  labelIn.addEventListener('input', () => { rb.label = labelIn.value.trim(); });
  originIn.addEventListener('input', () => { rb.origin = originIn.value.trim(); });
  destIn.addEventListener('input', () => { rb.destination = destIn.value.trim(); });
  sigSel.addEventListener('change', () => { rb.entrySignalId = sigSel.value; });


  const actions = html('div', { class: 'row', style: 'margin-top:10px;' });
  const save = html('button', { class: 'primary small' }, rb.editId ? '保存进路' : '创建进路');
  const cancel = html('button', { class: 'ghost small' }, '取消');
  const del = rb.editId ? html('button', { class: 'danger small' }, '删除') : null;
  save.addEventListener('click', async () => {
    const body = {
      id: rb.id || idIn.value.trim(),
      label: rb.label || labelIn.value.trim() || rb.id || idIn.value.trim(),
      origin: rb.origin || originIn.value.trim(),
      destination: rb.destination || destIn.value.trim(),
      entrySignalId: rb.entrySignalId || sigSel.value || null,
      steps: rb.steps,
      switchReqs: rb.switches
    };
    if (!body.id) return toast('请填写进路编号', 'err');
    if (!body.origin || !body.destination) return toast('请填写起点和终点', 'err');
    if (!body.steps.length) return toast('请在图上点击区段，至少选择一个途经区段', 'err');
    try {
      if (rb.editId) await api(`/api/admin/routes/${rb.editId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/admin/routes', { method: 'POST', body: JSON.stringify(body) });
      toast(rb.editId ? '进路已更新' : '进路已创建', 'ok');
      routeBuilder = null; tool = 'select';
      await load(true);
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  cancel.addEventListener('click', () => { routeBuilder = null; tool = 'select'; renderYard(); renderSide(); });
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`确定删除进路 ${rb.editId}？`)) return;
    try {
      await api(`/api/admin/routes/${rb.editId}`, { method: 'DELETE' });
      toast('进路已删除', 'ok');
      routeBuilder = null; tool = 'select'; await load(true);
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  actions.appendChild(save); actions.appendChild(cancel);
  if (del) actions.appendChild(del);
  box.appendChild(actions);

  return box;
}

boot();
