// 순수 로직 검증 (jsc) — gas/Code.gs stayStage_ + guardFlags_ 와 동일 구현.
// 배경: 2026-07-24 Rosie 건 — 도착 완료 게스트에게 "체크인 정보 곧 발송" 오답. 프롬프트에 예약 단계 부재가 원인.
function stayStage_(today, ci, co) {
  if (!ci && !co) return null;
  if (co && today > co) return 'post';
  if (co && today === co) return 'checkout';
  if (ci && today < ci) return 'pre';
  if (ci && today === ci) return 'checkin';
  return 'stay';
}
var GUARD_CODE_NOUN    = /(room (number|no\b)|access ?code|door ?code|객실 ?번호|도어 ?코드|비밀번호)/i;
var GUARD_SEND_FUTURE  = /(will (be )?sen[dt]|will send|we('ll| will) send|going to send|sent (to you )?shortly|shortly|soon|곧 |보내드릴|보내 ?드릴게|발송해 ?드릴|전송해 ?드릴)/i;
var GUARD_ARRIVAL_GUIDE = /(check[- ]?in is (from|at)|check[- ]?in starts|shuttle|bus 0?3|03번|셔틀|체크인은 15|오시는 ?길)/i;
function guardFlags_(stage, codeSent, reply) {
  var r = String(reply || ''), flags = [];
  if (GUARD_CODE_NOUN.test(r) && GUARD_SEND_FUTURE.test(r)) {
    if (stage === 'stay' || stage === 'checkout' || stage === 'post') flags.push('입실 이후 게스트에게 코드 발송을 다시 약속하는 문구');
    else if (codeSent === true) flags.push('체크인 안내 기발송인데 코드 발송을 새로 약속하는 문구');
  }
  if (stage === 'post' && GUARD_ARRIVAL_GUIDE.test(r)) flags.push('퇴실한 게스트에게 도착·체크인 안내 문구');
  return flags;
}

var pass = 0, fail = 0;
function eq(n, g, w) { var okk = JSON.stringify(g) === JSON.stringify(w); if (okk) pass++; else fail++; print((okk ? '  PASS ' : '  FAIL ') + n + (okk ? '' : '  got=' + JSON.stringify(g) + ' want=' + JSON.stringify(w))); }
function ok(n, c) { if (c) pass++; else fail++; print((c ? '  PASS ' : '  FAIL ') + n); }

print('[1] 단계 판정');
eq('도착 전',       stayStage_('2026-07-20', '2026-07-24', '2026-07-25'), 'pre');
eq('체크인 당일',   stayStage_('2026-07-24', '2026-07-24', '2026-07-25'), 'checkin');
eq('체크아웃일',    stayStage_('2026-07-25', '2026-07-24', '2026-07-25'), 'checkout');
eq('체크아웃 후',   stayStage_('2026-07-26', '2026-07-24', '2026-07-25'), 'post');
eq('숙박 중(장기)', stayStage_('2026-07-22', '2026-07-20', '2026-07-25'), 'stay');
eq('날짜 전무 → null', stayStage_('2026-07-24', null, null), null);
eq('체크인만·당일',   stayStage_('2026-07-24', '2026-07-24', null), 'checkin');
eq('체크아웃만·경과', stayStage_('2026-07-26', null, '2026-07-25'), 'post');

print('[2] 금칙 셀프체크 — Rosie 오답문 재현');
var rosie = "Welcome! So glad to hear you've arrived safely! Your room number and access code will be sent to you shortly through booking.com messenger.";
eq('숙박 중 + 코드 발송 약속 → 플래그', guardFlags_('stay', null, rosie), ['입실 이후 게스트에게 코드 발송을 다시 약속하는 문구']);
eq('체크인 당일 + 기발송 확인 → 플래그', guardFlags_('checkin', true, rosie), ['체크인 안내 기발송인데 코드 발송을 새로 약속하는 문구']);
eq('체크인 당일 + 발송 전 → 정상(약속이 맞음)', guardFlags_('checkin', false, rosie), []);
eq('도착 전 → 정상', guardFlags_('pre', null, rosie), []);

print('[3] 금칙 — 퇴실 후 도착 안내');
var arrGuide = 'Take bus 03 from gate 3, check-in is from 3 PM.';
eq('퇴실 후 + 셔틀·체크인 안내 → 플래그', guardFlags_('post', null, arrGuide), ['퇴실한 게스트에게 도착·체크인 안내 문구']);
eq('도착 전 + 같은 문구 → 정상', guardFlags_('pre', null, arrGuide), []);

print('[4] 금칙 — 오탐 가드');
eq('입실 후 단순 환영(코드 언급 없음) → 정상', guardFlags_('stay', true, 'So glad you arrived safely! Enjoy your stay.'), []);
eq('코드 언급만·발송 약속 없음 → 정상', guardFlags_('stay', true, 'Your door code is in the booking.com message we sent earlier.'), []);
ok('빈 reply 안전', guardFlags_('stay', true, null).length === 0);

print('결과: ' + pass + ' PASS / ' + fail + ' FAIL');
