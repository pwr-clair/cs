// 순수 로직 검증 (jsc) — 2026-07-29 후기 정책 개편
//   ① reviewEligible_: 체크아웃 1일+·7일 내 + 불만 0 + 긍정 2 이상
//   ② reviewTemplateFor_: 한국어 대화=한국어, 그 외 전부 영어
//   ③ 고정 문구가 발송단 이모지 제거(stripEmoji_)를 통과해도 무변형(⭐·→ 사전 제거 확인)
// gas/Code.gs와 동일 구현 복제.

function reviewEligible_(s, yesterday, windowStart) {
  if (!s || !s.checkoutDate) return false;
  if (s.checkoutDate > yesterday || s.checkoutDate < windowStart) return false;
  if ((s.negCount || 0) > 0) return false;
  return (s.posCount || 0) >= 2;
}
var REVIEW_MSG_EN =
  'Dear guest,\n\n' +
  'Thank you so much for staying at Paradise Walk Residence. We hope you had a relaxing trip back home!\n\n' +
  'As a newly opened property, we always want to improve. If anything was uncomfortable, please reply here — we would love to make it better for your next visit.\n\n' +
  'If you were happy with your stay, would you take a moment to leave us a 10-score review?\n' +
  'It helps our small business so much!\n\n' +
  '[ How to leave a review ]\n' +
  'Bookings > select your booking > Review your stay\n' +
  '*The booking platform will also send you a review invitation by email — either way works!\n\n' +
  'It was a pleasure having you.\n' +
  'Safe travels, and we hope to welcome you back!\n\n' +
  'Warm regards,\n' +
  'Paradise Walk Residence';
var REVIEW_MSG_KO =
  '고객님께,\n\n' +
  '저희 숙소를 선택해 주셔서 진심으로 감사드립니다.\n' +
  '혹시 머무신 경험이 만족스러우셨다면 잠시 시간 내어 10점짜리 후기를 부탁드려도 될까요? 저희 숙소는 최근 운영을 시작하여 예약 플랫폼 내 후기가 많이 부족한 상황이기에 간단히 남겨주시는 리뷰라도 정말 큰 힘이 됩니다!\n\n' +
  '[ 후기 남기는 방법 ]\n' +
  '예약 내역 > 숙소 선택 > 숙박 후기 남기기\n' +
  '*예약하신 플랫폼에서 이메일로도 후기 안내가 갑니다. 어느 쪽이든 괜찮습니다!\n\n' +
  '만약 운영상의 미흡함으로 인해 불편하셨던 점이 있었다면 이 메시지로 회신을 부탁드리겠습니다. 고객님의 피드백을 무겁게 수용하여 더욱 좋은 모습으로 거듭나겠습니다.\n\n' +
  '저희 숙소를 선택해주셔서 다시 한 번 감사드립니다. 다음 번에 또 좋은 기회로 고객님을 다시 모실 수 있게 되기를 바라겠습니다.\n\n' +
  '감사합니다.';
function reviewTemplateFor_(lang) {
  return String(lang || '').toLowerCase() === 'ko'
    ? { lang: 'ko', text: REVIEW_MSG_KO } : { lang: 'en', text: REVIEW_MSG_EN };
}
function stripEmoji_(s) {
  return String(s == null ? '' : s)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/[←-⇿⌀-➿⬀-⯿〰〽㊗㊙©®]/g, '')
    .replace(/[︀-️‍⃣]/g, '')
    .replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function subShortcuts_(s) { return String(s == null ? '' : s).replace(/\{\s*(가이드|guide)\s*\}/gi, 'https://pwr-guide.online'); }
function outText_(s) { return stripEmoji_(subShortcuts_(s)); }

var pass=0, fail=0;
function eq(n,g,w){ var o=JSON.stringify(g)===JSON.stringify(w); if(o)pass++;else fail++;
  print((o?'  PASS ':'  FAIL ')+n+(o?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w))); }
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }

print('[1] 선별 기준 — 체크아웃 1일+·7일 내 + 불만 0 + 긍정 2+');
var Y='2026-07-28', W='2026-07-22'; // yesterday, windowStart(7일)
ok('긍정 2·불만 0·어제 체크아웃 → 대상', reviewEligible_({checkoutDate:'2026-07-28',posCount:2,negCount:0},Y,W)===true);
ok('긍정 1 → 제외(기준 강화의 핵심)', reviewEligible_({checkoutDate:'2026-07-28',posCount:1,negCount:0},Y,W)===false);
ok('긍정 3·불만 1 → 제외', reviewEligible_({checkoutDate:'2026-07-28',posCount:3,negCount:1},Y,W)===false);
ok('오늘 체크아웃(1일 미경과) → 제외', reviewEligible_({checkoutDate:'2026-07-29',posCount:5,negCount:0},Y,W)===false);
ok('6일 전 체크아웃 → 대상(1일 이상 조건 충족)', reviewEligible_({checkoutDate:'2026-07-23',posCount:2,negCount:0},Y,W)===true);
ok('8일 전 체크아웃 → 제외(뒷북 방지 7일 창)', reviewEligible_({checkoutDate:'2026-07-21',posCount:2,negCount:0},Y,W)===false);
ok('체크아웃일 미상 → 제외', reviewEligible_({posCount:9,negCount:0},Y,W)===false);
ok('posCount 없음 → 제외', reviewEligible_({checkoutDate:'2026-07-28'},Y,W)===false);

print('[2] 언어 선택 — 한국어만 한국어, 나머지 전부 영어');
eq('ko → 한국어 문구', reviewTemplateFor_('ko').lang, 'ko');
eq('en → 영어', reviewTemplateFor_('en').lang, 'en');
eq('ja → 영어', reviewTemplateFor_('ja').lang, 'en');
eq('zh → 영어', reviewTemplateFor_('zh').lang, 'en');
eq('eu(서유럽 추정) → 영어', reviewTemplateFor_('eu').lang, 'en');
eq('미상(null) → 영어', reviewTemplateFor_(null).lang, 'en');
ok('KO 문구에 10점·회신 요청 포함', REVIEW_MSG_KO.indexOf('10점짜리 후기')>=0 && REVIEW_MSG_KO.indexOf('회신을 부탁')>=0);
ok('EN 문구에 10-score·reply here 포함', REVIEW_MSG_EN.indexOf('10-score review')>=0 && REVIEW_MSG_EN.indexOf('reply here')>=0);

print('[3] 발송단 무변형 — 이모지 제거 필터를 통과해도 문구 그대로');
eq('EN: outText_ 통과 후 동일(⭐·→ 사전 제거 덕분)', outText_(REVIEW_MSG_EN), REVIEW_MSG_EN);
eq('KO: outText_ 통과 후 동일', outText_(REVIEW_MSG_KO), REVIEW_MSG_KO);
ok('원문 ⭐가 남았다면 필터에 잘렸을 것(검증: ⭐ 제거됨)', stripEmoji_('⭐ How to')==='How to');
ok('원문 →가 남았다면 필터에 잘렸을 것(검증: → 제거됨)', stripEmoji_('예약 내역 → 숙소').indexOf('→')<0);

print('결과: '+pass+' PASS / '+fail+' FAIL');
