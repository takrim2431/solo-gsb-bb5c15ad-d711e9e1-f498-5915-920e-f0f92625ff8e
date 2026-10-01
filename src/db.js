'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

/**
 * 打开（或返回已打开的）SQLite 数据库并建表。
 * better-sqlite3 为同步驱动：每个 .transaction() 在单个连接上串行执行，
 * 配合 route_locks 的唯一约束即可实现"冲突申请只成功一条、无部分锁定"。
 */
function getDb() {
  if (db) return db;

  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'interlock.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // busy_timeout：并发事务撞锁时等待而不是立刻报 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  return db;
}

module.exports = { getDb };
