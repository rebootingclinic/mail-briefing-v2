const { createClient } = require('@libsql/client');
const path = require('path');

const db = createClient({
  url: process.env.DATABASE_URL || `file:${path.join(__dirname, 'briefings.db')}`,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

module.exports = { db, initDb };
