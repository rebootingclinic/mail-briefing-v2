require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const { db } = require('./db');
const { sendTelegram } = require('./telegram');

const SENDER = 'ch-aide@aidepartners.com';
const SITE_URL = process.env.SITE_URL || 'https://mail-briefing-v2-production.up.railway.app';

// 이메일 본문에서 PDF URL 추출
function extractPdfUrls(html, text) {
  const pattern = /https:\/\/storage\.googleapis\.com\/[^\s"'<>]+\.pdf/gi;
  const fromHtml = html.match(pattern) || [];
  const fromText = text.match(pattern) || [];
  return [...new Set([...fromHtml, ...fromText])];
}

async function checkMail() {
  console.log(`[${new Date().toLocaleString('ko-KR')}] 메일 확인 시작...`);

  const client = new ImapFlow({
    host: 'imap.naver.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.NAVER_EMAIL,
      pass: process.env.NAVER_PASSWORD,
    },
    logger: false,
  });

  let newCount = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const messages = client.fetch(
        { from: SENDER },
        { uid: true, envelope: true, source: true }
      );

      for await (const msg of messages) {
        const uid = String(msg.uid);

        const existing = await db.execute({
          sql: 'SELECT id FROM briefings WHERE uid = ?',
          args: [uid],
        });
        if (existing.rows.length > 0) continue;

        const subject = msg.envelope?.subject || '(제목 없음)';
        const mailDate = msg.envelope?.date
          ? new Date(msg.envelope.date).toLocaleString('ko-KR')
          : '날짜 미상';

        const parsed = await simpleParser(msg.source);
        const html = parsed.html || parsed.textAsHtml || '';
        const text = parsed.text || '';

        const pdfUrls = extractPdfUrls(html, text);

        if (pdfUrls.length === 0) {
          console.log(`[스킵] ${subject} — PDF 링크 없음`);
          continue;
        }

        for (const pdfUrl of pdfUrls) {
          // URL에서 파일명 추출
          const rawName = pdfUrl.split('/').pop();
          const safeName = decodeURIComponent(rawName).replace(/[\\/:*?"<>|]/g, '_');

          // PDF 다운로드 & 텍스트 추출
          let pdfContent = '';
          try {
            const response = await fetch(pdfUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const pdfBuffer = Buffer.from(arrayBuffer);
            const data = await pdfParse(pdfBuffer);
            pdfContent = data.text.trim();
            console.log(`[PDF] 추출 완료 — ${safeName} (${pdfContent.length}자)`);
          } catch (e) {
            console.error(`[오류] PDF 처리 실패: ${e.message}`);
            pdfContent = '(PDF 텍스트 추출 실패)';
          }

          const result = await db.execute({
            sql: `INSERT OR IGNORE INTO briefings (uid, subject, sender, mail_date, pdf_filename, pdf_content)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [uid, subject, SENDER, mailDate, safeName, pdfContent],
          });

          const briefingId = result.lastInsertRowid;
          const briefingUrl = briefingId
            ? `${SITE_URL}/briefing/${briefingId}`
            : SITE_URL;

          console.log(`[저장] ${subject} — ${safeName}`);
          await sendTelegram(subject, safeName, mailDate, briefingUrl);
          newCount++;
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error('[오류]', err.message);
  }

  console.log(`[완료] 새 브리핑 ${newCount}건`);
  return { newCount };
}

module.exports = { checkMail };
