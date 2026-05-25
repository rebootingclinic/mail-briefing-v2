require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('./db');
const { sendTelegram } = require('./telegram');

const SENDER = 'ch-aide@aidepartners.com';
const SITE_URL = process.env.SITE_URL || 'https://mail-briefing-v2-production.up.railway.app';
const MAIL_LIMIT = parseInt(process.env.MAIL_LIMIT) || 0; // 0 = 무제한

// Stibee 트래킹 URL → Base64 디코딩
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
const SHORT_URL_DOMAINS = ['me2.do', 'bit.ly', 'han.gl', 'tinyurl.com', 'ow.ly'];

async function resolveShortUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    const finalUrl = res.url;

    // me2.do 중간 페이지 → HTML에서 실제 PDF URL 추출
    if (finalUrl.includes('me2.do') || finalUrl.includes('bridge_url')) {
      const html = await res.text();
      // storage.googleapis.com URL 직접 검색
      const storageMatch = html.match(/https?:\/\/storage\.googleapis\.com\/[^\s"'<>\\]+\.pdf/i);
      if (storageMatch) {
        console.log(`[me2.do 해석] → ${storageMatch[0].slice(0, 80)}`);
        return storageMatch[0];
      }
      // href 중 me2.do가 아닌 외부 링크 검색
      const hrefMatch = html.match(/href=["'](https?:\/\/(?!me2\.do)[^"']+)["']/);
      if (hrefMatch) return hrefMatch[1];
    }

    return finalUrl;
  } catch (e) {
    return null;
  }
}

// Claude API로 PDF 요약 (이미지 기반 PDF도 처리)
async function summarizePdf(pdfBuffer, subject) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return '(ANTHROPIC_API_KEY 없음 — 요약 불가)';
  }

  const MAX_PDF_SIZE = 5 * 1024 * 1024; // 5MB

  try {
    const client = new Anthropic();

    let content;
    if (pdfBuffer.length <= MAX_PDF_SIZE) {
      // Claude가 PDF 직접 분석 (텍스트+이미지 모두 인식)
      content = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBuffer.toString('base64'),
          },
        },
        {
          type: 'text',
          text: `이 PDF 보고서("${subject}")를 분석하여 한국어로 정리해주세요.

## 핵심 주제
한 줄로 핵심 요약

## 주요 내용
- 핵심 포인트 3~5개 (차트·그래프의 주요 수치도 포함)

## 시사점
실무적 의미와 활용 방향 2~3문장`,
        },
      ];
    } else {
      // 5MB 초과 대용량 PDF → 텍스트 추출 시도
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(pdfBuffer);
      const text = data.text.trim();
      if (!text || text.length < 100) {
        return `대용량 PDF(${Math.round(pdfBuffer.length / 1024 / 1024)}MB)이며 텍스트 추출이 불가능합니다. 원문 링크를 통해 직접 확인해주세요.`;
      }
      content = `이 보고서("${subject}")를 아래 형식으로 한국어 요약해주세요.\n\n## 핵심 주제\n## 주요 내용\n## 시사점\n\n---\n${text.slice(0, 8000)}`;
    }

    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content }],
    });

    return msg.content[0].text;
  } catch (e) {
    console.error('[요약 오류]', e.message, e.status || '');
    return `(요약 오류: ${e.message})`;
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

    if (url.toLowerCase().endsWith('.pdf') || url.includes('storage.googleapis.com')) {
      urls.add(url);
      continue;
    }

    if (url.includes('event.stibee.com/v2/click/')) {
      const decoded = decodeStibeeUrl(url);
      if (!decoded) continue;
      if (SKIP_DOMAINS.some((d) => decoded.includes(d))) continue;

      if (decoded.includes('storage.googleapis.com') && decoded.toLowerCase().includes('.pdf')) {
        urls.add(decoded);
      } else if (decoded.toLowerCase().endsWith('.pdf')) {
        urls.add(decoded);
      } else if (SHORT_URL_DOMAINS.some((d) => decoded.includes(d))) {
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
      const uids = await client.search({ from: SENDER }, { uid: true });
      console.log(`[검색] ${SENDER} 메일 ${uids.length}건 발견`);

      if (uids.length > 0) {
        const messages = client.fetch(
          uids,
          { uid: true, envelope: true, source: true },
          { uid: true }
        );

        for await (const msg of messages) {
          // MAIL_LIMIT 적용
          if (MAIL_LIMIT > 0 && newCount >= MAIL_LIMIT) break;

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

          const pdfUrls = await extractPdfUrls(html, text, subject);
          if (pdfUrls.length === 0) continue;

          // 첫 번째 PDF만 처리 (메일당 하나의 브리핑)
          const pdfUrl = pdfUrls[0];
          const rawName = pdfUrl.split('/').pop();
          const safeName = decodeURIComponent(rawName).replace(/[\\/:*?"<>|]/g, '_');

          // PDF 다운로드
          let pdfBuffer;
          try {
            const response = await fetch(pdfUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            pdfBuffer = Buffer.from(arrayBuffer);
            console.log(`[PDF] 다운로드 완료 — ${safeName} (${Math.round(pdfBuffer.length / 1024)}KB)`);
          } catch (e) {
            console.error(`[오류] PDF 다운로드 실패: ${e.message}`);
            continue;
          }

          // Claude로 요약
          const summary = await summarizePdf(pdfBuffer, subject);
          console.log(`[요약] 완료 — ${subject}`);

          const result = await db.execute({
            sql: `INSERT OR IGNORE INTO briefings (uid, subject, sender, mail_date, pdf_filename, pdf_content, pdf_url)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [uid, subject, SENDER, mailDate, safeName, summary, pdfUrl],
          });

          const briefingId = result.lastInsertRowid;
          const briefingUrl = briefingId ? `${SITE_URL}/briefing/${briefingId}` : SITE_URL;

          console.log(`[저장] ${subject}`);
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
  } finally {
    isChecking = false;
  }

  console.log(`[완료] 새 브리핑 ${newCount}건`);
  return { newCount };
}

module.exports = { checkMail };
