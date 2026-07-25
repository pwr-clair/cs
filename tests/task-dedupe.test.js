// 순수 로직 검증 (jsc) — gas/Code.gs isDupTask_·fixTaskYear_ + index.html taskDateKey/isPast 와 동일 구현.
// 배경: 2026-07-25 지시 — 업무 탭 침수(Margaret 향수·환기 4장 분화, 9/29 건 최상단, "2024년" 오추출).
function normText_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^0-9a-z가-힣぀-ヿ一-鿿\s]/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
function jaccard_(a, b) {
  var sa = {}, sb = {}, na = 0, nb = 0, w;
  a.split(' ').forEach(function (x) { if (x && !sa[x]) { sa[x] = 1; na++; } });
  b.split(' ').forEach(function (x) { if (x && !sb[x]) { sb[x] = 1; nb++; } });
  if (!na || !nb) return 0;
  var inter = 0; for (w in sa) if (sb[w]) inter++;
  return inter / (na + nb - inter);
}
function fixTaskYear_(text, ciYear) {
  if (!text || !ciYear) return text;
  return text.replace(/20\d{2}/g, function (y) { return (+y < +ciYear) ? ciYear : y; });
}
function stripName_(s, guest) {
  if (!guest) return s;
  var toks = normText_(guest).split(' ');
  for (var i = 0; i < toks.length; i++) if (toks[i]) s = s.split(toks[i]).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}
function bigramSim_(a, b) {
  a = a.replace(/ /g, ''); b = b.replace(/ /g, '');
  if (a.length < 2 || b.length < 2) return 0;
  var A = {}, B = {}, na = 0, nb = 0, k, it = 0;
  for (var i = 0; i < a.length - 1; i++) { k = a.substr(i, 2); if (!A[k]) { A[k] = 1; na++; } }
  for (var j = 0; j < b.length - 1; j++) { k = b.substr(j, 2); if (!B[k]) { B[k] = 1; nb++; } }
  for (k in A) if (B[k]) it++;
  return it / (na + nb - it);
}
function isDupTask_(text, bookingId, guest, existing) {
  var norm = stripName_(normText_(text), guest); if (!norm) return false;
  for (var k in existing) {
    var e = existing[k]; if (!e || !e.text) continue;
    if (String(e.bookingId || '') !== String(bookingId || '')) continue;
    var en = stripName_(normText_(e.text), guest);
    if (en === norm) return true;
    if (norm.length >= 8 && en.length >= 8 && bigramSim_(norm, en) >= 0.25) return true;
  }
  return false;
}
function taskDateKey(t) { return String(t.relatedDate || (t.createdAt || '').slice(0, 10) || '9999-12-31'); }

var pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else fail++; print((c ? '  PASS ' : '  FAIL ') + n); }
function eq(n, g, w) { ok(n + (g === w ? '' : '  got=' + g + ' want=' + w), g === w); }

print('[1] 중복 판정 — Margaret 분화 재현');
var G = 'Margaret Gifford';
var ex = { a: { text: '객실에 향수 냄새 — 환기 필요 (Margaret Gifford)', bookingId: '111' } };
ok('같은 예약+같은 이슈 표현 변형 → 중복', isDupTask_('Margaret Gifford 객실 향수 냄새로 환기 요청', '111', G, ex) === true);
ok('같은 예약+어순·조사 변형 → 중복', isDupTask_('향수 냄새 항의 — 환기 필요함 (Margaret)', '111', G, ex) === true);
ok('같은 예약+완전 일치 → 중복', isDupTask_('객실에 향수 냄새 — 환기 필요 (Margaret Gifford)', '111', G, ex) === true);
ok('다른 예약+같은 내용 → 통과', isDupTask_('객실에 향수 냄새 — 환기 필요 (Margaret Gifford)', '222', G, ex) === false);
ok('같은 예약+다른 이슈(침구) → 통과', isDupTask_('Margaret Gifford 추가 침구 준비 요청', '111', G, ex) === false);
ok('같은 예약+다른 이슈(얼리체크인) → 통과', isDupTask_('도착일 얼리체크인 준비 (Margaret Gifford)', '111', G, ex) === false);
ok('짧은 텍스트는 완전일치만(오탐 방지)', isDupTask_('환기 요청', '111', G, ex) === false);
ok('기존 없음 → 통과', isDupTask_('아무 업무', '111', G, {}) === false);

print('[2] 연도 보정');
eq('과거 연도 → 체크인 연도', fixTaskYear_('2024년 7월 29일 도착 예정 반영', '2026'), '2026년 7월 29일 도착 예정 반영');
eq('체크인 연도 그대로', fixTaskYear_('2026-09-29 도착', '2026'), '2026-09-29 도착');
eq('미래 연도 그대로(내년 예약)', fixTaskYear_('2027년 1월 체크인', '2026'), '2027년 1월 체크인');
eq('연도 없으면 무변경', fixTaskYear_('도착일에 얼리체크인 준비', '2026'), '도착일에 얼리체크인 준비');
eq('체크인일 미상 → 무변경', fixTaskYear_('2024년 뭔가', null), '2024년 뭔가');

print('[3] 정렬 키 — 관련일 가까운 순 + 지난/완료 분리');
var t929 = { relatedDate: '2026-09-29', status: 'proposed' };
var t726 = { relatedDate: '2026-07-26', status: 'proposed' };
var tOld = { relatedDate: '2026-07-10', status: 'proposed' };
var tDone = { relatedDate: '2026-07-26', status: 'done' };
var tNoDate = { createdAt: '2026-07-25T10:00:00Z', status: 'proposed' };
ok('내일 도착이 9/29보다 앞', taskDateKey(t726) < taskDateKey(t929));
ok('날짜 없으면 생성일로', taskDateKey(tNoDate) === '2026-07-25');
var today = '2026-07-25';
function isPast(t) { return t.status === 'done' || taskDateKey(t) < today; }
ok('지난 도착일 → 하단(접힘)', isPast(tOld) === true);
ok('완료 → 하단(접힘)', isPast(tDone) === true);
ok('다가오는 건 → 상단', isPast(t726) === false && isPast(t929) === false);

print('결과: ' + pass + ' PASS / ' + fail + ' FAIL');
