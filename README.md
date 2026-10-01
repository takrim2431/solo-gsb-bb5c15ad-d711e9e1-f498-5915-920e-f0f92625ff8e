# 小型铁路站场培训 —— Web 进路联锁推演台

一个用于教学/培训的铁路站场进路联锁推演系统：管理员绘制轨道区段、道岔、信号机并
定义起终点进路；值班员选择进路与道岔位置，系统依据联锁规则判定能否开放、给出阻断
原因，开放时原子锁定沿途资源，并按带序号的占用/清空事件模拟列车走行、逐段解锁。
当资源暂不具备时，值班员也可提交**等待申请**（不预锁资源），系统在条件具备时
按提交顺序自动兑现为进路实例。

对**已开放且尚无走行占用记录**的进路，值班员还可申请**延时取消**：申请立即令入口
信号回红、区段与道岔锁继续保留，等待申请不提前兑现；管理员设置的保护期满后，系统在
同一事务内重查"进路仍开放、无走行占用、沿途区段均空闲"才解除进路并触发等待兑现，
条件不符则终止取消、保留锁闭并说明原因。

管理员还可按区段发起**临时封锁**：申请提交后立即阻止该区段参与新的进路预检、直接
开放与等待兑现（等待申请保留顺位并显示封锁原因）；已开放进路的锁闭、走行与延时取消
规则不受影响。区段空闲且无进路锁时申请自动由"待生效"转为"已生效"，否则持续复核；
管理员可随时结束封锁，结束后按现有联锁规则重试等待兑现。

## 功能概览

- **管理员页面**：在 SVG 站场图上绘制轨道区段、道岔、信号机，定义起终点进路
  （依次点选沿途区段和道岔位置），可一键清空推演状态恢复到初始空场。
- **值班员页面**：选择进路及道岔位置 → 系统预检可否开放（信号状态、阻断原因）→
  开放进路（原子锁定区段/道岔）→ 按区段提交带**递增序号**的占用/清空事件 →
  列车进入首段信号自动回红 → 已清空区段逐段解锁 → 末段清空后整条进路解除。
  也可对所选进路提交**等待申请**：
  - 申请只校验进路与道岔选择是否符合定义（未知进路、缺失/不符定义的道岔选择直接
    拒绝），**不预锁任何资源**，可查看申请编号、当前顺位、阻断原因与兑现后的进路实例。
  - 提交时，以及区段状态变化、道岔扳动、进路解除、服务重启后，系统自动尝试兑现；
    兑现时在**同一事务内重新执行现有开放校验与锁闭**——未知/占用区段、道岔实际
    位置不符、他路锁闭则继续等待并刷新阻断原因；重复触发**不会产生多个实例**。
  - 共享区段或道岔的等待申请严格按提交顺序排队，仍有效的前项未兑现时后项不得越过；
    资源互不相交的申请可以先兑现。
  - 本人可撤销自己尚未兑现的申请（非本人撤销拒绝）；申请人退出登录、管理员重置
    推演会撤销未兑现申请；进路定义被修改/删除会使相关申请失效并写明原因。
  - 等待状态与结果全部持久化在 SQLite，页面刷新、服务重启后仍可见。
- **延时取消（保护期后取消）**
  - 值班员可对**已开放且尚无走行占用记录**的进路申请延时取消，返回申请状态与最早
    解除时间；申请立即令**入口信号回红**，原区段锁与道岔锁继续保留；保护期内
    等待申请**不得提前兑现**。
  - 保护时长由管理员设置为**正整数秒**；申请落库即快照时长与最早解除时刻，之后
    修改设置**不追改**已有申请。
  - 到期后在**同一事务内重查**：实例仍开放、无走行占用记录、沿途区段均空闲，才
    解除进路并触发等待兑现；条件不符则**终止取消申请、保留锁闭并说明原因**。
  - 保护期内收到该实例的**首段占用事件**：按现有走行规则照常受理，并终止取消申请；
    **重复申请**返回原申请，不缩短期限、不产生第二笔申请。
  - 服务重启后继续处理未到期/已到期申请；管理员重置推演时申请与进路实例一并清除。
  - 现有人工解除、走行事件接口约定保持不变；值班台显示取消状态与实时剩余时间。
- **临时封锁（管理员按区段发起）**
  - 管理员按**区段编号 + 封锁原因**发起，返回申请编号、状态（待生效/已生效）与原因；
    未知区段、空白原因一律拒绝；同一区段已有未结束封锁时重复申请返回原申请，
    不产生第二笔。
  - 申请提交后**立即**阻止该区段参与新的进路预检、直接开放与等待兑现；等待申请
    保留顺位并显示封锁原因。**已开放进路保持原锁闭、走行与延时取消规则**，不因
    封锁申请强制解除。
  - 区段**空闲且无进路锁**时待生效申请自动转为已生效；占用、未知或仍锁闭时维持
    待生效。走行出清、独立区段状态变化、延时取消到期、进路解除及服务重启后持续
    复核，状态转换与开放校验读取同一份区段占用/锁闭状态。
  - 管理员可结束待生效或已生效封锁；结束后按现有联锁规则重试等待兑现，**不改写
    区段占用状态**。管理员与值班员页面均显示封锁状态；管理员重置推演时清除封锁
    记录。
- **联锁规则**
  - 开放时在单个 SQLite 事务内检查并锁定资源：区段被占用（含**未知状态按占用处理**）、
    道岔实际位置与要求不符、资源已被其他开放进路锁定时一律拒绝，**回滚且不留下
    部分锁定**。
  - 两名值班员同时申请冲突进路，借助数据库唯一约束 + 事务，只可能成功一条。
  - 事件序号必须严格递增：同号同内容重传幂等不重复生效；同号异内容、跳号一律拒绝，
    并指出涉及区段。
  - 已开放进路锁定的道岔不得扳动；错误操作均返回涉及的区段/道岔/信号编号与原因。
  - 所有状态保存在本地 SQLite，刷新页面后完全恢复。
- **角色**：管理员（口令登录，默认 `admin` / `admin123`，可通过环境变量修改）；
  值班员输入姓名即可登录，支持两名及以上值班员同时操作，冲突在服务端仲裁。

## 技术栈

- Node.js + Express（REST API）
- SQLite（[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)，同步事务）
- 原生 HTML/CSS/JavaScript + SVG 站场图，无前端构建步骤
- Docker / Docker Compose 一键启动

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 服务端口 |
| `DB_PATH` | `/data/interlock.db`（容器内） | SQLite 数据库文件路径，父目录不存在会自动创建 |
| `ADMIN_PASSWORD` | `admin123` | 管理员登录口令 |
| `SEED_DEMO` | `1` | 首次启动且库为空时是否写入示例站场（1 写入 / 0 不写入） |

## 一键启动（推荐 Docker Compose）

```bash
docker compose up -d --build
```

容器启动时会自动完成：npm 依赖安装（已构建进镜像）、建表、以及（首次）写入一套
示例站场数据。数据通过命名卷 `interlock-data` 持久化到宿主机。

停止并保留数据：

```bash
docker compose down
```

清除全部本地数据重新开始：

```bash
docker compose down -v
docker compose up -d --build
```

## 本地直接运行（需要 Node.js ≥ 18）

```bash
npm install
DB_PATH=./data/interlock.db npm run init-db   # 建表 + 初始化示例数据（可选，start 也会自动建表）
DB_PATH=./data/interlock.db npm start
```

## 网页地址与端口

启动后浏览器访问：

| 页面 | 地址 |
| --- | --- |
| 登录入口 | http://localhost:3000/ |
| 管理员工作台 | http://localhost:3000/admin.html |
| 值班员工作台 | http://localhost:3000/dispatcher.html |

如修改了 `PORT`（例如 `PORT=8080`），请相应改为 `http://localhost:8080/`。

## 示例站场

首次启动写入的示例站场（见 `src/seed.js`）：

```
  X1 ●──── S1 ──[ 1 ]─[ 3 ]──[ 5 ]────● X3   正线（直股）
                    ╲       ╱
                   [2]─[4]╱         侧线（弯股）
                    SW7    SW8
```

- 区段：`1`～`5`；道岔：`SW7`（位置 N 直股 / R 弯股）、`SW8`（N 直股 / R 弯股）
- 信号机：`S1`（下行入口，防护进路 R1/R3）、`S3`（上行出口）、`S2`（侧线入口，
  防护进路 R2）、`S4`（侧线出口）
- 进路：
  - **R1 正线通过** X1→X3：区段 1,3,5，道岔 SW7=N、SW8=N
  - **R2 正线至侧线** X1→X4：区段 1,3,4,2，道岔 SW7=R、SW8=R
  - **R3 侧线至正线** X2→X3：区段 2,4,3,5，道岔 SW7=R、SW8=R
  - R1 与 R2/R3 争用区段 1/3 与道岔；R2 与 R3 争用 2/3/4 与道岔 —— 可用于验证
    "两人同时申请冲突进路只成功一条"。

> 示例区段初始状态为"空闲"，便于开箱即用。**管理员之后新建的区段初始状态为
> "未知（按占用处理）"**，需要由值班员先提交"清空"事件（序号 1）后才可用于进路。
> 道岔初始位置一律为 N（定位/直股）。

## 典型操作流程（值班员）

1. 登录后选择进路（如 R1），核对道岔要求位置（与实际不符时先在"道岔操作"区扳动，
   未锁定的道岔才允许扳动）。
2. 点击"预检"查看能否开放及阻断原因；点击"开放进路"，沿途区段与道岔被原子锁定，
   信号机转绿（允许）。
3. 在"事件提交"区按列车走行顺序逐段提交事件，序号从 1 开始递增：
   `1 占用 区段1` → 信号立即回红；`2 清空 区段1`（区段1自动解锁）→
   `3 占用 区段3` → `4 清空 区段3` → …… 末段（区段5）清空后整条进路自动解除。
4. 已清空的经过区段会逐段解锁；**末段未清空前，整条进路保持锁闭、信号保持红灯**。
5. 同号同内容重传返回成功但不会重复生效（幂等）；同号异内容、跳号会被拒绝并提示
   涉及区段与正确序号。
6. 若进路已开放但列车尚未进入（无走行占用事件），需要延时取消：在进路卡片点
   "申请延时取消"，入口信号立即回红、锁闭保留，保护期满且沿途区段均空闲才解除；
   保护期内一旦收到首段占用事件即自动终止取消，继续按走行处理。

## 等待申请（排路等待）用法

当进路暂时不能开放（区段占用/未知、道岔实际位置不符、他路锁闭），值班员不必反复
手工重试：在值班台选择进路并核对道岔选择后，点**"提交等待申请（不预锁）"**即可。

- 等待期间不会锁定任何资源，直接开放与正常走行不受影响；申请面板中可看到每条申请的
  **编号、顺位、当前阻断原因**，已兑现的会显示对应的**进路实例编号**。
- 下列任一事件发生时系统自动重新尝试兑现：提交申请时、区段状态变化（占用/清空）、
  道岔扳动、进路逐段解锁或整条解除、管理员变更定义（可能导致失效）、**临时封锁结束**、
  服务重启。
- 排队规则：与仍在等待的前项申请**共享区段或道岔**时按提交顺序等待，不得越过；
  与前项**资源互不相交**的申请可以先行兑现（顺位只统计共享资源的前项数）。
- 本人申请在未兑现前可随时撤销；前项撤销后后项顺位自动前移。
- 进路定义被修改或删除时，相关未兑现申请标记为"已失效"并说明原因；退出登录或
  管理员"清空推演状态/恢复示例初始状态"会撤销全部未兑现申请。

### 等待申请 HTTP API（含调用示例）

所有接口均需值班员 Bearer 令牌（登录接口见下）；令牌也可通过登录时下发的
`sid` Cookie 传递。

先登录获取令牌：

```bash
curl -s -X POST http://localhost:3000/api/auth/login/dispatcher \
  -H 'Content-Type: application/json' \
  -d '{"name":"值班员甲"}'
# -> {"ok":true,"token":"abcd1234…","role":"dispatcher","name":"值班员甲"}
TOKEN=abcd1234…
```

**1) 提交等待申请**（按进路编号 + 所选道岔位置；不预锁资源，提交后立即尝试兑现）

```bash
curl -s -X POST http://localhost:3000/api/routes/R1/waiting \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"switchPositions":{"SW7":"N","SW8":"N"}}'
```

立即兑现成功：

```json
{"ok":true,"waiting":{"id":7,"seq":7,"routeId":"R1","applicant":"值班员甲",
 "switchPositions":{"SW7":"N","SW8":"N"},"status":"fulfilled","instanceId":12,
 "instance":{"id":12,"routeId":"R1","status":"open","signalState":"green"},
 "blockReasons":[],"position":null}}
```

暂不具备条件时进入等待（HTTP 201，`status:"waiting"`），字段含义：

| 字段 | 说明 |
| --- | --- |
| `id` / `seq` | 申请编号（自增，即提交顺序号） |
| `position` | 当前顺位：提交更早且共享区段/道岔、仍在等待的申请数 + 1 |
| `blockReasons` | 最近一次兑现尝试的阻断原因（占用/未知区段、临时封锁、道岔实际位置不符、他路锁闭、前项未兑现等） |
| `blockedBy` | 因"前项未兑现"被拦截时，挡在前面的申请编号列表 |
| `instanceId` / `instance` | 兑现后产生的进路实例编号与摘要（等待中为 `null`） |
| `status` | `waiting` 等待中 / `fulfilled` 已兑现 / `cancelled` 已撤销 / `invalid` 已失效 |
| `endReason` | 撤销或失效说明 |

提交被拒的情形：未知进路 `404 ROUTE_NOT_FOUND`；缺少道岔选择
`400 SWITCH_NOT_CHOSEN`；选择与进路定义不符 `409 SWITCH_POSITION_MISMATCH`；
选择了进路不要求的道岔 `400 SWITCH_NOT_IN_ROUTE`；位置非 N/R `400 BAD_POSITION`。

**2) 查看等待申请**（默认只返回本人的；加 `scope=all` 可查看全员用于仲裁展示；
等待与结果随 `/api/state` 一并下发，页面刷新/重启后同样可见）

```bash
curl -s "http://localhost:3000/api/waiting" -H "Authorization: Bearer $TOKEN"          # 本人
curl -s "http://localhost:3000/api/waiting?scope=all" -H "Authorization: Bearer $TOKEN" # 全员
curl -s "http://localhost:3000/api/waiting?status=waiting" -H "Authorization: Bearer $TOKEN"
```

**3) 撤销本人未兑现申请**（非本人 403 `NOT_OWNER`；已结束 409 `WAITING_NOT_ACTIVE`；
不存在 404 `WAITING_NOT_FOUND`；撤销后系统立即尝试兑现后续申请）

```bash
curl -s -X POST http://localhost:3000/api/waiting/7/cancel \
  -H "Authorization: Bearer $TOKEN"
```

兑现成功的进路实例与普通开放完全一致：可通过
`POST /api/instances/:id/events` 提交带序号的走行事件，末段清空后自动解除，
解除瞬间会自动触发其他等待申请兑现。

## 延时取消（保护期后取消）用法

当一条已开放进路暂无列车进入（**无任何走行占用事件**），值班员希望在给现场留出一段
防护时间后自动取消它，可在值班台该进路卡片上点**"申请延时取消"**（或调用下面的
HTTP API）。

- 申请**立即令入口信号回红**，原区段锁与道岔锁**继续保留**；保护期内已排队的等待
  申请因锁仍在**不会提前兑现**。值班台显示"延时取消中"徽标与实时倒计时（剩余时间 +
  最早解除时刻）。
- 保护时长由管理员在"推演管理 → 延时取消保护时长"中设置（**正整数秒**，默认 60 秒）；
  申请时把时长快照入库，**之后修改设置不追改已有申请**，只对新申请生效。
- 保护期内收到该实例**首段占用事件**：走行事件照常受理，取消申请立即终止（信号红、
  锁闭保留，按正常走行逐段解锁）。
- 到期时系统在**同一事务内重查**：① 实例仍开放；② 无走行占用记录；③ 沿途区段均
  空闲。三者满足才解除进路（删全部锁、信号红）并触发等待申请兑现；任一不满足则
  **终止取消申请、保留锁闭并写明原因**（如"沿途区段 5 当前被占用"），值班员可继续
  走行处理，条件恢复后重新申请。
- **重复申请**：同一实例已有待处理申请时，接口返回原申请（`created:false`），不缩短
  期限、不产生第二笔。
- 服务重启后定时器继续运行：未到期申请继续等待，重启期间已到期的启动即处理；
  管理员"清空推演状态/培训重开"会把申请与进路实例一并清除。

### 延时取消 HTTP API（含调用示例）

需值班员 Bearer 令牌（登录方式同上一节）。

**1) 申请延时取消**（仅已开放且无走行占用记录的实例）

```bash
curl -s -X POST http://localhost:3000/api/instances/12/cancel-delayed \
  -H "Authorization: Bearer $TOKEN"
```

新申请返回 **201**（重复申请命中同一条 pending 时返回 **200** 且 `created:false`）：

```json
{"ok":true,"created":true,
 "cancellation":{"id":3,"instanceId":12,"applicant":"值班员甲","status":"pending",
  "durationSeconds":60,"requestedAt":1790820000000,"releaseAt":1790820060000,
  "processedAt":null,"remainingMs":59982,"overDue":false,"endReason":null}}
```

| 字段 | 说明 |
| --- | --- |
| `status` | `pending` 保护期等待中 / `released` 到期核验通过已解除 / `aborted` 条件不符或已走行，终止（锁闭保留） |
| `durationSeconds` | 申请时的保护时长快照（秒）；管理员之后改设置不影响它 |
| `requestedAt` / `releaseAt` | 申请时刻 / 最早解除时刻（epoch 毫秒） |
| `remainingMs` | 剩余毫秒（pending 时有效，到期为 0；前端按服务器时钟校准倒计时） |
| `endReason` | 解除说明，或终止原因（首段占用、区段占用/未知等） |

被拒情形：实例不存在或已解除 `404 INSTANCE_NOT_FOUND`；已有走行占用记录
`409 CANCEL_OCCUPANCY_EXISTS`；未登录 `401`；管理员身份 `403`。

**2) 查看延时取消申请**（默认本人全部；`scope=all` 全员；可加
`?status=pending|released|aborted`；待处理申请也随 `/api/state` 的
`pendingCancellations`、`cancellationRequests`、`cancelProtectionSeconds` 下发）

```bash
curl -s "http://localhost:3000/api/cancellations" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/api/cancellations?scope=all&status=pending" \
  -H "Authorization: Bearer $TOKEN"
```

**3) 管理员设置保护时长**（需管理员令牌；正整数秒，1~604800；只影响之后新申请）

```bash
# 查询
curl -s http://localhost:3000/api/admin/settings/cancel-protection \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"protectionSeconds":60,"defaultSeconds":60,"maxSeconds":604800}

# 修改
curl -s -X PUT http://localhost:3000/api/admin/settings/cancel-protection \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"protectionSeconds":120}'
# -> {"ok":true,"protectionSeconds":120,"note":"已更新；仅对之后提交的延时取消申请生效…"}
```

非法值（0、负数、小数、非数字）返回 `400 BAD_PROTECTION_SECONDS`。

## 临时封锁用法

管理员因施工、抢修等原因需要临时禁止某区段排进新路时，在管理员页面"临时封锁"区
选择区段、填写原因后点**"发起封锁"**（或调用下面的 HTTP API）。值班员在值班台
"临时封锁"面板、区段选择列表与站场图（区段下方红色 `⊘封锁中/⊘封锁待生效` 标记）
都能看到封锁状态。

- 发起即生效于"新排路"：该区段参与的新**预检**会在阻断原因中列出封锁，**直接开放**
  返回 `409 SECTION_BLOCKADED`，**等待申请**保持等待、顺位不变并把阻断原因刷新为
  封锁原因。**已开放进路不受任何影响**：锁闭、走行事件、延时取消规则原样。
- 状态转换：区段空闲且无进路锁 → 自动**已生效**；占用/未知/仍锁闭 → 保持**待生效**，
  系统在走行出清、独立区段状态变化、延时取消到期、进路解除、服务重启后自动复核。
- 结束：管理员结束待生效/已生效封锁后，系统按现有联锁规则重试等待兑现；区段占用
  状态保持原样（封锁与结束都不改写占用状态）。

### 临时封锁 HTTP API（含调用示例）

先登录获取管理员令牌：

```bash
curl -s -X POST http://localhost:3000/api/auth/login/admin \
  -H 'Content-Type: application/json' \
  -d '{"password":"admin123"}'
# -> {"ok":true,"token":"cafe1234…","role":"admin","name":"管理员"}
ADMIN_TOKEN=cafe1234…
```

**1) 发起临时封锁**（按区段编号 + 封锁原因）

```bash
curl -s -X POST http://localhost:3000/api/admin/blockades \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sectionId":"3","reason":"道岔检修施工"}'
```

新申请返回 **201**；同一区段已有未结束（待生效/已生效）封锁时返回 **200** 且
`created:false`，内容为原申请（不因为重复申请产生第二笔）：

```json
{"ok":true,"created":true,
 "blockade":{"id":2,"sectionId":"3","applicant":"管理员","reason":"道岔检修施工",
  "status":"pending","createdAt":"2026-10-01 06:30:00",
  "activatedAt":null,"endedAt":null,"endReason":null}}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 封锁申请编号（自增） |
| `status` | `pending` 待生效 / `active` 已生效 / `ended` 已结束 |
| `reason` | 封锁原因（首尾空白自动去除，空白原因拒绝） |
| `activatedAt` | 转为已生效的时刻（区段空闲且无进路锁时） |

被拒情形：未知区段 `404 SECTION_NOT_FOUND`；空白/缺失原因
`400 BLOCKADE_REASON_REQUIRED`；未登录 `401`；值班员身份 `403`。

**2) 查看封锁列表**（管理员；未结束在前，可加 `?status=pending|active|ended`）

```bash
curl -s "http://localhost:3000/api/admin/blockades" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s "http://localhost:3000/api/admin/blockades?status=active" -H "Authorization: Bearer $ADMIN_TOKEN"
```

值班员只读查看（未结束封锁也随 `/api/state` 的 `blockades` 与
`blockadesBySection` 一并下发，页面据此显示）：

```bash
curl -s "http://localhost:3000/api/blockades" -H "Authorization: Bearer $TOKEN"
```

**3) 结束封锁**（待生效/已生效均可结束；结束后自动按现有联锁规则重试等待兑现）

```bash
curl -s -X POST http://localhost:3000/api/admin/blockades/2/end \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"blockade":{"id":2,"status":"ended","endedAt":"2026-10-01 06:41:12",…}}
```

被拒情形：申请不存在 `404 BLOCKADE_NOT_FOUND`；已结束 `409 BLOCKADE_NOT_ACTIVE`。

封锁期间值班员既有接口行为：预检 `POST /api/routes/:id/check` 的 `reasons` 会包含
"区段 X 已被临时封锁（申请 #N，…，原因：…）"；直接开放
`POST /api/routes/:id/open` 返回 `409 SECTION_BLOCKADED`；走行事件
`POST /api/instances/:id/events`、延时取消等既有接口约定不变。

## 数据持久化与重置

- 全部拓扑、状态、事件、进路实例、会话、**等待申请、延时取消申请与保护时长设置、
  临时封锁申请**均在本地 SQLite（默认卷 `interlock-data`）。
- 管理员页面"推演管理"提供：**清空推演状态**（删除进路实例/事件，区段恢复为未知、
  道岔回 N，保留站场图；同时撤销全部未兑现等待申请、**清除全部延时取消申请与临时
  封锁记录**）；**恢复示例初始状态**（额外把示例区段置为空闲；同样撤销/清除）。
  "推演管理"中还可设置延时取消保护时长（正整数秒，仅影响之后新申请）。
- 存在已开放进路期间，站场图（拓扑/进路定义）不可编辑，防止改变正在使用的线路。
- 值班员退出登录会撤销本人全部未兑现等待申请；进路定义被修改/删除时，相关未兑现
  申请保留记录并标记失效、写明原因（已兑现产生的进路实例记录不受影响）。
- 服务重启后自动对仍在等待的申请执行一次兑现扫描；满足条件即兑现，不满足继续等待，
  且任何情况下一条申请至多对应一个进路实例。
- 延时取消的到期处理定时器随服务启动：启动即扫描一次（处理重启期间已到期的申请），
  之后每 0.5 秒扫描；未到期申请继续倒计时，到期按同一事务重查结果解除或终止。
- 临时封锁随服务持久化：重启后未结束封锁继续有效，并在启动时复核一次（区段空闲且
  无进路锁的待生效申请转为已生效）；区段被删除时其未结束封锁自动标记结束并保留记录。

## 目录结构

```
├── Dockerfile
├── docker-compose.yml
├── package.json
├── scripts/init-db.js         # 显式建表/初始化脚本
├── src/
│   ├── server.js              # Express 入口与静态资源
│   ├── db.js                  # SQLite 连接与建表
│   ├── schema.sql             # 表结构
│   ├── seed.js                # 示例站场
│   ├── auth.js                # 会话与鉴权
│   ├── interlocking.js        # 核心联锁逻辑（开放/事件/解锁/扳岔，含封锁校验）
│   ├── waiting.js             # 等待申请（提交/撤销/顺位/事务内自动兑现）
│   ├── cancellation.js        # 延时取消（申请/保护期/到期同事务核验/重启续处理）
│   ├── blockade.js            # 临时封锁（发起/结束/待生效复核/重置清除）
│   └── routes/
│       ├── auth.js
│       ├── admin.js           # 含保护时长设置、临时封锁管理、重置时清除取消/封锁
│       └── api.js             # 值班员接口（含等待申请、延时取消、封锁只读查看）
├── public/                    # 前端页面（登录/管理员/值班员，值班台含等待/延时取消/封锁面板）
└── test/
    ├── smoke.cjs              # 无需鉴权的联锁冒烟/并发测试脚本
    ├── waiting-http.cjs       # 等待申请 HTTP 端到端测试（含重启场景）
    ├── cancellation-http.cjs  # 延时取消 HTTP 端到端测试（含到期/终止/重启/重置）
    └── blockade-http.cjs      # 临时封锁 HTTP 端到端测试（含阻断/复核/结束/重启/重置）
```

## 测试

```bash
npm test             # 联锁冒烟 + 等待申请 + 延时取消 + 临时封锁端到端（共 269 项断言）
npm run smoke        # 联锁核心规则
npm run test:waiting# 等待申请提交/撤销/顺位/自动兑现/失效/重启
npm run test:cancel  # 延时取消申请/重复幂等/到期解除/首段占用终止/区段占用终止/重启/重置
npm run test:blockade# 临时封锁发起/校验/阻断/状态复核/结束/重启/重置
```
