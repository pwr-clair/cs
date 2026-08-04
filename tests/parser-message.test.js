// 순수 로직 검증 (jsc) — gas/Code.gs 의 message 추출 로직과 동일 구현.
// 대상: parseBookingCh_ (신형/레거시 message 추출) + parseAgoda_ (헤더/트래킹 제외).
// bookingId·게스트명·예약상세 파싱은 범위 밖(이번 수정은 message 추출뿐) → 여기서 미검증.

// ---- gas/Code.gs 와 동일 헬퍼 ----
function isBookingEndMarker_(t){
  return t==='답변' || t==='Reply' || t.indexOf('-->')===0
      || t.indexOf('예약 상세 정보')===0 || t.indexOf('Reservation details')===0
      || t.indexOf('© Copyright')===0;
}
function isBookingHeaderLine_(t, subject, guest){
  if(/^\[image:/i.test(t)) return true;
  if(/^https?:\/\//i.test(t)) return true;
  if(subject && t===String(subject).trim()) return true;
  if(guest && t===guest) return true;
  return false;
}

// parseBookingCh_ 의 message 추출부(줄단위) 재현
function bookingMessage(body, subject, guest){
  var lines = body.split('\n');
  var out = { message:null, rawTail:false, guest: guest||null };
  var si = -1;
  for(var i=0;i<lines.length;i++){ var t=lines[i].trim(); if(/said:\s*$/i.test(t) || t.indexOf('님의 메시지:')>=0){ si=i; break; } }
  if(si>=0){
    if(!out.guest){ var sm=lines[si].trim().match(/^(.*?)\s+said:\s*$/i); if(sm) out.guest=sm[1].trim(); }
    var msg=[];
    for(var j=si+1;j<lines.length;j++){ if(isBookingEndMarker_(lines[j].trim())) break; msg.push(lines[j]); }
    out.message = msg.join('\n').trim() || null;
  } else {
    var picked=[], began=false, hitEnd=false;
    for(var k=0;k<lines.length;k++){ var w=lines[k].trim();
      if(isBookingEndMarker_(w)){ hitEnd=began; break; }
      if(!began){ if(w===''||isBookingHeaderLine_(w,subject,out.guest)) continue; began=true; picked.push(lines[k]); }
      else picked.push(lines[k]);
    }
    if(began){ out.message=picked.join('\n').trim()||null; if(!hitEnd) out.rawTail=true; }
    else { out.message=body.trim()||null; out.rawTail=true; }
  }
  return out;
}

// parseAgoda_ 의 message 추출부 재현 — 앵커 3종(레거시 "메시지:" / 예약번호 줄 / ICT 타임스탬프 줄).
function isAgodaEnd(t){ if(!t) return false;
  return t.indexOf('Did you know?')>=0||t.indexOf('이전 메시지')>=0||t.indexOf('아래 원문')>=0
    ||t.indexOf('예약 관리')>=0||t.indexOf('YCS')>=0||t.indexOf('© ')>=0||t.indexOf('©Agoda')>=0||t.indexOf('Copyright')>=0
    ||t.indexOf('이 이메일')>=0||t.indexOf('특별 요청 사항에 대한 동의')>=0||t.indexOf('회신하려면')>=0||/^[-─—=_]{3,}$/.test(t); }
function agodaMessage(body){
  var lines=body.split('\n'), startAt=-1;
  for(var i=0;i<lines.length;i++){                       // ①레거시 라벨 전체 선행 스캔(최우선)
    if(/^\s*메시지\s*[:：]/.test(lines[i]) && !/이전\s*메시지/.test(lines[i])){
      lines[i]=lines[i].replace(/^\s*메시지\s*[:：]\s*/,''); startAt=i; break; }
  }
  if(startAt<0){ var bkAt=-1, tsAt=-1;
    for(var i2=0;i2<lines.length;i2++){
      if(/예약\s*번호\s*[:：]\s*[0-9]{6,}/.test(lines[i2])){ bkAt=i2+1; break; }                                  // ②
      if(tsAt<0 && /\d{1,2}월\s*\d{1,2},\s*\d{1,2}:\d{2}\s*(?:오전|오후)\s*ICT/.test(lines[i2])) tsAt=i2+1;        // ③
    }
    startAt = bkAt>=0 ? bkAt : tsAt;
  }
  var out={message:null, extractFailed:false};
  if(startAt>=0){ var c=[];
    for(var j=startAt;j<lines.length && c.length<40;j++){ var t=lines[j].trim();
      if(isAgodaEnd(t))break;
      if(!c.length && (!t || /고객님,?\s*안녕하세요/.test(t))) continue;
      c.push(lines[j]); }
    out.message=c.join('\n').trim()||null; if(out.message&&out.message.length>1500)out.message=out.message.slice(0,1500); }
  if(!out.message)out.extractFailed=true;
  return out;
}
// parseAgoda_ 의 bookingId 추출부 재현 — 본문 콜론형 우선, 없으면 제목 "Booking ID {번호}" 폴백.
function agodaBookingId(body, subject){
  var mk=body.match(/예약\s*번호\s*[:：]\s*([0-9]{6,})/);
  return mk ? mk[1] : ((String(subject||'').match(/Booking\s*ID\s*([0-9]{6,})/i)||[])[1] || null);
}

var pass=0, fail=0;
function eq(n,g,w){ var okk=JSON.stringify(g)===JSON.stringify(w); if(okk)pass++;else fail++; print((okk?'  PASS ':'  FAIL ')+n+(okk?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w))); }
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }
function noneOf(hay, arr){ for(var i=0;i<arr.length;i++){ if(hay && hay.indexOf(arr[i])>=0) return false; } return true; }

// 신형 부킹 꼬리(답변/트래킹/예약상세/푸터) — message에서 전부 빠져야 함
var BK_TAIL = [
  '',
  '답변',
  '',
  '-->',
  'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging/inbox.html?res_id=1234567890&lang=ko',
  '',
  '예약 상세 정보',
  '투숙객 성함: John Doe',
  '체크인: 2026-07-08',
  '체크아웃: 2026-07-09',
  '숙소 명칭: Paradise Walk Residence',
  '예약 번호: 1234567890',
  '총 투숙객 수: 1',
  '총 객실 수: 1',
  '© Copyright Booking.com 2026'
];
var TAIL_TOKENS = ['답변','-->','admin.booking.com','예약 상세 정보','투숙객 성함','© Copyright'];

print('[1] 부킹 신형 — 시작마커 없음(이 계정 실물). 게스트 원문만.');

// 1a) 검증 기준 케이스: "Check-out complete" (본문 최상단에 메시지)
var b1 = bookingMessage(['Check-out complete'].concat(BK_TAIL).join('\n'), 'John Doe 님의 메시지가 도착했습니다', 'John Doe');
eq('1a message = "Check-out complete"', b1.message, 'Check-out complete');
ok('1a 꼬리 미포함', noneOf(b1.message, TAIL_TOKENS));
ok('1a rawTail=false(깨끗)', b1.rawTail===false);

// 1b) 검증 기준 케이스: Terminal 2 질문
var q = "If I need to get to Terminal 2 from here at 5 a.m. tomorrow, what's the best way to do it?";
var b2 = bookingMessage([q].concat(BK_TAIL).join('\n'), 'John Doe 님의 메시지가 도착했습니다', 'John Doe');
eq('1b message = 질문 원문', b2.message, q);
ok('1b 꼬리 미포함', noneOf(b2.message, TAIL_TOKENS));

// 1c) 상단 헤더(이미지 alt·트래킹 URL·제목 반복·게스트명 반복) 스킵 후 메시지
var subj = 'John Doe 님의 메시지가 도착했습니다';
var b3 = bookingMessage([
  '[image: Booking.com]',
  'https://secure.booking.com/track/open?token=xyz',
  subj,
  'John Doe',
  '',
  'Can I get an early check-in?'
].concat(BK_TAIL).join('\n'), subj, 'John Doe');
eq('1c 헤더 스킵 후 메시지', b3.message, 'Can I get an early check-in?');
ok('1c 헤더/트래킹 미포함', noneOf(b3.message, ['[image:','secure.booking.com', subj]));

// 1d) 여러 줄 메시지 보존(종료마커 전까지)
var b4 = bookingMessage(['Line one','Line two'].concat(BK_TAIL).join('\n'), subj, 'John Doe');
eq('1d 멀티라인 보존', b4.message, 'Line one\nLine two');

print('[2] 부킹 레거시 — "said:"/"님의 메시지:" 시작마커(참고 3건). 회귀 없음.');

// 2a) EN said:
var l1 = bookingMessage([
  'We received a message from your guest.',
  '',
  'John Doe said:',
  'Hello, what time is check-in?',
  '',
  'Reply',
  '-->',
  'https://admin.booking.com/...'
].join('\n'), 'We received this message from John Doe', null);
eq('2a EN said: message', l1.message, 'Hello, what time is check-in?');
ok('2a guest 추출', l1.guest==='John Doe');

// 2b) KO 님의 메시지:
var l2 = bookingMessage([
  '홍길동 님의 메시지:',
  '체크인 몇 시인가요?',
  '',
  '답변',
  '-->',
  'https://admin.booking.com/...'
].join('\n'), '홍길동 님의 메시지가 도착했습니다', '홍길동');
eq('2b KO message', l2.message, '체크인 몇 시인가요?');

print('[3] 아고다 — "메시지:" 라벨 뒤 실제 본문만, 상단 껍데기 제외.');

var a1 = agodaMessage([
  '파라다이스워크 레지던스 숙소님, 안녕하세요.',
  '귀하의 숙소에 숙박 예정인 여행객에게서 온 메시지입니다.',
  '[새 메시지] 문의 사항 (발신: Jane Smith님)',
  '예약 번호: 1234567890',
  '메시지: Hi, can I check in early at 11am?',
  '',
  'Did you know?',
  'YCS 앱에서 더 빠르게...'
].join('\n'));
eq('3a 껍데기 제외·본문만', a1.message, 'Hi, can I check in early at 11am?');
ok('3a 껍데기 미포함', noneOf(a1.message||'', ['안녕하세요','여행객','[새 메시지]','예약 번호']));
ok('3a extractFailed=false', a1.extractFailed===false);

// QIQI WU 실사례(예약 1737525767) — 본문에 'agoda:'·숫자 있어도 정확 추출
var q = agodaMessage([
  '파라다이스워크 레지던스 숙소님, 안녕하세요.',
  '[새 메시지] 문의 사항 (발신: QIQI WU님)',
  '예약 번호: 1737525767',
  '메시지: this is the booking number from agoda:1737525767 and I booked the room on July 11th',
  'Did you know?'
].join('\n'));
eq('QIQI 본문 정확 추출', q.message, 'this is the booking number from agoda:1737525767 and I booked the room on July 11th');

// 3b) "메시지:" 라벨 없음 → 껍데기 넣지 않고 추출 실패(엉뚱한 초안 방지)
var a2 = agodaMessage([
  '파라다이스워크 레지던스 숙소님, 안녕하세요.',
  '귀하의 숙소에 숙박 예정인 여행객에게서 온 메시지입니다.'
].join('\n'));
ok('3b 라벨 없으면 message null', a2.message===null);
ok('3b extractFailed=true(껍데기 미덤프)', a2.extractFailed===true);

print('[4] 아고다 신형 2종 — "메시지:" 라벨 폐기(2026-08-04 실물 MIME 확인) 후에도 본문 추출');

// 4a) Inquiry/Reply형 — 예약번호 줄 다음이 게스트 본문. (Nicolas Da Fonseca 실사례 구조)
var n1 = agodaMessage([
  'Self Check-in Only Residence near Incheon Airport T1 & Paradise City님, 안녕하세요.',
  '현재 귀하의 숙소에 숙박 중인 투숙객에게서 온 메시지입니다.',
  '[ 새 메시지 ] 문의 사항 (발신: Nicolas Da Fonseca님)',
  '현재 투숙객',
  'Nicolas Da Fonseca 8월 04, 10:45 오전 ICT',
  '예약 번호: 2037763170',
  'こんにちは。午後3時に到着予定です。よろしくお願いします。',
  '아래 원문 메시지가 상단의 텍스트로 자동 번역됨 (Google Translate 이용)',
  'Hello, we will arrive at 3pm. Thank you'
].join('\n'));
eq('4a 예약번호 줄 다음이 본문', n1.message, 'こんにちは。午後3時に到着予定です。よろしくお願いします。');
ok('4a 껍데기·이력 미포함', noneOf(n1.message||'', ['안녕하세요','투숙객에게서','새 메시지','예약 번호','자동 번역']));
ok('4a extractFailed=false', n1.extractFailed===false);
eq('4a bookingId 본문에서', agodaBookingId('예약 번호: 2037763170', 'Inquiry by Nicolas Da Fonseca (Aug 4-5, 2026)'), '2037763170');

// 4b) Special Request형 — 본문에 예약번호 줄이 없음. ICT 타임스탬프 다음이 본문, 인사말 줄은 스킵.
var s1 = agodaMessage([
  '새 메시지(발신: Jeong Seop Son)',
  'Jeong Seop Son 8월 04, 12:18 오후 ICT',
  '',
  '무인 체크인 전용, 인천공항 T1·파라다이스시티 인근 레지던스 고객님, 안녕하세요.,',
  '',
  'ArrivalTime:20 00 - 21 00',
  '',
  '특별 요청 사항에 대한 동의 여부를 하단에서 확인해 주시기 바랍니다.',
  '반영 가능',
  'YCS를 통해 답장하기'
].join('\n'));
eq('4b 타임스탬프 다음이 본문(인사말 스킵)', s1.message, 'ArrivalTime:20 00 - 21 00');
ok('4b 동의 안내 푸터 미포함', noneOf(s1.message||'', ['특별 요청','반영 가능','YCS','안녕하세요']));
ok('4b extractFailed=false', s1.extractFailed===false);
eq('4b bookingId 제목 폴백', agodaBookingId('예약 번호 • 체크인 • 체크아웃\n1757360771 2026. 8. 5.', 'Special Request for Booking ID 1757360771 (Aug 5-6, 2026)'), '1757360771');

// 4c) [회귀 감시] 하단 과거 대화 이력의 타임스탬프에 앵커가 걸리면 옛 메시지를 본문으로 오추출
var h1 = agodaMessage([
  '새 메시지(발신: K im)',
  'K im 7월 29, 06:34 오전 ICT',
  '지금 보낸 새 문의입니다',
  'Did you know?',
  '8월 03, 05:04 오전 ICT Self Check-in Only Residence',
  '■ 체크인 안내 — 옛 발송 이력입니다'
].join('\n'));
eq('4c 첫 타임스탬프만 앵커(이력 오추출 방지)', h1.message, '지금 보낸 새 문의입니다');

// 4d) 레거시 "메시지:" 라벨이 돌아와도 그대로 동작(우선 앵커)
var g1 = agodaMessage([
  '[새 메시지] 문의 사항 (발신: Jane Smith님)',
  '예약 번호: 1234567890',
  '메시지: legacy label still wins',
  'Did you know?'
].join('\n'));
eq('4d 레거시 라벨 우선', g1.message, 'legacy label still wins');

print('결과: '+pass+' PASS / '+fail+' FAIL');
