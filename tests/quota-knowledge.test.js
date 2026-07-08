// v2 순수 로직 검증 (jsc) — Code.gs B/D 함수와 동일 구현
// B — 컷오프
function cutoffMs_(iso){ if(!iso) return null; var t=Date.parse(iso); return isFinite(t)?t:null; }
function isBeforeCutoff_(ms, cutoffMs){ return cutoffMs!=null && ms>0 && ms<cutoffMs; }
// D — 질문 정규화 / 단순메시지
function normQ_(s){ return String(s==null?'':s).toLowerCase().replace(/\s+/g,' ').replace(/[\s.!?…~]+$/,'').trim(); }
function isTrivialMessage_(s){ var t=normQ_(s); if(!t||t.length<=3) return true;
  var TR=/^(hi|hello|hey|yo|thanks|thank you|thx|ty|ok|okay|good (morning|afternoon|evening|night|day)|안녕하세요|안녕|감사합니다|감사해요|고맙습니다|고마워요|넵|네|알겠습니다|ありがとうございます|ありがとう|こんにちは|よろしくお願いします|谢谢|谢谢你|你好|好的)[\s!.~,]*$/i;
  return TR.test(t); }

var pass=0,fail=0;
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }
function eq(n,g,w){ var o=JSON.stringify(g)===JSON.stringify(w); if(o)pass++;else fail++; print((o?'  PASS ':'  FAIL ')+n+(o?'':'  got='+JSON.stringify(g))); }

print('[B] 백로그 컷오프');
var cut=cutoffMs_('2026-07-08'); // UTC 자정
ok('설정: 7/6 수신 → 컷오프 이전(스킵)', isBeforeCutoff_(Date.parse('2026-07-06T05:00:00Z'), cut)===true);
ok('설정: 7/9 수신 → 이후(정상 처리)', isBeforeCutoff_(Date.parse('2026-07-09T00:00:00Z'), cut)===false);
ok('경계: 정확히 컷오프 → 이전 아님', isBeforeCutoff_(cut, cut)===false);
ok('미설정(null): 항상 false(현행 동작 유지)', isBeforeCutoff_(Date.parse('2000-01-01T00:00:00Z'), cutoffMs_(null))===false);
ok('미설정("") → null', cutoffMs_('')===null);
ok('잘못된 ISO → null(현행 동작)', cutoffMs_('not-a-date')===null && isBeforeCutoff_(123, cutoffMs_('not-a-date'))===false);
ok('시각 0/음수 안전', isBeforeCutoff_(0, cut)===false);

print('[D-1] 질문 정규화 / 단순메시지 판별');
eq('normQ 공백·대소문·말미문장부호 정규화', normQ_('  What TIME is  Check-out??  '), 'what time is check-out');
ok('인사만 → trivial', isTrivialMessage_('Hello!')===true);
ok('감사만 → trivial', isTrivialMessage_('감사합니다~')===true);
ok('ありがとうございます → trivial', isTrivialMessage_('ありがとうございます')===true);
ok('실제 질문 → 통과', isTrivialMessage_('Hi, what time is check-in?')===false);
ok('한글 질문 → 통과', isTrivialMessage_('체크인 몇 시부터인가요?')===false);
ok('빈/초단문 → trivial', isTrivialMessage_('  ')===true && isTrivialMessage_('ok')===true);

print('[D-2] export 중복·멱등(기존 시트 seed + 재실행)');
// 기존 시트 B열 질문
var existing=['What time is check-in?','주차 되나요?'];
var seen={}; existing.forEach(function(q){ seen[normQ_(q)]=true; });
var drafts1=[
 {origMsg:'What time is check-in?', lang:'en', category:'체크인'}, // 기존과 중복 → skip
 {origMsg:'what time IS check-in??', lang:'en', category:'체크인'}, // 정규화 동일 → skip
 {origMsg:'Is there parking?', lang:'en', category:'주차'},        // 신규
 {origMsg:'Thanks!', lang:'en', category:'인사'},                 // trivial skip
 {origMsg:'Wi-Fi password?', lang:'en', category:'와이파이'},     // 신규
];
function runExport(drafts, seen){ var rows=[],dup=0,tri=0;
  drafts.forEach(function(d){ var q=String(d.origMsg||'').trim(); if(!q)return;
    if(isTrivialMessage_(q)){tri++;return;} var k=normQ_(q); if(!k||seen[k]){dup++;return;} seen[k]=true; rows.push([d.lang,q,'',d.category]); });
  return {rows:rows,dup:dup,tri:tri}; }
var e1=runExport(drafts1, seen);
eq('1차: 신규 2건만 추가', e1.rows.map(function(r){return r[1];}), ['Is there parking?','Wi-Fi password?']);
ok('1차: 중복 2 · trivial 1 스킵', e1.dup===2 && e1.tri===1);
ok('추가행 C(clara_reply)는 빈칸', e1.rows.every(function(r){return r[2]==='';}));
// 재실행: seen에 방금 추가분 반영됨 → 같은 drafts 재적재 0
var e2=runExport(drafts1, seen);
ok('재실행 멱등: 추가 0건', e2.rows.length===0);

print('[D-3] import 빈답변 스킵 → 나중에 채우면 흡수 (행위치 멱등 함정 해소)');
// corpus 저장소 시뮬 (fbGet/fbSet cs/corpus/sheet_r)
function makeImport(){ var store={};
  return { row:function(r, situ, ans){
    if(!situ && !ans) return 'empty';
    if(!ans) return 'skip-noans';              // 답변 미기입 → 마킹 안 함(핵심)
    var id='sheet_'+r; if(id in store) return 'skip-dup';
    store[id]={situ:situ,ans:ans}; return 'import'; },
    has:function(r){ return ('sheet_'+r) in store; } }; }
var imp=makeImport();
ok('export가 넣은 빈답변 행(44) → skip-noans', imp.row(44,'Wi-Fi password?','')==='skip-noans');
ok('그 시점 corpus에 sheet_44 없음(마킹 안 됨)', imp.has(44)===false);
ok('클라라가 답 채운 뒤 재실행 → import(흡수)', imp.row(44,'Wi-Fi password?','서랍장 끝 스티커 참고')==='import');
ok('다시 재실행 → skip-dup(멱등)', imp.row(44,'Wi-Fi password?','서랍장 끝 스티커 참고')==='skip-dup');
ok('완전 빈 행 → empty(무시)', imp.row(45,'','')==='empty');

print('결과: '+pass+' PASS / '+fail+' FAIL');
