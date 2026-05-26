require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { db, initDb } = require('./db');
const { checkMail } = require('./mail-checker');

// (Np) 또는 (Np, Mp) 페이지 참조가 있는 단락/항목 아래에 해당 이미지 삽입
function injectPageImages(html, briefingId, chartPages) {
  const pageSet = new Set((chartPages || []).map(Number));
  const usedPages = new Set();

  // (12p) 또는 (12p, 15p) 등 모든 패턴 매칭
  const markerPattern = /\s*\(\d+p(?:,\s*\d+p)*\)/g;

  let result = html.replace(/<(li|p)>([\s\S]*?)<\/(li|p)>/g, (match, openTag, content) => {
    // 마커에서 모든 페이지 번호 추출
    const allPageNums = [];
    for (const m of content.matchAll(/\((\d+p(?:,\s*\d+p)*)\)/g)) {
      for (const num of m[1].match(/\d+/g)) allPageNums.push(Number(num));
    }

    // 마커를 텍스트에서 제거
    const cleanContent = content.replace(markerPattern, '').trim();

    // 해당 페이지 이미지 삽입
    let imgs = '';
    if (pageSet.size > 0) {
      for (const pageNum of allPageNums) {
        if (pageSet.has(pageNum) && !usedPages.has(pageNum)) {
          usedPages.add(pageNum);
          imgs += `<div class="inline-chart"><img src="/briefing/${briefingId}/page/${pageNum}" loading="lazy" onclick="this.classList.toggle('expanded')" /><span class="inline-chart-label">p.${pageNum}</span></div>`;
        }
      }
    }

    return `<${openTag}>${cleanContent}</${openTag}>${imgs}`;
  });

  // <h2> 등 위에서 처리 못한 태그에 남은 마커도 모두 제거
  return result.replace(markerPattern, '');
}

// 간단한 마크다운 → HTML 변환
function mdToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const result = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^## (.+)/.test(line)) {
      if (inList) { result.push('</ol>'); inList = false; }
      result.push(`<h2>${line.replace(/^## /, '')}</h2>`);
    } else if (/^- (.+)/.test(line) || /^\* (.+)/.test(line)) {
      if (!inList) { result.push('<ol>'); inList = true; }
      result.push(`<li>${line.replace(/^[-*] /, '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`);
    } else if (/^---+$/.test(line)) {
      if (inList) { result.push('</ol>'); inList = false; }
      result.push('<hr>');
    } else if (line.trim()) {
      if (inList) { result.push('</ol>'); inList = false; }
      result.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`);
    }
  }
  if (inList) result.push('</ol>');
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

  // 차트 페이지 번호 먼저 조회 (injectPageImages에서 사용)
  const pagesResult = await db.execute({
    sql: 'SELECT page_num FROM briefing_pages WHERE briefing_id = ? ORDER BY page_num',
    args: [briefing.id],
  });
  const chartPages = pagesResult.rows.map(r => r.page_num);

  briefing.summary_html = injectPageImages(mdToHtml(briefing.pdf_content || ''), briefing.id, chartPages);
  briefing.pdf_viewer_url = briefing.pdf_url
    ? `https://docs.google.com/viewer?url=${encodeURIComponent(briefing.pdf_url)}`
    : null;

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
  try { await db.execute('DELETE FROM briefing_pages'); } catch (e) {}
  await db.execute('DELETE FROM briefings');
  res.send('✅ DB 초기화 완료 — <a href="/">목록으로</a>');
});

// gs(ghostscript) 설치 확인 — Gemini 호출 없이 테스트
app.get('/check-tools', (req, res) => {
  const { execFile } = require('child_process');
  execFile('gs', ['--version'], (err, stdout) => {
    if (err) return res.send(`❌ ghostscript 없음: ${err.message}`);
    res.send(`✅ ghostscript ${stdout.trim()} 사용 가능`);
  });
});

// 기존 브리핑 이미지만 재추출 — Gemini 재호출 없음
app.post('/retry-images/:id', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM briefings WHERE id = ?',
    args: [req.params.id],
  });
  if (result.rows.length === 0) return res.status(404).send('브리핑 없음');
  const briefing = result.rows[0];

  // DB에 저장된 chart_pages 사용, 없으면 요약 텍스트에서 (Np) 패턴 파싱
  let pageNums = [];
  if (briefing.chart_pages) {
    try { pageNums = JSON.parse(briefing.chart_pages); } catch (e) {}
  }
  if (pageNums.length === 0) {
    const matches = [...(briefing.pdf_content || '').matchAll(/\((\d+)p\)/g)];
    pageNums = [...new Set(matches.map(m => parseInt(m[1])))].filter(n => n > 0 && n <= 500).sort((a, b) => a - b);
  }
  if (pageNums.length === 0) return res.send('⚠️ 저장된 페이지 번호 없음 — 브리핑을 다시 처리하세요');

  try {
    const pdfRes = await fetch(briefing.pdf_url, { signal: AbortSignal.timeout(60000) });
    if (!pdfRes.ok) throw new Error(`PDF 다운로드 실패: HTTP ${pdfRes.status}`);
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    await db.execute({ sql: 'DELETE FROM briefing_pages WHERE briefing_id = ?', args: [briefing.id] });
    const { extractAndStoreChartPages } = require('./mail-checker');
    await extractAndStoreChartPages(pdfBuffer, briefing.id, pageNums);

    const cnt = (await db.execute({
      sql: 'SELECT COUNT(*) as n FROM briefing_pages WHERE briefing_id = ?',
      args: [briefing.id],
    })).rows[0].n;
    res.send(`✅ ${pageNums.length}개 시도 → ${cnt}개 저장 (<a href="/briefing/${briefing.id}">브리핑 보기</a>)`);
  } catch (e) {
    res.status(500).send(`❌ ${e.message}`);
  }
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
