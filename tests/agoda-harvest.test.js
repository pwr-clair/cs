// 순수 로직 검증 (jsc) — gas/Code.gs 아고다 히스토리 자동 수확(2026-08-05)과 동일 구현.
// 샘플 = probeHostReplyEvidence 실측 로그의 실물 스레드(SHIORI HANDA, 알림 11건짜리) 재구성.
// 기대: 시간순 (게스트→호스트) 인접쌍 3개, Room/Passcode 메시지는 답변에서 제외.

// ---- gas/Code.gs 와 동일 구현 ----
function normQ_(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…~]+$/, '').trim(); }
function isTrivialMessage_(s) {
  var t = normQ_(s);
  if (!t || t.length <= 3) return true;
  var TRIVIAL = /^(hi|hello|hey|yo|thanks|thank you|thx|ty|ok|okay|good (morning|afternoon|evening|night|day)|안녕하세요|안녕|감사합니다|감사해요|고맙습니다|고마워요|넵|네|알겠습니다|ありがとうございます|ありがとう|こんにちは|よろしくお願いします|谢谢|谢谢你|你好|好的)[\s!.~,]*$/i;
  return TRIVIAL.test(t);
}
function isAgodaEndMarker_(t) {
  if (!t) return false;
  return t.indexOf('Did you know?') >= 0
      || t.indexOf('이전 메시지') >= 0
      || t.indexOf('아래 원문') >= 0
      || t.indexOf('예약 관리') >= 0
      || t.indexOf('YCS') >= 0
      || t.indexOf('© ') >= 0 || t.indexOf('©Agoda') >= 0 || t.indexOf('Copyright') >= 0
      || t.indexOf('이 이메일') >= 0
      || t.indexOf('특별 요청 사항에 대한 동의') >= 0
      || t.indexOf('회신하려면') >= 0
      || /^[-─—=_]{3,}$/.test(t);
}
var AGODA_TS_ = /^\s*(.*?)\s*\d{1,2}월\s*\d{1,2},\s*\d{1,2}:\d{2}\s*(?:오전|오후)\s*ICT/;
function agodaHarvestNoise_(t) {
  if (!t) return false;
  return isAgodaEndMarker_(t)
    || t.indexOf('[image:') >= 0 || t.lastIndexOf('<http', 0) === 0
    || t.indexOf('Prompt replies') >= 0 || t.indexOf('Replying to this email') >= 0
    || t.indexOf('이 문의 사항에 답변하기') >= 0 || t.indexOf('다른 이메일에 답장하는 것과') >= 0
    || t.indexOf('저희가 처리하도록') >= 0 || t.indexOf('다운로드') >= 0
    || t.indexOf('투숙객과 실시간으로') >= 0 || t.indexOf('호텔 파트너를 위한') >= 0
    || /^예약\s*번호\s*[:：]/.test(t);
}
function agodaHistoryBlocks_(body) {
  var lines = String(body || '').split('\n');
  var blocks = [], cur = null, skipping = false;
  function flush() {
    if (cur) { var t = cur.buf.join('\n').replace(/\n{3,}/g, '\n\n').trim(); if (t) blocks.push({ who: cur.who, text: t }); }
    cur = null;
  }
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(AGODA_TS_);
    if (m) { flush(); cur = { who: (m[1].trim() ? 'guest' : 'host'), buf: [] }; skipping = true; continue; }
    if (!cur) continue;
    var t = lines[i].trim();
    if (skipping) { if (!t) skipping = false; continue; }
    if (agodaHarvestNoise_(t)) { flush(); continue; }
    cur.buf.push(t);
  }
  flush();
  return blocks;
}
function agodaHarvestPairs_(body) {
  var blocks = agodaHistoryBlocks_(body); blocks.reverse();
  var groups = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (groups.length && groups[groups.length - 1].who === b.who) groups[groups.length - 1].texts.push(b.text);
    else groups.push({ who: b.who, texts: [b.text] });
  }
  var pairs = [];
  for (var g = 1; g < groups.length && pairs.length < 10; g++) {
    if (groups[g].who !== 'host' || groups[g - 1].who !== 'guest') continue;
    var q = groups[g - 1].texts.join('\n\n').slice(0, 600);
    var hostTexts = [];
    for (var h = 0; h < groups[g].texts.length; h++) {
      if (/passcode\s*[:：]|room\s*[:：]|비밀번호\s*[:：]|출입\s*코드/i.test(groups[g].texts[h])) continue;
      hostTexts.push(groups[g].texts[h]);
    }
    var a = hostTexts.join('\n\n').slice(0, 1200);
    if (!a || a.length < 4 || isTrivialMessage_(q)) continue;
    pairs.push({ q: q, a: a });
  }
  return pairs;
}

// ---- 실물 재구성 샘플 (probeHostReplyEvidence ② 로그) ----
var BODY = [
' ',
'[image: Agoda.com] ',
'<http://tracking.agoda.com/click?cid=1798841&messageType=메시지> ',
'',
'仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス님, 안녕하세요.',
'현재 귀하의 숙소에 숙박 중인 투숙객에게서 온 메시지입니다. ',
'  ',
'[ 새 메시지 ] *문의 사항* (발신: SHIORI HANDA님) ',
'  ',
'현재 투숙객  ',
'  ',
'  SHIORI HANDA 8월 04, 08:59 오후 ICT   ',
'  예약 번호: 1756555974     ',
'  ',
'',
'ありがとうございます。無事到着できました🥲とても広くて綺麗なお部屋です。何から何まで丁寧な対応をありがとうございました！',
'아래 원문 메시지가 상단의 텍스트로 자동 번역됨 (Google Translate 이용)',
'ありがとうございます。',
'無事到着できました🥲',
'Did you know? ',
'Prompt replies to guests result in fewer cancellations and can improve ',
'review scores.',
'Replying to this email, will be sent directly to the guest.',
'YCS 앱에서 회신하기 ',
'<https://go.onelink.me/Vq0Z?pid=QR> ',
'투숙객과 실시간으로 채팅/대화하려면 YCS 앱을 사용하세요. ',
'다운로드 >> ',
'------------------------------',
'仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス 2026. 8. 4. - 2026. 8. 5. ',
'스튜디오 - 퀸베드룸 | 객실 1개 | 성인 1명 , 아동 0명 ',
'대표 투숙객 이름 : SHIORI HANDA ',
'  ',
'이 문의 사항에 답변하기, 매우 쉽습니다! ',
'다른 이메일에 답장하는 것과 같이 이 이메일에 회신하면 투숙객에게 바로 전송됩니다. ',
'저희가 처리하도록 하겠습니다.   ',
'  ',
'  8월 04, 08:53 오후 ICT 仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス   ',
'  ',
'  そうだったんですね！謝らないでください、こちらは全然大丈夫です！😊',
'',
'お気をつけてお越しくださいね！   ',
'  ',
'  SHIORI HANDA 8월 04, 08:51 오후 ICT   ',
'  ',
'  間違って別のホテルのメッセージを見てたみたいです。',
'本当に申し訳ありません💦   ',
'  ',
'  8월 04, 08:40 오후 ICT 仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス   ',
'  ',
'  問題ありませんのでご安心ください！先ほど送っていただいたお写真は、もしかして別の場所に入られてしまったのでしょうか…？ ',
'  ',
'  SHIORI HANDA 8월 04, 08:39 오후 ICT   ',
'  ',
'  違う場所にいたのでそちらのホテルにむかってます申し訳ありません   ',
'  ',
'  8월 04, 08:36 오후 ICT 仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス   ',
'  ',
'  現在、どちらにいらっしゃいますでしょうか？お送りしたオンラインガイド（ https://pwr-guide.online/ ）をぜひご確認ください！   ',
'  ',
'  8월 04, 08:34 오후 ICT 仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス   ',
'  ',
'  Room Info',
'- Room: 930 (Floor 9)',
'- Passcode: 5022*   ',
'  ',
'  8월 04, 08:34 오후 ICT 仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス   ',
'  ',
'  주소: IBC World Gate, 50, Gonghang-ro 424beon-gil, Jung-gu, Incheon   ',
'  ',
'  8월 04, 08:33 오후 ICT 仁川空港T1＆パラダイスシティ近くのセルフチェックイン専用レジデンス   ',
'  ',
'  현재 어디에 계신가요? 보내드리는 이 온라인 가이드를 꼭 한 번 읽어주세요. ',
'https://pwr-guide.online/   ',
'  ',
'  SHIORI HANDA 8월 04, 08:32 오후 ICT   ',
'  ',
'  住所とホテル名が分からないので教えて下さい   ',
'  ',
'  SHIORI HANDA 8월 04, 08:31 오후 ICT   ',
'  ',
'  分かりました',
'別のところと間違えたみたいです   ',
'  ',
'© Copyright Agoda 2026'
].join('\n');

var pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else fail++; print((c ? '  PASS ' : '  FAIL ') + n); }

var blocks = agodaHistoryBlocks_(BODY);
ok('블록 11개 추출(새 메시지 1 + 히스토리 10)', blocks.length === 11);
ok('첫 블록 = 게스트 새 메시지', blocks.length && blocks[0].who === 'guest' && blocks[0].text.indexOf('ありがとうございます') === 0);
ok('새 메시지에 번역 원문·푸터 미포함', blocks.length && blocks[0].text.indexOf('아래 원문') < 0 && blocks[0].text.indexOf('Did you know') < 0);
ok('호스트 블록에 CTA·예약요약 노이즈 미포함', blocks.every(function (b) { return b.text.indexOf('저희가 처리') < 0 && b.text.indexOf('스튜디오') < 0 && b.text.indexOf('대표 투숙객') < 0; }));

var pairs = agodaHarvestPairs_(BODY);
ok('쌍 3개(마지막 새 메시지는 미답이라 제외)', pairs.length === 3);
ok('쌍1 질문 = 연속 게스트 2건 병합', pairs.length === 3 && pairs[0].q.indexOf('分かりました') >= 0 && pairs[0].q.indexOf('住所とホテル名') >= 0);
ok('쌍1 답변에 주소·가이드 포함', pairs.length === 3 && pairs[0].a.indexOf('IBC World Gate') >= 0 && pairs[0].a.indexOf('pwr-guide.online') >= 0);
ok('쌍1 답변에서 Passcode 메시지 제외', pairs.length === 3 && pairs[0].a.indexOf('Passcode') < 0 && pairs[0].a.indexOf('930') < 0);
ok('쌍3 = 사과 → 안심 답변', pairs.length === 3 && pairs[2].q.indexOf('間違って別のホテル') >= 0 && pairs[2].a.indexOf('謝らないでください') >= 0);
ok('빈 본문 → 쌍 0개(안전)', agodaHarvestPairs_('').length === 0);
ok('히스토리 없는 알림(새 메시지만) → 쌍 0개', agodaHarvestPairs_('  KIM 8월 05, 09:00 오전 ICT\n  예약 번호: 123456\n  \n\n감기약 있나요?\nDid you know?') .length === 0);

print(pass + ' PASS / ' + fail + ' FAIL');
