// 순수 로직 검증 (jsc) — 2026-07-29 3종 수리
//   ① 즉석↔이메일 결합(gas: manualDupKey_ / linkManualToEmail_ 패치 산출)
//   ② 대기 그룹 대표 1건 + 이전 미답 함께 정리(index.html: priorPendingIds)
//   ③ 보냄 예약 단위 채팅방(index.html: buildGroups + sentKeys 필터)
// 구현과 동일 코드를 복제해 검증(원본은 GAS/브라우저 전역 의존).

// ── gas/Code.gs 복제 ──
function normText_(s){ return String(s==null?'':s).toLowerCase()
  .replace(/https?:\/\/\S+/g,' ').replace(/[^0-9a-z가-힣぀-ヿ一-鿿\s]/gi,' ').replace(/\s+/g,' ').trim(); }
function jaccard_(a,b){ var sa={},sb={},na=0,nb=0,w;
  a.split(' ').forEach(function(x){ if(x&&!sa[x]){sa[x]=1;na++;} });
  b.split(' ').forEach(function(x){ if(x&&!sb[x]){sb[x]=1;nb++;} });
  if(!na||!nb) return 0; var inter=0; for(w in sa) if(sb[w]) inter++;
  return inter/(na+nb-inter); }
function manualDupKey_(text,handled){
  var norm=normText_(text); if(!norm||norm.length<8) return '';
  for(var k in handled){ var h=handled[k]; if(!h||!h.norm) continue;
    if(h.norm===norm) return k;
    if(norm.length>=20&&jaccard_(norm,h.norm)>=0.9) return k; }
  return ''; }
// linkManualToEmail_ 의 patch 산출부(fbGet/fbUpdate/findSirvoy_ 제외한 순수 부분)
function linkPatch_(m,msgId,rec,sv){
  if(m.status==='sent'||m.status==='dismissed') return null;
  var patch={ guest:m.guest||rec.guest||null, bookingId:m.bookingId||rec.bookingId||null,
    threadId:m.threadId||rec.threadId||null,
    channel:(!m.channel||m.channel==='manual')?(rec.source||'booking'):m.channel,
    emailReply:rec.emailReply!==false, receivedAt:rec.receivedAt||m.receivedAt||null, linkedMsgId:msgId };
  if(sv){ patch.sirvoyId=sv.sirvoyId; patch.room=sv.room; patch.checkinDate=sv.checkinDate; patch.checkoutDate=sv.checkoutDate; }
  return patch; }

// ── index.html 복제 ──
function msgTimeMs(d){ var iso=(d&&(d.receivedAt||d.createdAt))||null; if(!iso) return 0; var t=Date.parse(iso); return isNaN(t)?0:t; }
function groupKey(d){ return (d&&d.bookingId&&('b'+d.bookingId))||(d&&d.threadId&&('t'+d.threadId))||null; }
function isSavedView(id,d){ return !!(d&&d.status==='saved'); } // 낙관 저장(optimisticSaved) 없는 순수 케이스
function buildGroups(entries){ var map={};
  entries.forEach(function(e){ var gk=groupKey(e[1])||('m'+e[0]); (map[gk]||(map[gk]={key:gk,items:[]})).items.push(e); });
  return Object.keys(map).map(function(k){ return map[k]; }).map(function(g){
    g.items.sort(function(a,b){ return msgTimeMs(a[1])-msgTimeMs(b[1]); }); g.latest=g.items[g.items.length-1]; return g; }); }
function isActionable_(id,d){ var s=d.status||'pending'; return (s==='pending'||s==='error'||s==='notice')&&!isSavedView(id,d); }
function priorPendingIds(drafts,id){
  var d=drafts[id]; if(!d) return [];
  var gk=groupKey(d)||('m'+id), t=msgTimeMs(d);
  return Object.keys(drafts).filter(function(k){ var o=drafts[k];
    return k!==id&&o&&(groupKey(o)||('m'+k))===gk&&(o.status||'pending')==='pending'
      &&!isSavedView(k,o)&&msgTimeMs(o)<=t; }); }
// renderWait 대상 산출부
function waitTarget(g){
  var acts=g.items.filter(function(e){ return isActionable_(e[0],e[1]); });
  var msgs=acts.filter(function(e){ return e[1].status!=='notice'; });
  return msgs.length?msgs[msgs.length-1][0]:null; }

var pass=0,fail=0;
function eq(n,g,w){ var o=JSON.stringify(g)===JSON.stringify(w); if(o)pass++;else fail++;
  print((o?'  PASS ':'  FAIL ')+n+(o?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w))); }
function ok(n,c){ if(c)pass++;else fail++; print((c?'  PASS ':'  FAIL ')+n); }

print('[1] 즉석↔이메일 매칭 — 키 반환(종전 boolean)');
var handled={ 'manual_r1':{norm:normText_('Good evening! I have another question regarding the hot water in our room.')} };
eq('동일 본문 → 즉석 draft 키', manualDupKey_('Good evening! I have another question regarding the hot water in our room.',handled), 'manual_r1');
eq('구두점·대소문자 차이 무시', manualDupKey_('good evening  I have another question, regarding the HOT WATER in our room',handled), 'manual_r1');
eq('무관한 본문 → 빈 문자열', manualDupKey_('What time is the free shuttle to the airport tomorrow morning?',handled), '');
eq('짧은 본문(8자 미만) → 판정 안 함', manualDupKey_('ok', handled), '');

print('[2] 결합 패치 — 미상 해소 + 발송 경로 확보');
var manual={ status:'pending', guest:null, bookingId:null, threadId:null, channel:'manual', origin:'manual',
             receivedAt:'2026-07-28T13:08:00Z' };
var mail={ guest:'KIM GITAE', bookingId:'4321098765', threadId:'thr_abc', source:'booking',
           emailReply:true, receivedAt:'2026-07-28T12:55:00Z' };
var p=linkPatch_(manual,'msg_1',mail,{sirvoyId:'10371',room:'1037',checkinDate:'2026-07-28',checkoutDate:'2026-07-30'});
eq('게스트 역주입', p.guest, 'KIM GITAE');
eq('예약번호 역주입(그룹핑 키 확보)', p.bookingId, '4321098765');
eq('스레드 역주입 — 발송 워커 threadId 요구 충족', p.threadId, 'thr_abc');
eq('채널 manual → 실제 플랫폼', p.channel, 'booking');
ok('emailReply true — 익스피디아 별칭 분기로 새지 않음', p.emailReply===true);
eq('receivedAt = 게스트 실제 수신 시각(붙여넣은 시각 아님)', p.receivedAt, '2026-07-28T12:55:00Z');
eq('방 보강', p.room, '1037');
eq('이미 발송된 즉석건은 건드리지 않음', linkPatch_({status:'sent'},'msg_1',mail,null), null);
eq('치운 건도 건드리지 않음', linkPatch_({status:'dismissed'},'msg_1',mail,null), null);
ok('즉석 카드가 이미 가진 값은 유지(덮어쓰기 금지)',
   linkPatch_({status:'pending',guest:'기존',bookingId:'999',threadId:'thr_old',channel:'agoda'},'m',mail,null).guest==='기존');

print('[3] 대기 — 대표 1건 + 이전 미답 함께 정리(시간 역주행 차단)');
var drafts={
  m1:{ bookingId:'B1', status:'pending', receivedAt:'2026-07-28T01:00:00Z' },
  m2:{ bookingId:'B1', status:'pending', receivedAt:'2026-07-28T05:00:00Z' },
  m3:{ bookingId:'B1', status:'pending', receivedAt:'2026-07-28T09:00:00Z' }, // 최신 = 답변 대상
  m4:{ bookingId:'B1', status:'sent',    receivedAt:'2026-07-27T00:00:00Z' }, // 이미 답함
  m5:{ bookingId:'B1', status:'notice',  receivedAt:'2026-07-28T10:00:00Z' }, // 부킹 알림(별도 조치)
  x1:{ bookingId:'B2', status:'pending', receivedAt:'2026-07-28T02:00:00Z' }  // 다른 게스트
};
var g=buildGroups(Object.keys(drafts).filter(function(k){ return drafts[k].status!=='sent'; })
       .map(function(k){ return [k,drafts[k]]; })).filter(function(gr){ return gr.key==='bB1'; })[0];
eq('답변 대상 = 최신 미답 메시지(알림 아님)', waitTarget(g), 'm3');
eq('m3 처리 시 함께 정리될 이전 미답', priorPendingIds(drafts,'m3').sort(), ['m1','m2']);
ok('다른 예약은 절대 안 건드림', priorPendingIds(drafts,'m3').indexOf('x1')<0);
ok('발송분·알림은 정리 대상 아님',
   priorPendingIds(drafts,'m3').indexOf('m4')<0 && priorPendingIds(drafts,'m3').indexOf('m5')<0);
eq('정리 후 재렌더 — 남는 미답 없음(되감기 없음)',
   (function(){ ['m1','m2'].forEach(function(k){ drafts[k].status='dismissed'; }); drafts.m3.status='approved';
     return Object.keys(drafts).filter(function(k){ return drafts[k].bookingId==='B1'&&(drafts[k].status||'pending')==='pending'; }); })(), []);

print('[4] 보냄 — 예약 단위 채팅방(지난 기록 포함)');
var sd={
  s1:{ bookingId:'B9', status:'dismissed', receivedAt:'2026-07-20T00:00:00Z' }, // 지난 기록도 방 안에
  s2:{ bookingId:'B9', status:'sent',      receivedAt:'2026-07-21T00:00:00Z' },
  s3:{ bookingId:'B9', status:'pending',   receivedAt:'2026-07-22T00:00:00Z' },
  s4:{ bookingId:'B8', status:'pending',   receivedAt:'2026-07-23T00:00:00Z' }, // 발송분 없는 예약 → 보냄 탭 미노출
  s5:{ status:'sent',  threadId:'T7',      receivedAt:'2026-07-24T00:00:00Z' }  // 예약번호 없음 → threadId로 방 구성
};
var sentE=Object.keys(sd).filter(function(k){ return sd[k].status==='sent'; }).map(function(k){ return [k,sd[k]]; });
var keys={}; sentE.forEach(function(e){ keys[groupKey(e[1])||('m'+e[0])]=true; });
var sg=buildGroups(Object.keys(sd).map(function(k){ return [k,sd[k]]; })).filter(function(gr){ return keys[gr.key]; });
eq('발송분 있는 예약만 방 생성', sg.map(function(x){ return x.key; }).sort(), ['bB9','tT7']);
eq('B9 방 = 치운 것 포함 전 대화 3건(종전 플랫 리스트는 1건만 보였음)',
   sg.filter(function(x){ return x.key==='bB9'; })[0].items.length, 3);
eq('방 안은 시간순(오래된→최신)',
   sg.filter(function(x){ return x.key==='bB9'; })[0].items.map(function(e){ return e[0]; }), ['s1','s2','s3']);

print('결과: '+pass+' PASS / '+fail+' FAIL');
