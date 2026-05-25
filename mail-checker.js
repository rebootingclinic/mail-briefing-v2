require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
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
// PDF 링크를 감추는 단축 URL 서비스
const SHORT_URL_DOMAINS = ['me2.do', 'bit.ly', 'han.gl', 'tinyurl.com', 'ow.ly'];

async function resolveShortUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    return res.url;
  } catch (e) {
    return null;
  }
}

async function summarizePdf(pdfText, subject) {
  if (!process.env.ANTHROPIC_API_KEY) return pdfText;

  if (!pdfText || pdfText.length < 100) {
    return '이 PDF는 텍스트 추출이 되지 않는 이미지 기반 파일입니다.';
  }

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `다음은 "${subject}" 보고서입니다. 아래 형식으로 한국어 요약을 작성해주세요.

## 핵심 주제
한 줄로 요약

## 주요 내용
- 핵심 포인트를 3~5개 불릿으로

## 시사점
실무적 의미와 활용 방향 2~3문장

---
보고서 내용:
${pdfText.slice(0, 8000)}`,
      }],
    });
    return msg.content[0].text;
  } catch (e) {
    console.error('[요약 오류]', e.message);
    return pdfText.slice(0, 3000);
  }
}

// 이메일 본문에서 PDF URL 추출
async function extractPdfUrls(html, text, subject) {
  const urls = new Set();
  const shortUrls = new Set();

  const hrefPattern = /href=["']([^"']+)["']/gi;
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

      // 직접 Google Storage PDF
      if (decoded.includes('storage.googleapis.com') && decoded.toLowerCase().includes('.pdf')) {
        urls.add(decoded);
      } else if (decoded.toLowerCase().endsWith('.pdf')) {
        urls.add(decoded);
      }
      // 단축 URL (me2.do 등) → 나중에 추적
      else if (SHORT_URL_DOMAINS.some((d) => decoded.includes(d))) {
        shortUrls.add(decoded);
      }
    }
  }

  // 텍스트에서 직접 PDF URL 찾기
  const textPattern = /https?:\/\/\S+\.pdf/gi;
  for (const m of (text.match(textPattern) || [])) urls.add(m);

  // 단축 URL 병렬 리디렉트 추적
  if (urls.size === 0 && shortUrls.size > 0) {
    const uniqueShort = [...shortUrls];
    console.log(`[단축URL] "${subject}" — ${uniqueShort.length}개 병렬 확인 중`);
    const resolved = await Promise.all(uniqueShort.map(resolveShortUrl));
    for (const finalUrl of resolved) {
      if (!finalUrl) continue;
      if (finalUrl.toLowerCase().endsWith('.pdf') || finalUrl.includes('storage.googleapis.com')) {
        urls.add(finalUrl);
      }
    }
  }

  if (urls.size === 0) {
    console.log(`[스킵] "${subject}" — PDF 링크 없음`);
  }

  return [...urls];
}

let isChecking = false;

async function checkMail() {
  if (isChecking) {
    console.log('[스킵] 이미 메일 확인 중...');
    return { newCount: 0 };
  }
  isChecking = true;
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

          if (pdfUrls.length === 0) continue;

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
              pdfContent = await summarizePdf(pdfContent, subject);
              console.log(`[요약] 완료 — ${subject}`);
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
  } finally {
    isChecking = false;
  }

  console.log(`[완료] 새 브리핑 ${newCount}건`);
  return { newCount };
}

module.exports = { checkMail };
