'use strict';

const path = require('path');
const express = require('express');

const { getDb } = require('./db');
const { seedDemo } = require('./seed');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');
const { InterlockError } = require('./interlocking');
const waiting = require('./waiting');
const cancellation = require('./cancellation');
const blockade = require('./blockade');

const PORT = Number(process.env.PORT || 3000);

// 启动即建表；首次且库为空时写入示例数据（SEED_DEMO=0 可关闭）
const db = getDb();
if (process.env.SEED_DEMO !== '0') {
  const seeded = seedDemo(db);
  if (seeded) console.log('[startup] 已初始化示例站场（R1/R2/R3）');
}

// 服务重启后复核待生效的临时封锁（区段空闲且无进路锁的转为已生效），
// 随后自动尝试兑现仍在等待的申请（状态全部来自 SQLite，重启可恢复）
try {
  const activated = blockade.refreshBlockadeStates('server_start');
  if (activated.length) {
    console.log(`[startup] 重启后封锁申请转为已生效：#${activated.join('、#')}`);
  }
} catch (e) {
  console.error('[startup] 封锁状态复核失败:', e);
}
try {
  const r = waiting.sweepFulfillments('server_start');
  if (r.fulfilled.length) {
    console.log(`[startup] 重启后自动兑现等待申请 #${r.fulfilled.join('、#')}`);
  }
} catch (e) {
  console.error('[startup] 等待申请兑现扫描失败:', e);
}

// 启动延时取消到期处理：立即扫描一次（处理重启期间已到期的申请），之后每 0.5s 扫描
cancellation.startScheduler();

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', apiRoutes);

// 兜底：未匹配的 /api 路径返回 JSON
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// 统一错误处理
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof InterlockError) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...err.extra });
  }
  // 管理员路由里手动抛出的带 status 错误
  if (err && err.status) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`[startup] 进路联锁推演台已启动: http://localhost:${PORT}/`);
});
