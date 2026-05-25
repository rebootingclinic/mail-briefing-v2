require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { db, initDb } = require('./db');
const { checkMail } = require('./mail-checker');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// 메인 페이지
app.get('/', async (req, res) => {
  const result = await db.execute(`
    SELECT id, subject, mail_date, pdf_filename,
           SUBSTR(pdf_content, 1, 300) AS preview
    FROM briefings ORDER BY created_at DESC
  `);
  res.render('index', { briefings: result.rows, query: req.query });
});

// 브리핑 상세
app.get('/briefing/:id', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM briefings WHERE id = ?',
    args: [req.params.id],
  });
  if (result.rows.length === 0) return res.status(404).send('브리핑을 찾을 수 없습니다.');
  res.render('detail', { briefing: result.rows[0] });
});

// 수동 확인
app.post('/check', async (req, res) => {
  const result = await checkMail();
  res.redirect('/?checked=1&new=' + result.newCount);
});

// 1시간마다 자동 확인
cron.schedule('0 * * * *', async () => {
  console.log('[자동확인] 메일 체크');
  await checkMail();
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 서버 실행: http://localhost:${PORT}`);
    checkMail();
  });
});
