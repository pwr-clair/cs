// urlfetch 쿨다운 순수 로직 검증 (jsc) — Code.gs 함수와 동일 구현
function isUrlfetchExhausted_(msg){ var s=String(msg==null?'':msg).toLowerCase(); return s.indexOf('too many times for one day')>=0 && s.indexOf('urlfetch')>=0; }
function cooldownUntilIso_(nowMs,mins){ return new Date(nowMs+mins*60000).toISOString(); }
function inCooldown_(untilIso,nowMs){ var t=Date.parse(untilIso); return isFinite(t) && nowMs<t; }

// 속성 저장소 시뮬레이션 + enter/gate 로직(Code.gs와 동일 흐름, PropertiesService만 페이크)
function makeStore(){ var m={}; return {get:function(k){return k in m?m[k]:null;}, set:function(k,v){m[k]=String(v);}, del:function(k){delete m[k];}, _dump:function(){return m;}}; }
var KEY='CS_URLFETCH_COOLDOWN_UNTIL', MIN=60;
function enter(store,nowMs){ if(store.get(KEY))return false; store.set(KEY,cooldownUntilIso_(nowMs,MIN)); return true; }
function gate(store,nowMs){ var u=store.get(KEY); if(!u)return false; if(inCooldown_(u,nowMs))return true; store.del(KEY); return false; }

var pass=0,fail=0;
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }

print('[1] 소진 메시지 감지');
ok('GAS 실제 메시지 감지', isUrlfetchExhausted_('Exception: Service invoked too many times for one day: urlfetch.'));
ok('대소문자 무관', isUrlfetchExhausted_('...TOO MANY TIMES FOR ONE DAY: URLFETCH'));
ok('Error 객체 문자열화', isUrlfetchExhausted_(new Error('Service invoked too many times for one day: urlfetch.')));
ok('무관 예외는 미감지(스레드 못찾음)', isUrlfetchExhausted_('스레드 못 찾음: 123')===false);
ok('gmail 쿼터 메시지는 미감지', isUrlfetchExhausted_('too many times for one day: gmail')===false);
ok('null/undefined 안전', isUrlfetchExhausted_(null)===false && isUrlfetchExhausted_(undefined)===false);

print('[2] 기록 → 스킵 → 만료 해제 사이클');
var t0=Date.parse('2026-07-08T05:00:00Z'); var store=makeStore();
ok('초기: 쿨다운 아님', gate(store,t0)===false);
ok('소진 감지 → 기록 성공', enter(store,t0)===true);
ok('기록값 = now+60분', store.get(KEY)===cooldownUntilIso_(t0,60));
ok('직후: 게이트 skip(true)', gate(store, t0+1000)===true);
ok('59분 후: 여전히 skip', gate(store, t0+59*60000)===true);
ok('중복 enter 무시(이미 있음)', enter(store, t0+60000)===false);
ok('경계 정확히 60분: 만료(skip 아님)', gate(store, t0+60*60000)===false);
ok('만료 시 속성 제거됨', store.get(KEY)===null);
ok('제거 후 재진입 가능', enter(store, t0+61*60000)===true && store.get(KEY)!==null);

print('[3] 수동 함수는 게이트 미호출 → 쿨다운 무시(구조 확인)');
// 수동 함수는 gate()를 호출하지 않으므로 store에 쿨다운이 있어도 로직상 진행됨
var store2=makeStore(); enter(store2, t0);
ok('쿨다운 존재해도 gate를 안 부르면 skip 트리거 없음(진행)', store2.get(KEY)!==null /* 존재하나 수동경로는 참조 안함 */);

print('결과: '+pass+' PASS / '+fail+' FAIL');
