// 순수 로직 검증 (jsc) — gas/Code.gs 의 stripEmoji_ 와 동일 구현.
// 목적: 발송본에 이모지가 남지 않을 것 + 본문 한글/영문/기호(· — {가이드} URL)는 보존.

// ---- gas/Code.gs 와 동일 구현 ----
function stripEmoji_(s) {
  return String(s == null ? '' : s)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/[←-⇿⌀-➿⬀-⯿〰〽㊗㊙©®]/g, '')
    .replace(/[︀-️‍⃣]/g, '')
    .replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

var pass=0, fail=0;
function eq(n,g,w){ var okk=g===w; if(okk)pass++;else fail++; print((okk?'  PASS ':'  FAIL ')+n+(okk?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w))); }
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }

// 이모지 제거
eq('얼굴 이모지', stripEmoji_('Good evening! 😊'), 'Good evening!');
eq('비행기+변이선택자', stripEmoji_('trip to the airport ✈️'), 'trip to the airport');
eq('ZWJ 결합(가족)', stripEmoji_('hi 👨‍👩‍👦 there'), 'hi there');
eq('키캡', stripEmoji_('step 1️⃣ go'), 'step 1 go');
eq('경고/체크', stripEmoji_('⚠️ 주의 ✅'), '주의');
eq('줄 끝 이모지 공백 정리', stripEmoji_('첫 줄 😊\n둘째 줄'), '첫 줄\n둘째 줄');

// 본문 보존(과다 제거 방지)
eq('한글/영문 보존', stripEmoji_('안녕하세요 Clara입니다'), '안녕하세요 Clara입니다');
eq('가운뎃점·대시 보존', stripEmoji_('셔틀 · 체크인 — 안내'), '셔틀 · 체크인 — 안내');
eq('URL 보존', stripEmoji_('https://pwr-guide.online 참고'), 'https://pwr-guide.online 참고');
eq('연락처 기호 보존', stripEmoji_('WhatsApp +82 10-8227-2845 (09:00~21:00)'), 'WhatsApp +82 10-8227-2845 (09:00~21:00)');
eq('일본어/중국어 보존', stripEmoji_('チェックイン 15:00 / 入住 15:00'), 'チェックイン 15:00 / 入住 15:00');
eq('빈값', stripEmoji_(null), '');
ok('이모지 잔존 없음', !/[\uD800-\uDBFF]/.test(stripEmoji_('a😊b✈️c')));

print(pass+' PASS / '+fail+' FAIL');
