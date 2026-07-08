// urlfetch 사용량 계기판 순수 로직 (jsc) — Code.gs 함수와 동일 구현
function fetchUsedKeyFor_(dateStr){ return 'CS_FETCH_USED_' + dateStr; }
function incCounter_(cur){ return parseInt(cur || '0', 10) + 1; }
function budgetSnapshot_(usedStr, budgetStr, date, fetchUsedStr){
  return { used: parseInt(usedStr||'0',10), budget: parseInt(budgetStr||'150',10), date: date, fetchUsed: parseInt(fetchUsedStr||'0',10) }; }

var pass=0,fail=0;
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }
function eq(n,g,w){ var o=JSON.stringify(g)===JSON.stringify(w); if(o)pass++;else fail++; print((o?'  PASS ':'  FAIL ')+n+(o?'':'  got='+JSON.stringify(g))); }

print('[1] 카운터 증가');
ok('null → 1(첫 호출)', incCounter_(null)===1);
ok('"" → 1', incCounter_('')===1);
ok('"0" → 1', incCounter_('0')===1);
ok('"41" → 42', incCounter_('41')===42);
// 누적 시뮬(속성 페이크)
var store={}; function bump(k){ store[k]=String(incCounter_(store[k])); }
var K=fetchUsedKeyFor_('2026-07-08'); bump(K); bump(K); bump(K);
ok('3회 누적 → "3"', store[K]==='3');

print('[2] 날짜 롤오버');
eq('키 형식', fetchUsedKeyFor_('2026-07-08'), 'CS_FETCH_USED_2026-07-08');
ok('다른 날 → 다른 키', fetchUsedKeyFor_('2026-07-08')!==fetchUsedKeyFor_('2026-07-09'));
var K2=fetchUsedKeyFor_('2026-07-09'); bump(K2); // 새 날 첫 호출
ok('새 날은 1부터(전날 3 무관)', store[K2]==='1' && store[K]==='3');

print('[3] 미러 스냅샷 fetchUsed 필드');
eq('fetchUsed 포함', budgetSnapshot_('5','150','2026-07-08','42'), {used:5,budget:150,date:'2026-07-08',fetchUsed:42});
ok('fetchUsed 미설정 → 0', budgetSnapshot_('5','150','2026-07-08',null).fetchUsed===0);

print('결과: '+pass+' PASS / '+fail+' FAIL');
