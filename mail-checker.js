require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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
    console.log(`[단축URL] 해석 시작: ${url}`);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    const finalUrl = res.url;
    console.log(`[단축URL] 최종 URL: ${finalUrl.slice(0, 120)}`);

    // 이미 storage.googleapis.com으로 리디렉트된 경우
    if (finalUrl.includes('storage.googleapis.com')) {
      return finalUrl;
    }

    // me2.do bridge URL → ?url= 파라미터에 실제 목적지가 담겨 있음
    if (finalUrl.includes('me2.do') || finalUrl.includes('bridge_url')) {
      try {
        const parsed = new URL(finalUrl);
        const orgUrl = parsed.searchParams.get('url') || parsed.searchParams.get('URL');
        if (orgUrl && orgUrl.startsWith('http')) {
          const decoded = decodeURIComponent(orgUrl);
          console.log(`[me2.do bridge] url 파라미터 추출 성공: ${decoded.slice(0, 80)}`);
          return decoded;
        }
      } catch (e) {
        console.log(`[me2.do bridge] URL 파싱 실패, HTML 폴백`);
      }

      // HTML 폴백: storage.googleapis.com PDF URL
      const html = await res.text();
      const storageMatch = html.match(/https?:\/\/storage\.googleapis\.com\/[^\s"'<>\\]+\.pdf/i);
      if (storageMatch) {
        console.log(`[me2.do HTML] storage URL 발견: ${storageMatch[0].slice(0, 80)}`);
        return storageMatch[0];
      }

      // HTML 폴백: JS redirect
      const jsMatch = html.match(/(?:window\.location(?:\.href)?\s*=|location\.replace\()\s*["'](https?:\/\/[^"']+)["']/);
      if (jsMatch) {
        console.log(`[me2.do HTML] JS redirect: ${jsMatch[1].slice(0, 80)}`);
        return jsMatch[1];
      }

      console.log(`[me2.do] 해석 실패 — finalUrl: ${finalUrl.slice(0, 100)}`);
    }

    return finalUrl;
  } catch (e) {
    console.error(`[단축URL] 오류: ${url} → ${e.message}`);
    return null;
  }
}

// Gemini API로 PDF 요약 (텍스트+이미지 모두 인식)
async function summarizePdf(pdfBuffer, subject) {
  if (!process.env.GEMINI_API_KEY) {
    return '(GEMINI_API_KEY 없음 — 요약 불가)';
  }

  const MAX_INLINE_SIZE = 20 * 1024 * 1024; // Gemini 인라인 최대 20MB

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `이 PDF 보고서("${subject}")를 분석하여 한국어로 정리해주세요.

## 핵심 주제
한 줄로 핵심 요약

## 주요 내용
- 핵심 포인트 3~5개 (차트·그래프의 주요 수치도 포함)

## 시사점
실무적 의미와 활용 방향 2~3문장`;

    let result;

    if (pdfBuffer.length <= MAX_INLINE_SIZE) {
      // PDF를 base64로 직접 전달 (텍스트+이미지 모두 인식)
      result = await model.generateContent([
        { inlineData: { data: pdfBuffer.toString('base64'), mimeType: 'application/pdf' } },
        prompt,
      ]);
    } else {
      // 20MB 초과 → pdf-parse로 텍스트 추출
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(pdfBuffer);
      const text = data.text.trim();
      if (!text || text.length < 100) {
        return `대용량 PDF(${Math.round(pdfBuffer.length / 1024 / 1024)}MB)이며 텍스트 추출이 불가능합니다. 원문 링크를 통해 직접 확인해주세요.`;
      }
      result = await model.generateContent(
        `이 보고서("${subject}")를 아래 형식으로 한국어 요약해주세요.\n\n## 핵심 주제\n## 주요 내용\n## 시사점\n\n---\n${text.slice(0, 8000)}`
      );
    }

    console.log('[요약] Gemini 성공');
    return result.response.text();
  } catch (e) {
    console.error('[요약 오류]', e.message);
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
