const { createClient } = require('@libsql/client');
const path = require('path');

const db = createClient({
  url: process.env.DATABASE_URL || `file:${path.join(__dirname, 'briefings.db')}`,
  authToken: process.env.LIBSQL_AUTH_TOKEN,
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      subject TEXT,
      sender TEXT,
      mail_date TEXT,
      pdf_filename TEXT,
      pdf_content TEXT,
      pdf_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS briefing_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      briefing_id INTEGER NOT NULL,
      page_num INTEGER NOT NULL,
      image_data TEXT NOT NULL
    )
  `);
  // 기존 테이블에 pdf_url 컬럼 추가 (없을 경우만)
  try {
    await db.execute(`ALTER TABLE briefings ADD COLUMN pdf_url TEXT`);
  } catch (e) {
    // 이미 존재하면 무시
  }
}

module.exports = { db, initDb };
