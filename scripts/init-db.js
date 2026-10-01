'use strict';

/**
 * 显式初始化脚本：建表 + （首次、库为空时）写入示例站场。
 * server.js 启动时也会自动调用同样的逻辑，此脚本供 Dockerfile CMD /
 * 手工 npm run init-db 使用。
 */
const { getDb } = require('../src/db');
const { seedDemo } = require('../src/seed');

const db = getDb();
const seeded = process.env.SEED_DEMO === '0' ? false : seedDemo(db);

console.log('[init-db] 数据库已就绪:', process.env.DB_PATH || '(默认 ./data/interlock.db)');
console.log(seeded ? '[init-db] 已写入示例站场数据（R1/R2/R3、区段1~5、SW7/SW8、S1~S4）'
                   : '[init-db] 未写入示例数据（已初始化或 SEED_DEMO=0）');
