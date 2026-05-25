async function sendTelegram(subject, pdfFilename, mailDate, siteUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[텔레그램] 토큰 또는 채팅 ID 없음 — 건너뜀');
    return;
  }

  // HTML 모드: 특수문자 이스케이프 후 볼드 태그 사용 (Markdown은 [] 문자 오류 발생)
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = `📋 <b>새 브리핑 도착!</b>\n\n📅 ${esc(mailDate)}\n📄 ${esc(subject)}\n🗂 ${esc(pdfFilename)}\n\n👉 ${siteUrl}`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });

  const data = await res.json();
  if (data.ok) {
    console.log('[텔레그램] 알림 전송 성공');
  } else {
    console.error('[텔레그램] 전송 실패:', JSON.stringify(data));
  }
}

module.exports = { sendTelegram };
