// 순수 로직 검증 (jsc) — gas/Code.gs 의 익스피디아 별칭 대조와 동일 구현.
// 대상: nameKey_(이름 정규화) + expediaAliasPick_(pending 대조·컷오프·별칭 도메인 필터).

// ---- gas/Code.gs 와 동일 구현 ----
function nameKey_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[^a-z0-9À-ɏ가-힣぀-ヿ一-鿿\s]/g, ' ')
    .split(/\s+/).filter(function (w) { return !!w; }).sort().join(' ');
}
function expediaAliasPick_(pending, guestName, cutoffYmd) {
  var key = nameKey_(guestName);
  if (!key) return null;
  for (var k in pending) {
    var b = pending[k]; if (!b || b.cancelled) continue;
    if (b.checkoutDate && cutoffYmd && b.checkoutDate < cutoffYmd) continue;
    var em = String(b.guestEmail || '');
    if (em.toLowerCase().indexOf('@m.expediapartnercentral.com') < 0) continue;
    if (nameKey_(b.guest) === key) return em;
  }
  return null;
}

var pass=0, fail=0;
function eq(n,g,w){ var okk=JSON.stringify(g)===JSON.stringify(w); if(okk)pass++;else fail++; print((okk?'  PASS ':'  FAIL ')+n+(okk?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w))); }
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }

print('[1] nameKey_ 정규화 — 쉼표·어순·대소문자·다중 공백');
eq('쉼표+어순 반전', nameKey_('LAI, POUMEI'), nameKey_('POUMEI LAI'));
eq('대소문자', nameKey_('Kikyoung Kim'), nameKey_('KIM KIKYOUNG'));
eq('다중 공백·양끝 공백', nameKey_('  KIM   KIKYOUNG  '), nameKey_('KIKYOUNG KIM'));
eq('마침표(이니셜)', nameKey_('J. SMITH'), nameKey_('SMITH J'));
ok('다른 이름은 불일치', nameKey_('POUMEI LAI') !== nameKey_('KIKYOUNG KIM'));
ok('부분 이름은 불일치(토큰 집합 다름)', nameKey_('KIM') !== nameKey_('KIKYOUNG KIM'));
eq('빈 입력 → 빈 키', nameKey_('  ,  '), '');

print('[2] expediaAliasPick_ — 실전 2건 재현 + 필터');
var ALIAS = 'abc123@m.expediapartnercentral.com';
var pending = {
  sv1: { guest: 'LAI, POUMEI', guestEmail: ALIAS, checkoutDate: '2026-07-30' },
  sv2: { guest: 'KIM, KIKYOUNG', guestEmail: 'def456@M.ExpediaPartnerCentral.com', checkoutDate: '2026-07-29' },
  sv3: { guest: 'PARK MINSU', guestEmail: 'minsu@gmail.com', checkoutDate: '2026-07-30' },          // 비별칭(직거래 등)
  sv4: { guest: 'OLD GUEST', guestEmail: 'old@m.expediapartnercentral.com', checkoutDate: '2026-07-25' }, // 체크아웃 2일 경과
  sv5: { guest: 'GONE GUEST', guestEmail: 'gone@m.expediapartnercentral.com', checkoutDate: '2026-07-30', cancelled: true },
  sv6: { guest: 'NO MAIL', checkoutDate: '2026-07-30' }
};
var CUT = '2026-07-26'; // 오늘 07-28 기준 -2일
eq('POUMEI LAI(어순 반전) → 별칭 회수', expediaAliasPick_(pending, 'POUMEI LAI', CUT), ALIAS);
eq('KIKYOUNG KIM(어순+대소문자+도메인 대소문자) → 회수', expediaAliasPick_(pending, 'KIKYOUNG KIM', CUT), 'def456@M.ExpediaPartnerCentral.com');
eq('비별칭 이메일(gmail)은 제외', expediaAliasPick_(pending, 'PARK MINSU', CUT), null);
eq('체크아웃 2일 경과 제외', expediaAliasPick_(pending, 'OLD GUEST', CUT), null);
eq('경계값: 체크아웃 == 컷오프는 포함', expediaAliasPick_({ b: { guest: 'EDGE CASE', guestEmail: 'e@m.expediapartnercentral.com', checkoutDate: CUT } }, 'CASE EDGE', CUT), 'e@m.expediapartnercentral.com');
eq('취소 예약 제외', expediaAliasPick_(pending, 'GONE GUEST', CUT), null);
eq('guestEmail 없음 → null', expediaAliasPick_(pending, 'NO MAIL', CUT), null);
eq('미등록 게스트 → null(복붙 안내 폴백)', expediaAliasPick_(pending, 'UNKNOWN PERSON', CUT), null);
eq('빈 이름 → null', expediaAliasPick_(pending, '', CUT), null);
eq('checkoutDate 없는 레코드는 컷오프 미적용', expediaAliasPick_({ b: { guest: 'NODATE KIM', guestEmail: 'n@m.expediapartnercentral.com' } }, 'KIM NODATE', CUT), 'n@m.expediapartnercentral.com');

print('');
print(pass + ' PASS / ' + fail + ' FAIL');
