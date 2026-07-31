// 순수 로직 검증 (jsc) — 2026-07-31 보냄 기록 정합
//   클라라 신고: "실제 답장한 게 떠야 하는데 바꾸기 전 내용이 뜬다. 발송은 수정본대로 갔는데 기록이 수정 전."
//   원인 ①발송 워커가 sent 마킹 시 실제 나간 본문(finalReply)을 저장 안 함
//        ②DESK가 d.finalReply||d.reply 폴백이라 finalReply 없으면 AI 원본 초안(reply)을 기록으로 표시
//   수정 = ①GAS가 finalReply 저장 ②DESK 폴백에 claraFinal 삽입(과거 sent 소급 복구)

// index.html sentText()와 동일 구현
function sentText(d){ return String((d&&d.finalReply)||(d&&d.claraFinal)||(d&&d.reply)||''); }
// 발송 워커가 sent 시 기록하는 패치(순수부) — finalReply 포함이 핵심
function sentPatch(finalReply, nowIso){ return { status:'sent', sentAt:nowIso, finalReply:finalReply, errorMsg:null }; }

var pass=0, fail=0;
function eq(n,g,w){ var o=JSON.stringify(g)===JSON.stringify(w); if(o)pass++;else fail++;
  print((o?'  PASS ':'  FAIL ')+n+(o?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w))); }
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }

print('[1] 수정 발송 건 — 기록은 반드시 수정본');
var edited = { reply:'AI original draft', claraFinal:'Clara edited version',
               finalReply:'Clara edited version', editedByClara:true, status:'sent' };
eq('실발송 본문이 기록으로', sentText(edited), 'Clara edited version');
ok('AI 원본 초안이 기록에 새어나오지 않음', sentText(edited).indexOf('AI original')<0);

print('[2] 과거 sent 소급 — finalReply 없던 건도 수정본으로 복구');
var legacy = { reply:'AI original draft', claraFinal:'Clara edited version', editedByClara:true, status:'sent' };
eq('claraFinal로 폴백', sentText(legacy), 'Clara edited version');
ok('구버전 폴백(reply)이었다면 원본이 떴을 것 — 회귀 감시', legacy.reply!==sentText(legacy));

print('[3] 무수정 발송 — 초안 그대로가 정답');
var untouched = { reply:'AI draft', finalReply:'AI draft', editedByClara:false, status:'sent' };
eq('초안=발송본', sentText(untouched), 'AI draft');
var noFinal = { reply:'AI draft', editedByClara:false, status:'sent' };
eq('finalReply·claraFinal 둘 다 없으면 reply 폴백(최후)', sentText(noFinal), 'AI draft');

print('[4] 빈값·누락 방어');
eq('전부 없음 → 빈 문자열', sentText({}), '');
eq('null draft → 빈 문자열', sentText(null), '');
ok('빈 finalReply는 건너뛰고 claraFinal 사용', sentText({finalReply:'', claraFinal:'K', reply:'R'})==='K');

print('[5] 발송 워커 patch — finalReply 보존이 핵심');
var p = sentPatch('sent body', '2026-07-31T00:00:00Z');
eq('patch에 finalReply 포함', p.finalReply, 'sent body');
eq('status sent', p.status, 'sent');
ok('errorMsg 클리어', p.errorMsg===null);
ok('[회귀 감시] finalReply 키가 빠지면 DESK가 reply로 폴백해 사고 재발', Object.keys(p).indexOf('finalReply')>=0);

print('결과: '+pass+' PASS / '+fail+' FAIL');
