require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const { db } = require('./db');
const { sendTelegram } = require('./telegram');

const SENDER = 'ch-aide@aidepartners.com';
const SITE_URL = process.env.SITE_URL || 'https://mail-briefing-v2-production.up.railway.app';

// Stibee 트래킹 URL에서 실제 URL 추출 (Base64 디코딩)
function decodeStibeeUrl(stibeeUrl) {
  try {
    const lastSlash = stibeeUrl.lastIndexOf('/');
    if (lastSlash === -1) return null;
    const base64Part = stibeeUrl.slice(lastSlash + 1);
    const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
    return decoded.startsWith('http') ? decoded : null;
  } catch (e) {
    return null;
  }
}

const SKIP_DOMAINS = ['facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'youtube.com'];

// 이메일 본문에서 PDF URL 추출
async function extractPdfUrls(html, text, subject) {
  const urls = new Set();

  const hrefPattern = /href=["']([^"']+)["']/gi;
  const stibeeTargets = new Set();
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    const url = match[1];

    // 직접 .pdf 링크
    if (url.toLowerCase().endsWith('.pdf') || url.includes('storage.googleapis.com')) {
      urls.add(url);
      continue;
    }

    // Stibee 트래킹 URL → Base64 디코딩
    if (url.includes('event.stibee.com/v2/click/')) {
      const decoded = decodeStibeeUrl(url);
      if (!decoded) continue;
      if (SKIP_DOMAINS.some((d) => decoded.includes(d))) continue;
      stibeeTargets.add(decoded);
    }
  }

  // 텍스트에서 직접 PDF URL 찾기
  const textPattern = /https?:\/\/\S+\.pdf/gi;
  for (const m of (text.match(textPattern) || [])) urls.add(m);

  // 디코딩된 Stibee URL 처리 (리디렉트 없이 빠르게)
  for (const target of stibeeTargets) {
    if (target.includes('storage.googleapis.com') && target.toLowerCase().includes('.pdf')) {
      urls.add(target);
    } else if (target.toLowerCase().endsWith('.pdf')) {
      urls.add(target);
    }
  }

  // 직접 찾기 실패 → 디코딩 결과 로그 출력 후 단축 URL 1개만 추적
  if (urls.size === 0 && stibeeTargets.size > 0) {
    console.log(`[디버그] "${subject}" 디코딩 결과 ${stibeeTargets.size}개:`);
    [...stibeeTargets].slice(0, 8).forEach((u, i) => console.log(`  [${i}] ${u.slice(0, 120)}`));
  }

  return [...urls];
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
      // 발신자로 UID 검색
      const uids = await client.search({ from: SENDER }, { uid: true });
      console.log(`[검색] ${SENDER} 메일 ${uids.length}건 발견`);

      if (uids.length > 0) {
        const messages = client.fetch(
          uids,
          { uid: true, envelope: true, source: true },
          { uid: true }
        );

        for await (const msg of messages) {
          const uid = String(msg.uid);

          // 이미 처리한 메일이면 스킵
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

          const pdfUrls = await extractPdfUrls(html, text, subject);

          if (pdfUrls.length === 0) {
            console.log(`[스킵] ${subject} — PDF 링크 없음`);
            continue;
          }

          for (const pdfUrl of pdfUrls) {
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
