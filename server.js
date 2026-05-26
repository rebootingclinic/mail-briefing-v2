require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { db, initDb } = require('./db');
const { checkMail } = require('./mail-checker');

// 간단한 마크다운 → HTML 변환
function mdToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const result = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^## (.+)/.test(line)) {
      if (inList) { result.push('</ul>'); inList = false; }
      result.push(`<h2>${line.replace(/^## /, '')}</h2>`);
    } else if (/^- (.+)/.test(line) || /^\* (.+)/.test(line)) {
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${line.replace(/^[-*] /, '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`);
    } else if (/^---+$/.test(line)) {
      if (inList) { result.push('</ul>'); inList = false; }
      result.push('<hr>');
    } else if (line.trim()) {
      if (inList) { result.push('</ul>'); inList = false; }
      result.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`);
    }
  }
  if (inList) result.push('</ul>');
  return result.join('\n');
}

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
  const briefing = result.rows[0];
  briefing.summary_html = mdToHtml(briefing.pdf_content || '');
  // Google Docs Viewer로 열면 브라우저에서 바로 PDF 표시 (다운로드 없이)
  briefing.pdf_viewer_url = briefing.pdf_url
    ? `https://docs.google.com/viewer?url=${encodeURIComponent(briefing.pdf_url)}`
    : null;

  // 차트 페이지 번호 목록 조회
  const pagesResult = await db.execute({
    sql: 'SELECT page_num FROM briefing_pages WHERE briefing_id = ? ORDER BY page_num',
    args: [briefing.id],
  });
  const chartPages = pagesResult.rows.map(r => r.page_num);

  res.render('detail', { briefing, chartPages });
});

// 차트 페이지 이미지 서빙
app.get('/briefing/:id/page/:pageNum', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT image_data FROM briefing_pages WHERE briefing_id = ? AND page_num = ?',
    args: [req.params.id, parseInt(req.params.pageNum)],
  });
  if (result.rows.length === 0) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(result.rows[0].image_data, 'base64'));
});

// DB 초기화 (테스트용)
app.post('/reset-db', async (req, res) => {
  try {
    await db.execute('DELETE FROM briefing_pages');
  } catch (e) { /* 테이블 없으면 무시 */ }
  await db.execute('DELETE FROM briefings');
  res.send('✅ DB 초기화 완료 — <a href="/">목록으로</a>');
});

// 수동 확인 (즉시 응답 후 백그라운드 처리)
app.post('/check', (req, res) => {
  res.redirect('/?checked=1');
  checkMail().catch(err => console.error('[수동확인 오류]', err.message));
});

// 1시간마다 자동 확인
cron.schedule('0 * * * *', async () => {
  console.log('[자동확인] 메일 체크');
  await checkMail();
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 서버 실행: http://localhost:${PORT}`);
  });
});
