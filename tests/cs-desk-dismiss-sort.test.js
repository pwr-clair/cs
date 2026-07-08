// 순수 로직 검증 (jsc) — index.html 인라인 함수와 동일 구현
function msgTimeMs(d){ var iso=(d&&(d.receivedAt||d.createdAt))||null; if(!iso) return 0; var t=Date.parse(iso); return isNaN(t)?0:t; }
function kstDayStartMs(nowMs){ var k=new Date(nowMs+9*3600000); return Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate())-9*3600000; }
function waitCmpDesc(a,b){ return msgTimeMs(b[1])-msgTimeMs(a[1]); }
function isInflight(status){ return ['pending','approved','sending','error'].indexOf(status||'pending')>=0; }
function isActionable(status){ var s=status||'pending'; return s==='pending'||s==='error'; }
function isStaleBefore(d, thresholdMs){ var t=msgTimeMs(d); return t>0 && t<thresholdMs; }
function dismissPatch(nowIso){ return { status:'dismissed', dismissedAt:nowIso }; }

var pass=0, fail=0;
function eq(n,g,w){ var okk=JSON.stringify(g)===JSON.stringify(w); if(okk)pass++;else fail++; print((okk?'  PASS ':'  FAIL ')+n+(okk?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w))); }
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }

print('[1] dismiss 상태 전이');
eq('dismissPatch 형태', dismissPatch('2026-07-08T00:00:00Z'), {status:'dismissed', dismissedAt:'2026-07-08T00:00:00Z'});
ok('dismissed는 대기(inflight)에서 제외', isInflight('dismissed')===false);
ok('dismissed는 카운터(actionable)에서 제외', isActionable('dismissed')===false);
ok('pending은 inflight+actionable', isInflight('pending') && isActionable('pending'));
ok('error는 inflight+actionable', isInflight('error') && isActionable('error'));
ok('approved는 inflight이나 actionable 아님', isInflight('approved') && !isActionable('approved'));
ok('sent는 inflight 아님', isInflight('sent')===false);

print('[2] 일괄 기준 — 오늘 0시(KST) 이전');
var now = Date.parse('2026-07-08T01:00:00Z');
var th  = kstDayStartMs(now);
eq('threshold = KST 오늘 0시(=UTC 7/7 15:00)', new Date(th).toISOString(), '2026-07-07T15:00:00.000Z');
ok('게스트 7/6 14:00 KST → 지난(stale)',  isStaleBefore({receivedAt:'2026-07-06T05:00:00Z'}, th)===true);
ok('게스트 7/8 01:00 KST(오늘) → 지난 아님', isStaleBefore({receivedAt:'2026-07-07T16:00:00Z'}, th)===false);
ok('경계값 정확히 0시 → 미포함', isStaleBefore({receivedAt:new Date(th).toISOString()}, th)===false);
ok('시각 없음 → 지난 아님(안전)', isStaleBefore({}, th)===false);
ok('[백필 근거] receivedAt 없고 createdAt 오늘 03:00 KST → 일괄서 누락', isStaleBefore({createdAt:'2026-07-07T18:00:00Z'}, th)===false);
ok('[백필 후] receivedAt=7/6 채워지면 잡힘', isStaleBefore({receivedAt:'2026-07-06T05:00:00Z', createdAt:'2026-07-07T18:00:00Z'}, th)===true);

print('[3] 정렬 — 수신 시각 최신순(desc)');
var entries=[['a',{receivedAt:'2026-07-06T05:00:00Z'}],['b',{receivedAt:'2026-07-07T23:00:00Z'}],['c',{createdAt:'2026-07-07T10:00:00Z'}],['d',{receivedAt:'2026-07-05T00:00:00Z'}]];
var sorted=entries.slice().sort(waitCmpDesc).map(function(e){return e[0];});
eq('정렬 결과(최신→오래된)', sorted, ['b','c','a','d']);
ok('receivedAt 우선(생성 시각 아님)', msgTimeMs({receivedAt:'2026-07-06T05:00:00Z', createdAt:'2026-07-08T00:00:00Z'})===Date.parse('2026-07-06T05:00:00Z'));

print('결과: '+pass+' PASS / '+fail+' FAIL');
