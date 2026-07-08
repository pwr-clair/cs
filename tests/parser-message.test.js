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

// parseAgoda_ 의 message 추출부 재현
function agodaMessage(body, guest){
  var lines = body.split('\n');
  var endIdx = lines.length;
  for(var i=0;i<lines.length;i++){ var t=lines[i].trim();
    if(t.indexOf('아래 원문 메시지')>=0 || t.indexOf('Did you know?')>=0 || t.indexOf('이전 메시지')>=0){ endIdx=i; break; } }
  var mm=[], started=false;
  for(var j=0;j<endIdx;j++){ var raw2=lines[j], u=raw2.trim();
    var isHeader = /^예약\s*번호/.test(u) || /^Reply from/i.test(u) || (guest && u===guest)
                 || /^\[image:/i.test(u) || /^https?:\/\//i.test(u) || /tracking\.agoda\.com/i.test(u);
    if(!started){ if(u===''||isHeader) continue; started=true; mm.push(raw2); }
    else { if(u===''||isHeader) break; mm.push(raw2); }
  }
  var out = { message: mm.join('\n').trim()||null, rawTail:false };
  if(!out.message){ out.message=body.trim()||null; out.rawTail=true; }
  return out;
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

print('[3] 아고다 신형 — 상단 트래킹/이미지 링크 제외, 게스트 질문만.');

var a1 = agodaMessage([
  '[image: Agoda.com]',
  'https://tracking.agoda.com/click?redirectUrl=https%3A%2F%2Fago.da%2Fx&token=abc123',
  'Reply from Jane Smith (Jul 11-12, 2026)',
  '',
  'Hi, can I check in early at 11am?',
  '',
  '아래 원문 메시지',
  '(지난 대화 인용...)'
].join('\n'), 'Jane Smith');
eq('3a agoda message = 질문만', a1.message, 'Hi, can I check in early at 11am?');
ok('3a tracking/image 미포함', noneOf(a1.message, ['tracking.agoda.com','[image:','redirectUrl']));
ok('3a rawTail=false', a1.rawTail===false);

// 3b) 못 뽑는 경우(헤더/트래킹뿐) → rawTail 폴백(전체는 dispatcher가 상한)
var a2 = agodaMessage([
  '[image: Agoda.com]',
  'https://tracking.agoda.com/click?token=only'
].join('\n'), 'Jane Smith');
ok('3b message 있음(폴백)', !!a2.message);
ok('3b rawTail=true', a2.rawTail===true);

print('결과: '+pass+' PASS / '+fail+' FAIL');
