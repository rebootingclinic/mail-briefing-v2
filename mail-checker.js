require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { sendTelegram } = require('./telegram');

const SENDER = 'ch-aide@aidepartners.com';
const PDF_DIR = path.join(__dirname, 'pdfs');
const SITE_URL = process.env.SITE_URL || 'https://mail-briefing-v2-production.up.railway.app';

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);

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
        const pdfs = (parsed.attachments || []).filter(
          (a) => a.contentType === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')
        );

        if (pdfs.length === 0) continue;

        for (const pdf of pdfs) {
          const safeName = (pdf.filename || `attachment_${uid}.pdf`).replace(/[\\/:*?"<>|]/g, '_');
          fs.writeFileSync(path.join(PDF_DIR, safeName), pdf.content);

          let pdfContent = '';
          try {
            const data = await pdfParse(pdf.content);
            pdfContent = data.text.trim();
          } catch (e) {
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

          console.log(`[저장] ${subject} - ${safeName}`);
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
