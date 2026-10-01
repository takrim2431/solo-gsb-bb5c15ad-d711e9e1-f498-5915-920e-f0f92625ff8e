-- 小型铁路站场进路联锁推演台 数据库结构
-- 全部业务状态保存在本地 SQLite，刷新/重启后恢复

PRAGMA foreign_keys = ON;

-- 键值元数据（初始化标记、每客户端事件序号由各自表维护）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 轨道区段
CREATE TABLE IF NOT EXISTS sections (
  id     TEXT PRIMARY KEY,            -- 区段编号，如 1、3DG
  label  TEXT NOT NULL,
  x1     REAL NOT NULL,               -- SVG 端点坐标（画图用）
  y1     REAL NOT NULL,
  x2     REAL NOT NULL,
  y2     REAL NOT NULL,
  -- 占用状态: unknown 未知(按占用处理) / free 空闲 / occupied 占用
  occ_state TEXT NOT NULL DEFAULT 'unknown'
     CHECK (occ_state IN ('unknown','free','occupied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 道岔：position N=定位(直股) R=反位(弯股)；实际位置以本表为准
CREATE TABLE IF NOT EXISTS switches (
  id       TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  x        REAL NOT NULL,             -- 岔心坐标
  y        REAL NOT NULL,
  position TEXT NOT NULL DEFAULT 'N' CHECK (position IN ('N','R')),
  -- 三组连接端点坐标，用于画直股/弯股两条线路
  nx1 REAL, ny1 REAL, nx2 REAL, ny2 REAL,   -- 定位(直股) 两端
  rx1 REAL, ry1 REAL, rx2 REAL, ry2 REAL,   -- 反位(弯股) 两端
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 信号机
CREATE TABLE IF NOT EXISTS signals (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  x         REAL NOT NULL,
  y         REAL NOT NULL,
  direction TEXT NOT NULL DEFAULT 'right'   -- 朝向，仅画图用
     CHECK (direction IN ('right','left','up','down')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 进路定义（起终点）
CREATE TABLE IF NOT EXISTS routes (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  origin      TEXT NOT NULL,          -- 起点(信号机/站场端部)编号或名称
  destination TEXT NOT NULL,
  entry_signal_id TEXT REFERENCES signals(id) ON DELETE SET NULL, -- 入口信号机
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 进路顺序步：依次经过的区段，以及该进路要求的道岔位置
CREATE TABLE IF NOT EXISTS route_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,        -- 从 1 开始
  section_id TEXT NOT NULL REFERENCES sections(id),
  UNIQUE (route_id, step_order)
);

CREATE TABLE IF NOT EXISTS route_switch_reqs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  switch_id  TEXT NOT NULL REFERENCES switches(id),
  req_position TEXT NOT NULL CHECK (req_position IN ('N','R')),
  UNIQUE (route_id, switch_id)
);

-- 值班员会话（姓名 + 登录令牌）
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('admin','dispatcher')),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 已开放（锁闭中）的进路实例
CREATE TABLE IF NOT EXISTS route_instances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id    TEXT NOT NULL REFERENCES routes(id),
  opened_by   TEXT NOT NULL,          -- 值班员姓名
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','released')),
  -- 信号状态：red 红灯(关闭/停车) green 绿灯(允许)
  signal_state TEXT NOT NULL DEFAULT 'green' CHECK (signal_state IN ('red','green')),
  -- 下一个允许的事件序号（严格递增，从 1 开始）
  next_seq    INTEGER NOT NULL DEFAULT 1,
  -- 当前可进入(占用)的步号，从 1 起
  head_step   INTEGER NOT NULL DEFAULT 1,
  -- 当前可出清(清空)的最早步号，从 1 起；越过末步则整条进路解除
  tail_step   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);

-- 进路实例锁：开放时写入，逐段解锁/整条解除时删除对应行。
-- 唯一约束保证同一区段/道岔同一时刻只被一条进路锁定（争用仲裁核心）。
CREATE TABLE IF NOT EXISTS route_locks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('section','switch')),
  resource_id   TEXT NOT NULL,
  step_order INTEGER,                 -- 区段锁对应的进路步号（道岔锁为空）
  UNIQUE (resource_type, resource_id)
);

-- 占用/清空事件流水（幂等与序号审计依据）
CREATE TABLE IF NOT EXISTS section_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,       -- 进路实例内递增序号
  section_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('occupy','clear')),
  client      TEXT,                   -- 提交人
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (instance_id, seq)
);

-- 等待申请（值班员排路等待，不预锁资源）
-- 注意：route_id / instance_id 均不设外键级联：
--  - 进路被删除/修改时，相关等待申请要保留下来并写明失效原因（status=invalid）；
--  - 管理员重置会删除进路实例，已兑现申请保留 instance_id 作为溯源编号。
-- 兑现与否完全由提交顺序 + 现有开放校验在同一事务内重新判定。
CREATE TABLE IF NOT EXISTS waiting_applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id    TEXT NOT NULL,
  applicant   TEXT NOT NULL,           -- 申请人（值班员姓名）
  -- 申请时选择并校验通过的道岔位置快照（JSON，键=道岔号 值=N/R）
  switch_positions TEXT NOT NULL DEFAULT '{}',
  -- waiting 等待中 / fulfilled 已兑现 / cancelled 已撤销 / invalid 因定义变更失效
  status      TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting','fulfilled','cancelled','invalid')),
  instance_id INTEGER,                 -- 兑现后产生的进路实例编号
  -- 最近一次自动兑现尝试的阻断原因（JSON 字符串数组）
  block_reasons TEXT NOT NULL DEFAULT '[]',
  -- 因"前项未兑现"被拦截时，挡在前面的等待申请编号（逗号分隔，展示用）
  blocked_by  TEXT,
  end_reason  TEXT,                    -- 撤销/失效说明
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT
);

-- 同一等待申请最多兑现出一个进路实例（重复触发不得产生多个实例）
CREATE UNIQUE INDEX IF NOT EXISTS idx_waiting_instance
  ON waiting_applications(instance_id) WHERE instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_waiting_status ON waiting_applications(status, id);
CREATE INDEX IF NOT EXISTS idx_waiting_applicant ON waiting_applications(applicant);

-- 延时取消申请：值班员对"已开放且尚无走行占用记录"的进路申请保护期后取消。
--  - 申请立即令入口信号回红，原区段/道岔锁（route_locks）继续保留；
--  - 最早解除时刻 = 申请时刻 + 申请时保护时长快照（管理员之后改设置不追改）；
--  - 到期在同一事务内重查：实例仍开放、无走行占用记录、沿途区段均空闲才解除；
--    条件不符则终止申请（aborted），锁闭保留并写明原因；
--  - 保护期内收到首段走行占用事件：事件照常受理，本申请同步终止；
--  - 同一实例同时至多一笔 pending（部分唯一索引兜底重复申请）。
-- instance_id 设外键级联：管理员重置删除进路实例时申请记录一并清除。
CREATE TABLE IF NOT EXISTS cancellation_applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  applicant   TEXT NOT NULL,           -- 申请人（值班员姓名）
  -- pending 保护期等待中 / released 到期核验通过已解除进路 / aborted 条件不符或已走行，终止（锁闭保留）
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','released','aborted')),
  duration_seconds INTEGER NOT NULL,   -- 申请时的保护时长快照（秒，正整数）
  requested_at INTEGER NOT NULL,       -- 申请时刻（epoch 毫秒）
  release_at   INTEGER NOT NULL,       -- 最早解除时刻（epoch 毫秒）
  processed_at INTEGER,                -- 进入终态的时刻（epoch 毫秒）
  end_reason  TEXT,                    -- 终止/解除说明
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一进路实例同时至多一笔待处理的延时取消申请（重复申请幂等，不得产生第二笔/缩短期限）
CREATE UNIQUE INDEX IF NOT EXISTS idx_cancel_pending_instance
  ON cancellation_applications(instance_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_cancel_status ON cancellation_applications(status, release_at);
CREATE INDEX IF NOT EXISTS idx_cancel_applicant ON cancellation_applications(applicant);

-- 临时封锁申请（管理员按区段发起）：
--  - 提交即阻止该区段参与新的进路预检/直接开放/等待兑现（pending 与 active 均阻止）；
--  - 区段空闲且无进路锁时 pending 自动转 active；占用/未知/仍锁闭时维持 pending；
--  - 已开放进路的锁闭、走行与延时取消规则不受封锁影响（不强制解除）；
--  - 管理员可结束 pending/active 封锁；结束后按现有联锁规则重试等待兑现，
--    不改写区段占用状态；管理员重置推演时清除全部封锁记录。
-- section_id 不设外键：区段被删除时封锁记录保留（由管理端同事务标记结束）。
CREATE TABLE IF NOT EXISTS blockade_applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id  TEXT NOT NULL,             -- 被封锁的区段编号
  applicant   TEXT NOT NULL,             -- 发起人（管理员）
  reason      TEXT NOT NULL,             -- 封锁原因（非空白）
  -- pending 待生效 / active 已生效 / ended 已结束
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','active','ended')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,                     -- 转为已生效的时刻（pending→active）
  ended_at    TEXT,
  end_reason  TEXT                       -- 结束说明
);

-- 同一区段同时至多一笔未结束（待生效/已生效）的封锁申请（重复申请返回原申请）
CREATE UNIQUE INDEX IF NOT EXISTS idx_blockade_unfinished_section
  ON blockade_applications(section_id) WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS idx_blockade_status ON blockade_applications(status, id);

-- 交接班交接单：
--  - 交班值班员生成时，在同一事务内快照六类状态：区段占用、道岔位置、
--    开放进路（信号与走行进度）、等待申请、延时取消申请、未结束封锁，
--    并记录生成时刻（epoch 毫秒）与交班人；
--  - 接班值班员签收时在同一事务内按同一时刻的状态重新取快照比对：
--    任一类别已变化即拒绝签收、列出变化类别并把该单标记为 expired，
--    由交班人重新生成；签收成功后他人不可再签收；
--  - 同一接班人重复签收幂等返回原结果；交班人本人签收直接拒绝；
--  - 同一交班人生成新单时，其此前未签收的单标记过期（被新单替换）；
--  - 站场重置使全部未签收（active）单过期，已签收（signed）单保留供复盘；
--    交接单只读快照、不写业务资源，不阻塞任何既有操作。
CREATE TABLE IF NOT EXISTS handover_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_name     TEXT NOT NULL,             -- 交班人（生成者）
  to_name       TEXT,                      -- 接班人（签收时写入）
  -- active 待签收 / signed 已签收 / expired 已过期（状态变化/被新单替换/站场重置）
  status        TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','signed','expired')),
  generated_at  INTEGER NOT NULL,          -- 生成时刻（epoch 毫秒）
  signed_at     INTEGER,                   -- 签收时刻（epoch 毫秒）
  snapshot      TEXT NOT NULL,             -- 六类状态快照（JSON）
  expire_reason TEXT,                      -- 过期说明（JSON：类别/明细/原因）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_handover_status ON handover_documents(status, id);

CREATE INDEX IF NOT EXISTS idx_locks_instance ON route_locks(instance_id);
CREATE INDEX IF NOT EXISTS idx_events_instance ON section_events(instance_id, seq);
CREATE INDEX IF NOT EXISTS idx_steps_route ON route_steps(route_id, step_order);
