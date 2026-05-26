require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
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

// Gemini REST API로 PDF 요약 (SDK 없이 직접 호출)
async function summarizePdf(pdfBuffer, subject) {
  if (!process.env.GEMINI_API_KEY) {
    return { summary: '(GEMINI_API_KEY 없음 — 요약 불가)', chartPages: [] };
  }

  const prompt = `당신은 PDF 보고서 분석 전문가입니다. 아래 PDF("${subject}")를 분석하여 한국어로 상세한 브리핑을 작성해주세요.

**출력 분량 기준: 2500~3000자로 작성하세요. 3분 분량의 읽기 자료가 되어야 합니다.**

**필수 지침:**
- 텍스트뿐 아니라 PDF에 포함된 **모든 차트·그래프·표·이미지·인포그래픽**을 직접 읽고 수치를 추출하세요
- 차트를 보면 축의 값, 최고점·최저점, 변화 추세를 구체적으로 서술하세요 (예: "막대그래프 기준 서울 +3.2%, 경기 -1.1%")
- 표가 있으면 주요 행·열의 수치를 빠짐없이 비교하여 설명하세요
- 각 항목은 2~4문장 이상으로 충분히 서술하세요
- 수치, 날짜, 지역명, 통계 등 구체적 데이터를 최대한 많이 포함하세요

## 핵심 주제
이 보고서의 목적, 배경, 분석 범위를 3~4문장으로 설명하세요.

## 시각 자료 분석
PDF에 포함된 차트·그래프·표·인포그래픽을 모두 열거하고 각각의 핵심 수치와 의미를 설명하세요.
- 각 시각 자료의 제목 또는 내용을 명시하고
- 축 레이블, 최고값·최저값, 주요 변화 추세를 구체적 수치로 서술하세요
- 시각 자료가 없거나 텍스트만 있다면 이 섹션에 "해당 없음"이라고 적으세요

## 주요 내용
각 챕터·섹션별 핵심 내용을 5~7개 항목으로 서술하세요.
각 항목은 소제목과 함께 2문장으로 작성하고, 관련 수치·통계를 포함하세요.

## 주요 데이터 & 통계
보고서에서 언급된 핵심 수치, 비율, 순위, 금액, 변화율 등을 항목별로 정리하세요. (최소 5개 이상)

## 시사점 & 전망
이 보고서가 시장·실무·정책에 주는 함의와 향후 전망을 4~6문장으로 서술하세요.

---
**[차트 페이지 목록]** 위 브리핑을 모두 작성한 뒤, 마지막 줄에 아래 형식으로 중요한 차트·그래프·표·인포그래픽이 있는 PDF 페이지 번호를 JSON으로 출력하세요. PDF의 실제 페이지 순서(1부터 시작)를 기준으로 최대 15개까지:
{"chart_pages":[2,14,17,23,29]}`;

  // 시도할 모델 목록 (순서대로 시도)
  const candidates = [
    { version: 'v1beta', model: 'gemini-2.5-pro' },
    { version: 'v1beta', model: 'gemini-2.5-flash' },
  ];

  let parts;
  if (pdfBuffer.length <= 20 * 1024 * 1024) {
    parts = [
      { inline_data: { mime_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { text: prompt },
    ];
  } else {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdfBuffer);
    const text = data.text.trim();
    if (!text || text.length < 100) {
      return { summary: `대용량 PDF이며 텍스트 추출이 불가능합니다. 원문 링크를 통해 직접 확인해주세요.`, chartPages: [] };
    }
    parts = [{ text: `이 보고서("${subject}")를 요약해주세요.\n\n## 핵심 주제\n## 주요 내용\n## 시사점\n\n---\n${text.slice(0, 8000)}` }];
  }

  for (const { version, model } of candidates) {
    try {
      // Flash 2.5는 thinking 토큰이 output limit을 공유하므로 별도 설정
      const isFlash = model.includes('flash');
      const requestBody = {
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 16384, temperature: 0.3 },
        ...(isFlash && { thinkingConfig: { thinkingBudget: 3000 } }),
      };

      const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(120000),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error(`[요약] ${model}(${version}) 실패: ${res.status} ${JSON.stringify(json).slice(0, 150)}`);
        continue;
      }
      const candidate = json.candidates?.[0];
      const finishReason = candidate?.finishReason;
      // 여러 parts를 모두 합쳐서 완전한 텍스트 추출
      const rawText = (candidate?.content?.parts || []).map(p => p.text || '').join('');
      if (rawText) {
        // 마지막 줄에서 {"chart_pages":[...]} JSON 추출
        const jsonMatch = rawText.match(/\{"chart_pages"\s*:\s*\[[\d,\s]*\]\}/);
        let chartPages = [];
        let summary = rawText;
        if (jsonMatch) {
          try { chartPages = JSON.parse(jsonMatch[0]).chart_pages || []; } catch (e) {}
          summary = rawText.replace(jsonMatch[0], '').trim();
        }
        console.log(`[요약] ${model}(${version}) 성공 (finishReason: ${finishReason}, 길이: ${summary.length}자, 차트페이지: [${chartPages.join(',')}])`);
        return { summary, chartPages };
      }
      console.error(`[요약] ${model}(${version}) 응답 없음:`, JSON.stringify(json).slice(0, 150));
    } catch (e) {
      console.error(`[요약] ${model}(${version}) 오류:`, e.message);
    }
  }

  return { summary: '(요약 오류: 모든 Gemini 모델 실패 — Railway 로그 확인)', chartPages: [] };
}

// PDF 특정 페이지를 JPEG 이미지로 추출 후 DB 저장 (pdftoppm 사용)
async function extractAndStoreChartPages(pdfBuffer, briefingId, chartPages) {
  if (!chartPages || chartPages.length === 0) return;

  const tmpPdf = path.join(os.tmpdir(), `brief_${briefingId}_${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);
  } catch (e) {
    console.error(`[이미지] PDF 임시 저장 실패: ${e.message}`);
    return;
  }

  for (const pageNum of chartPages) {
    const tmpOut = path.join(os.tmpdir(), `brief_${briefingId}_p${pageNum}_${Date.now()}.jpg`);
    try {
      await new Promise((resolve, reject) => {
        execFile(
          'gs',
          [
            '-dNOPAUSE', '-dBATCH', '-dSAFER',
            '-sDEVICE=jpeg', '-dJPEGQ=82', '-r120',
            `-dFirstPage=${pageNum}`, `-dLastPage=${pageNum}`,
            `-sOutputFile=${tmpOut}`,
            tmpPdf,
          ],
          { timeout: 30000 },
          (err) => { if (err) reject(err); else resolve(); }
        );
      });

      if (fs.existsSync(tmpOut)) {
        const imgBuf = fs.readFileSync(tmpOut);
        await db.execute({
          sql: 'INSERT INTO briefing_pages (briefing_id, page_num, image_data) VALUES (?, ?, ?)',
          args: [briefingId, pageNum, imgBuf.toString('base64')],
        });
        fs.unlinkSync(tmpOut);
        console.log(`[이미지] p.${pageNum} 저장 완료`);
      } else {
        console.warn(`[이미지] p.${pageNum} 파일 없음`);
      }
    } catch (e) {
      console.error(`[이미지] p.${pageNum} 추출 실패: ${e.message}`);
    }
  }

  try { fs.unlinkSync(tmpPdf); } catch (e) {}
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
    for (let finalUrl of resolved) {
      if (!finalUrl) continue;

      // me2.do bridge URL이 그대로 반환된 경우 → url= 파라미터에서 실제 URL 추출
      if (finalUrl.includes('me2.do') || finalUrl.includes('bridge_url')) {
        try {
          const bridgeObj = new URL(finalUrl);
          const extracted = bridgeObj.searchParams.get('url') || bridgeObj.searchParams.get('URL');
          if (extracted && extracted.startsWith('http')) {
            console.log(`[bridge 추출] ${extracted.slice(0, 80)}`);
            finalUrl = extracted;
          }
        } catch (e) { /* ignore */ }
      }

      // me2.do URL이 아닌 경우만 추가
      if (!finalUrl.includes('me2.do') &&
          (finalUrl.toLowerCase().endsWith('.pdf') || finalUrl.includes('storage.googleapis.com'))) {
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

          // Gemini로 요약 (summary + chartPages 반환)
          const { summary, chartPages } = await summarizePdf(pdfBuffer, subject);
          console.log(`[요약] 완료 — ${subject}`);

          const result = await db.execute({
            sql: `INSERT OR IGNORE INTO briefings (uid, subject, sender, mail_date, pdf_filename, pdf_content, pdf_url)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [uid, subject, SENDER, mailDate, safeName, summary, pdfUrl],
          });

          const briefingId = result.lastInsertRowid;
          const briefingUrl = briefingId ? `${SITE_URL}/briefing/${briefingId}` : SITE_URL;

          // chart_pages를 DB에 저장 (나중에 이미지 재추출 가능하도록)
          if (briefingId && chartPages.length > 0) {
            await db.execute({
              sql: 'UPDATE briefings SET chart_pages = ? WHERE id = ?',
              args: [JSON.stringify(chartPages), Number(briefingId)],
            });
            console.log(`[이미지] ${chartPages.length}개 페이지 추출 시작: [${chartPages.join(',')}]`);
            await extractAndStoreChartPages(pdfBuffer, Number(briefingId), chartPages);
          }

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

module.exports = { checkMail, extractAndStoreChartPages };
