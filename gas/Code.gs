/**
 * PWR-CS-Engine — Code.gs  (M1: 수신 증명)
 * ------------------------------------------------------------------
 * 역할: Gmail 라벨 "CS/부킹" 폴링 → 부킹 알림메일 파싱 → Firebase cs/inbox 적재
 * 트리거: pollCsInbox()  를 1분 시간트리거로 실행 (Clara가 GAS에서 설정 — §6g)
 *
 * ▣ 클코 환경에서 script.google.com 접근 불가 → 이 파일은 레포에만 두고
 *   Clara가 GAS 에디터 "PWR-CS-Engine" 프로젝트에 붙여넣는다 (§6a/d).
 *
 * ▣ 시크릿 규칙(§8): FB_AUTH 는 스크립트 속성에서만 읽는다. 코드/레포/채팅 금지.
 *   GAS 에디터 → 프로젝트 설정 → 스크립트 속성 → 키 FB_AUTH = (HK GAS와 동일 값)
 * ------------------------------------------------------------------
 */

// ══════════════════════════════════════════════════════════════════
// 설정 (Fable 회신 2026-07-04 로 확정)
// ══════════════════════════════════════════════════════════════════

// Firebase RTDB 베이스 URL — asia-southeast1 리전 (firebaseio.com 형식 아님).
// HK 프론트 firebaseConfig 원문 확인값. FB_AUTH 는 스크립트 속성에서만 read.
var FB_BASE = 'https://paradise-walk-residence-default-rtdb.asia-southeast1.firebasedatabase.app';

// 폴링 대상 Gmail 라벨 (§6f 필터로 자동 부여) + 멱등성 라벨(Fable 승인 → 유지).
var CS_LABEL = 'cs/booking';   // 실제 라벨명 (Fable 2026-07-05 확정)
var CS_DONE_LABEL = 'CS/적재됨'; // 적재 성공 시 부여 (없으면 자동 생성)

// ══════════════════════════════════════════════════════════════════
// Firebase 헬퍼 (HK GAS와 동일 패턴: fbGet/fbSet/fbUpdate/fbDelete + ?auth=)
// ⚠️ HK 원본과 시그니처가 다르면 HK 쪽에 맞춰 이 4개를 교체할 것.
// ══════════════════════════════════════════════════════════════════

function fbAuth_() {
  var t = PropertiesService.getScriptProperties().getProperty('FB_AUTH');
  if (!t) throw new Error('스크립트 속성 FB_AUTH 미설정 (§6e)');
  return t;
}
function fbUrl_(path) {
  return FB_BASE + '/' + String(path).replace(/^\/+/, '') + '.json?auth=' + fbAuth_();
}
function fbGet(path) {
  var res = csFetch_(fbUrl_(path), { muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('fbGet ' + path + ': ' + res.getContentText());
  var body = res.getContentText();
  return body === 'null' || body === '' ? null : JSON.parse(body);
}
function fbSet(path, obj) {
  var res = csFetch_(fbUrl_(path), {
    method: 'put', contentType: 'application/json',
    payload: JSON.stringify(obj), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('fbSet ' + path + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function fbUpdate(path, obj) {
  var res = csFetch_(fbUrl_(path), {
    method: 'patch', contentType: 'application/json',
    payload: JSON.stringify(obj), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('fbUpdate ' + path + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function fbDelete(path) {
  var res = csFetch_(fbUrl_(path), { method: 'delete', muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('fbDelete ' + path + ': ' + res.getContentText());
  return true;
}

// ══════════════════════════════════════════════════════════════════
// urlfetch 일일 쿼터 소진 가드 — 소진 감지 시 60분 쿨다운으로 회복 가속
//   - 감지: UrlFetchApp.fetch가 "too many times for one day: urlfetch" 예외를 던질 때(모든 fetch는 csFetch_ 경유)
//   - 기록: Script Property CS_URLFETCH_COOLDOWN_UNTIL = now+60분(ISO)
//   - 자동 run(pollCsInbox)은 쿨다운 중이면 시작부에서 즉시 skip (Gmail·fetch 미접촉). 만료 시 속성 제거 후 재개.
//   - 수동 함수(backfill 등)는 이 게이트를 호출하지 않음 → 쿨다운 무시하고 시도 허용(클라라가 의도적으로 실행).
//   ※ Gmail 예산 가드(budgetGate_/CS_GMAIL_*)와 별개의 독립 가드 — 발송·파서·예산 로직 미변경.
// ══════════════════════════════════════════════════════════════════
var URLFETCH_COOLDOWN_KEY = 'CS_URLFETCH_COOLDOWN_UNTIL';
var URLFETCH_COOLDOWN_MIN = 60;
var _urlfetchStop = false;   // 이번 run 소진 감지 후 추가 fetch 차단(재소진·시간낭비 방지)
var _fetchRunCount = 0;      // 이번 run urlfetch 호출 수(로그용, 계측만)

// ── 순수(테스트용) ──
// urlfetch 사용량 계기판: 일일 카운터 키/증가 (Gmail 카운터와 동일 패턴, 상한·차단 없음 — 계측만)
function fetchUsedKeyFor_(dateStr) { return 'CS_FETCH_USED_' + dateStr; }
function incCounter_(cur) { return parseInt(cur || '0', 10) + 1; }
function fetchUsedKey_() { return fetchUsedKeyFor_(Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd')); }

function isUrlfetchExhausted_(msg) {
  var s = String(msg == null ? '' : msg).toLowerCase();
  return s.indexOf('too many times for one day') >= 0 && s.indexOf('urlfetch') >= 0;
}
function cooldownUntilIso_(nowMs, mins) { return new Date(nowMs + mins * 60000).toISOString(); }
function inCooldown_(untilIso, nowMs) { var t = Date.parse(untilIso); return isFinite(t) && nowMs < t; }

// ── 속성 연동 ──
function enterUrlfetchCooldown_() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty(URLFETCH_COOLDOWN_KEY)) return; // 이미 기록됨 → 중복 방지
  var until = cooldownUntilIso_(Date.now(), URLFETCH_COOLDOWN_MIN);
  p.setProperty(URLFETCH_COOLDOWN_KEY, until);
  Logger.log('⛔ urlfetch 일일 쿼터 소진 감지 — ' + URLFETCH_COOLDOWN_MIN + '분 쿨다운 기록 (해제 예정 ' + until + ')');
}
// 자동 run 시작부 게이트: 쿨다운 중이면 true(skip). 만료 시 속성 제거 후 false(정상 진행).
function urlfetchCooldownActive_() {
  var p = PropertiesService.getScriptProperties();
  var until = p.getProperty(URLFETCH_COOLDOWN_KEY);
  if (!until) return false;
  if (inCooldown_(until, Date.now())) { Logger.log('urlfetch 쿨다운 중, skip (해제 예정 ' + until + ')'); return true; }
  p.deleteProperty(URLFETCH_COOLDOWN_KEY); // 만료 → 해제 후 정상 진행
  return false;
}
// 모든 urlfetch 공통 래퍼: 소진 감지 시 쿨다운 기록 + 같은 run 이후 fetch 차단. 그 외엔 그대로 위임.
function csFetch_(url, params) {
  if (_urlfetchStop) throw new Error('urlfetch cooldown(run-local) — fetch 차단'); // 감지 후 재호출 방지(즉시 종료)
  // 계측만(상한·차단 없음): 실제 fetch 시도마다 일일 카운터 +1 + 이번 run 카운트 (short-circuit분은 미집계)
  var mp = PropertiesService.getScriptProperties();
  var mk = fetchUsedKey_();
  mp.setProperty(mk, String(incCounter_(mp.getProperty(mk))));
  _fetchRunCount++;
  try {
    return UrlFetchApp.fetch(url, params);
  } catch (e) {
    if (isUrlfetchExhausted_(e)) { enterUrlfetchCooldown_(); _urlfetchStop = true; }
    throw e; // 기존 호출부 에러 처리(로그 등) 유지
  }
}

// ── 백로그 컷오프(B): CS_CUTOFF(ISO) 이전 게스트 수신 스레드는 초안·적재 없이 라벨만 이동 ──
// 순수(테스트용). CS_CUTOFF 미설정 → cutoffMs_ = null → isBeforeCutoff_ 항상 false → 현행 동작 유지.
function cutoffMs_(cutoffIso) { if (!cutoffIso) return null; var t = Date.parse(cutoffIso); return isFinite(t) ? t : null; }
function isBeforeCutoff_(msgTimeMs, cutoffMs) { return cutoffMs != null && msgTimeMs > 0 && msgTimeMs < cutoffMs; }

// ══════════════════════════════════════════════════════════════════
// 메인 폴링 — 1분 트리거가 호출
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// Gmail 예산 가드 (HK 쿼터 보호) — CS의 모든 Gmail 호출을 카운팅·차단
//   일일 사용량: 스크립트 속성 CS_GMAIL_USED_<KST날짜>(예: CS_GMAIL_USED_2026-07-07) 누적
//   일일 상한:   스크립트 속성 CS_GMAIL_BUDGET (기본 150). 초과 시 해당 run Gmail 작업 즉시 중단(예외 X).
//   ※ 실제 구글 쿼터 수치는 추측·하드코딩 금지 — 상한은 속성으로만 관리. 다음 날 새 날짜키로 자동 재개.
//   최상위 원칙: CS는 어떤 경우에도 HK(PWR-HK-Engine)의 Gmail 사용을 침해하지 않는다.
// ══════════════════════════════════════════════════════════════════
var _gmailStop = false;      // 이번 run 예산 소진 플래그
var _budgetLogged = false;   // run당 로그 1회

function gmailUsedKey_() {
  return 'CS_GMAIL_USED_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
}
function budgetAllows_(used, budget, n) { return (budget - used) >= (n || 1); } // 순수(테스트용)
function budgetGate_(op) {
  if (_gmailStop) return false;
  var p = PropertiesService.getScriptProperties();
  var budget = parseInt(p.getProperty('CS_GMAIL_BUDGET') || '150', 10);
  var key = gmailUsedKey_();
  var used = parseInt(p.getProperty(key) || '0', 10);
  if (!budgetAllows_(used, budget, 1)) {
    _gmailStop = true;
    if (!_budgetLogged) {
      Logger.log('⛔ CS Gmail 일일 예산 소진 (used=' + used + '/' + budget + ') — Gmail 작업 중단(op=' + op + '). 다음 날 자동 재개.');
      _budgetLogged = true;
    }
    return false;
  }
  p.setProperty(key, String(used + 1)); // 카운트 누적(호출당 1)
  return true;
}
// Gmail 호출 래퍼 — 전부 예산 게이트 경유. 예산 초과 시 안전한 빈값 반환(예외 X).
function gmGetLabel_(name)           { return budgetGate_('getLabel')    ? GmailApp.getUserLabelByName(name) : null; }
function gmCreateLabel_(name)        { return budgetGate_('createLabel') ? GmailApp.createLabel(name)        : null; }
function gmGetThreads_(label, s, n)  { return budgetGate_('getThreads')  ? label.getThreads(s, n)           : []; }
function gmSearch_(q, s, n)          { return budgetGate_('search')      ? GmailApp.search(q, s, n)          : []; }
function gmGetMessages_(thread)      { return budgetGate_('getMessages') ? thread.getMessages()             : []; }
function gmAddLabel_(thread, label)  { if (budgetGate_('addLabel'))      thread.addLabel(label); }
function gmRemoveLabel_(thread, lbl) { if (budgetGate_('removeLabel'))   thread.removeLabel(lbl); }

// ---- 예산 미러링 (M2b-1): run 종료 시 현재 사용량을 cs/meta/gmailBudget 에 기록 ----
// fbSet(Firebase)이므로 Gmail 호출 아님 → 예산 미차감. run당 1회.
function budgetSnapshot_(usedStr, budgetStr, date, fetchUsedStr) { // 순수(테스트용)
  return { used: parseInt(usedStr || '0', 10), budget: parseInt(budgetStr || '150', 10), date: date,
           fetchUsed: parseInt(fetchUsedStr || '0', 10) }; // urlfetch 일일 사용량(계측만)
}
function mirrorBudget_() {
  var p = PropertiesService.getScriptProperties();
  var date = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var snap = budgetSnapshot_(p.getProperty('CS_GMAIL_USED_' + date), p.getProperty('CS_GMAIL_BUDGET'), date,
                             p.getProperty(fetchUsedKey_()));
  try { fbSet('cs/meta/gmailBudget', snap); } catch (e) { Logger.log('budget mirror 실패: ' + e); }
}

// ══════════════════════════════════════════════════════════════════
// M2b-2 — 승인 발송 워커 + autoSend + 학습 루프
// ══════════════════════════════════════════════════════════════════

// 순수(테스트용): 발송 잠금 판정. status/sendingAt(iso)/now(ms) → 'skip'|'stuck-error'|'lock'
function sendDecision_(status, sendingAtIso, nowMs) {
  if (status === 'sending') {
    var since = sendingAtIso ? (nowMs - Date.parse(sendingAtIso)) : Infinity;
    return since > 10 * 60 * 1000 ? 'stuck-error' : 'skip'; // 10분+ 방치 → 스턱 처리
  }
  if (status !== 'approved') return 'skip';
  return 'lock';
}
// 순수(테스트용): autoSend 안전핀. ON && confidence>=0.8 이어야 자동 승인.
function autoApproveDecision_(on, confidence) {
  return !!on && typeof confidence === 'number' && confidence >= 0.8;
}
// 순수(테스트용): 학습 분기. 수정 발송 → learn(초안·수정본 쌍), 무수정 → corpus(정답).
function learnTarget_(edited) { return edited ? 'learn' : 'corpus'; }

// 원 Gmail 스레드에 reply (새 메일 작성 금지). 예산 가드 경유. 예산 없으면 false.
function gmReplyThread_(threadId, body) {
  if (!budgetGate_('reply')) return false;
  var th = GmailApp.getThreadById(threadId);
  if (!th) throw new Error('스레드 못 찾음: ' + threadId);
  th.reply(body);
  return true;
}

// autoSend: pending & 조건 충족 → approved (같은 run 발송 워커가 발송)
function autoApprovePass_() {
  var on = (fbGet('cs/config/autoSend') === true);
  if (!on) return;
  var drafts = fbGet('cs/drafts'); if (!drafts) return;
  var ids = Object.keys(drafts), n = 0;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], d = drafts[id];
    if (!d || d.status !== 'pending') continue;
    if (!autoApproveDecision_(on, d.confidence)) continue; // 안전핀: <0.8 또는 null → pending 유지
    fbUpdate('cs/drafts/' + id, {
      status: 'approved', finalReply: (d.reply || ''), editedByClara: false,
      autoApproved: true, approvedAt: new Date().toISOString()
    });
    n++;
  }
  if (n) Logger.log('autoSend 자동 승인: ' + n + '건');
}

// approved 초안 발송 (최신상태 재확인 → sending 잠금 → 재조회 → reply → sent/error + 학습)
function sendApprovedDrafts() {
  var drafts = fbGet('cs/drafts'); if (!drafts) return;
  var nowMs = new Date().getTime();
  var ids = Object.keys(drafts);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], d = drafts[id];
    if (!d) continue;
    var dec = sendDecision_(d.status, d.sendingAt, nowMs);
    if (dec === 'skip') continue;
    if (dec === 'stuck-error') { fbUpdate('cs/drafts/' + id, { status: 'error', errorMsg: 'sending 10분+ 스턱 — error 전환' }); continue; }
    // dec === 'lock'
    if (_gmailStop || !gmailAllowed_(1)) break; // 예산 소진 → approved 유지, 다음 run/날

    var fresh = fbGet('cs/drafts/' + id);
    if (!fresh || fresh.status !== 'approved') continue;         // 최신 상태 재확인(경합/중복 방지)
    fbUpdate('cs/drafts/' + id, { status: 'sending', sendingAt: new Date().toISOString() });
    var chk = fbGet('cs/drafts/' + id);
    if (!chk || chk.status !== 'sending') continue;              // 잠금 확인 실패 → 양보

    if (fresh.emailReply === false) { // 익스피디아 등: 이메일 회신 미지원
      fbUpdate('cs/drafts/' + id, { status: 'error', errorMsg: '익스피디아는 이메일 회신 미지원 — 파트너센트럴에서 초안 복붙 발송' });
      continue;
    }
    var threadId = fresh.threadId || (fbGet('cs/inbox/' + id) || {}).threadId;
    var finalReply = fresh.finalReply || fresh.editedReply || fresh.reply || '';
    if (!threadId) { fbUpdate('cs/drafts/' + id, { status: 'error', errorMsg: 'threadId 없음 — 발송 불가' }); continue; }
    if (!finalReply) { fbUpdate('cs/drafts/' + id, { status: 'error', errorMsg: 'finalReply 비어있음' }); continue; }

    try {
      var ok = gmReplyThread_(threadId, finalReply);
      if (!ok) { fbUpdate('cs/drafts/' + id, { status: 'approved', sendingAt: null }); break; } // 예산 없음 → 되돌림, 다음 run
      fbUpdate('cs/drafts/' + id, { status: 'sent', sentAt: new Date().toISOString(), errorMsg: null });
      learnFromSend_(id, fresh, finalReply);
      Logger.log('발송 완료 ' + id + (fresh.autoApproved ? ' (자동)' : ''));
    } catch (e) {
      fbUpdate('cs/drafts/' + id, { status: 'error', errorMsg: String(e).slice(0, 200) });
      Logger.log('발송 실패 ' + id + ': ' + e);
    }
  }
}

// 학습 루프: 무수정 → cs/corpus(정답 적재), 수정 → cs/learn(초안·수정본 쌍)
function learnFromSend_(id, d, finalReply) {
  try {
    var inbox = fbGet('cs/inbox/' + id) || {};
    var orig = (inbox.parsed && inbox.parsed.message) || d.origMsg || '';
    var lang = d.lang || 'en';
    if (learnTarget_(d.editedByClara) === 'learn') {
      fbSet('cs/learn/' + id, {
        before: d.reply || '', after: finalReply, orig: orig,
        lang: lang, category: d.category || null, ts: new Date().toISOString()
      });
    } else {
      fbSet('cs/corpus/' + id, {
        '상황요약': orig, '최종답변': finalReply, lang: lang, category: d.category || null, origin: 'approved'
      });
    }
  } catch (e) { Logger.log('learn 실패 ' + id + ': ' + e); }
}

// ---- 트리거 설치 (Clara 수동 실행 전용 — 자동 설치 금지) ----
// 이 프로젝트(PWR-CS-Engine)의 기존 트리거 전부 삭제 후 pollCsInbox 5분 주기 1개만 설치.
function installCsTriggers() {
  var trg = ScriptApp.getProjectTriggers(); // 이 프로젝트 한정 — HK와 무관
  var removed = 0;
  for (var i = 0; i < trg.length; i++) { ScriptApp.deleteTrigger(trg[i]); removed++; }
  ScriptApp.newTrigger('pollCsInbox').timeBased().everyMinutes(5).create();
  Logger.log('CS 트리거 재설치: 기존 ' + removed + '개 삭제 → pollCsInbox 5분 주기 1개 설치');
}

function safeDrafts_() { try { processInboxToDrafts(); } catch (e) { Logger.log('draft 파이프라인 실패: ' + e); } }

function pollCsInbox() {
  if (urlfetchCooldownActive_()) return; // urlfetch 쿨다운 중: 즉시 반환(Gmail·fetch 미접촉). 만료 시 내부에서 해제 후 진행.
  var label = gmGetLabel_(CS_LABEL);
  if (_gmailStop) { safeDrafts_(); return; }
  if (!label) { Logger.log('라벨 없음: ' + CS_LABEL + ' — §6f 필터 확인'); safeDrafts_(); return; }

  var doneLabel = gmGetLabel_(CS_DONE_LABEL) || gmCreateLabel_(CS_DONE_LABEL);
  if (_gmailStop || !doneLabel) { safeDrafts_(); return; }

  // 저연비: 처리 완료 스레드는 CS_LABEL에서 제거(라벨 이동)하므로 매 run 미처리분만 조회됨.
  // (멱등 이중 안전판: ingestMessage_ 의 fbGet 존재체크가 재적재 방지)
  // 백로그 컷오프(B): CS_CUTOFF 이전 스레드는 초안·적재 건너뛰고 라벨만 이동(urlfetch 미사용).
  var cutoffMs = cutoffMs_(PropertiesService.getScriptProperties().getProperty('CS_CUTOFF'));
  var cutoffSkipped = 0;
  var threads = gmGetThreads_(label, 0, 20);
  for (var t = 0; t < threads.length && !_gmailStop; t++) {
    var msgs = gmGetMessages_(threads[t]);
    if (_gmailStop) break;
    var latestMs = msgs.length ? msgs[msgs.length - 1].getDate().getTime() : 0; // 스레드 최신 메시지 시각(Gmail, urlfetch 아님)
    if (isBeforeCutoff_(latestMs, cutoffMs)) {                                   // 컷오프 이전 → 적재/초안 스킵
      gmAddLabel_(threads[t], doneLabel); gmRemoveLabel_(threads[t], label);
      cutoffSkipped++;
      continue;
    }
    var hadFailure = false;
    for (var m = 0; m < msgs.length; m++) {
      try { ingestMessage_(msgs[m], threads[t].getId()); }
      catch (e) { Logger.log('적재 실패 msgId=' + safeId_(msgs[m]) + ' : ' + e); hadFailure = true; }
    }
    if (!hadFailure) { gmAddLabel_(threads[t], doneLabel); gmRemoveLabel_(threads[t], label); }
  }
  if (cutoffSkipped) Logger.log('컷오프 이전 — 초안 스킵: ' + cutoffSkipped + '건');

  // 초안 생성은 Gmail 미사용 → 예산과 무관하게 항상 진행 (수신과 분리)
  safeDrafts_();
  // autoSend: ON & confidence>=0.8 → 자동 승인 (Firebase만, Gmail 미사용)
  try { autoApprovePass_(); } catch (e) { Logger.log('autoApprove 실패: ' + e); }
  // 발송 워커: approved → 원 스레드 reply + 학습 (예산 가드). 발송 실패가 위 단계를 막지 않음.
  try { sendApprovedDrafts(); } catch (e) { Logger.log('발송 워커 실패: ' + e); }
  mirrorBudget_(); // run 종료 시 예산 사용량 미러링 (fetchUsed 포함)
  Logger.log('이번 run fetch: ' + _fetchRunCount + '회'); // urlfetch 소비 패턴 분석용
}

function ingestMessage_(msg, threadId) {
  var msgId = msg.getId();
  var path = 'cs/inbox/' + msgId;

  // 멱등성: 이미 적재됐으면 스킵 (라벨 누락/재처리 대비 이중 안전판)
  if (fbGet(path)) return;

  var raw = {
    from: msg.getFrom(),
    subject: msg.getSubject(),
    body: msg.getPlainBody(),
    receivedAt: msg.getDate().toISOString()
  };

  var parsed = parseBooking_(raw);
  // 채널 판별 1차 관문: 3채널(booking/agoda/expedia) 아니면 적재 안 함(라벨 이동은 pollCsInbox가 처리).
  if (!parsed.channel) { Logger.log('비대상 발신자 스킵(적재 안 함): ' + raw.from); return; }

  var rec = {
    source: parsed.source || parsed.channel,
    emailReply: parsed.emailReply !== false, // expedia=false → 발송 워커가 error 처리
    bookingId: parsed.bookingId || null,
    guest: parsed.guest || null,
    lang: parsed.lang || guessLang_(parsed.message || raw.body),
    replyTo: parsed.guestEmail || null,      // 게스트 회신 주소(=발신주소). M2 발송 경로.
    threadId: threadId || null,              // 원 Gmail 스레드 — 발송 시 이 스레드에 reply
    receivedAt: raw.receivedAt,
    raw: raw,                 // §6c: 파싱 실패해도 raw 는 항상 보존 — 메일 유실 금지
    parsed: parsed.ok ? { message: parsed.message } : null,
    parseFailed: !parsed.ok, // §6c: 파싱실패 플래그
    bookingIdMismatch: parsed.bookingIdMismatch || false, // From/본문 예약번호 불일치 감지
    rawTail: parsed.rawTail || false, // 종료마커 못 찾아 message 전체 유지됨 플래그
    checkinDate: parsed.checkinDate || null,   // 예약 상세: 체크인 (YYYY-MM-DD)
    checkoutDate: parsed.checkoutDate || null, // 예약 상세: 체크아웃 (YYYY-MM-DD)
    guestCount: parsed.guestCount || null,     // 예약 상세: 총 투숙객 수
    roomCount: parsed.roomCount || null,       // 예약 상세: 총 객실 수
    propertyName: parsed.propertyName || null, // 예약 상세: 숙소 명칭
    ingestedAt: new Date().toISOString()
  };

  fbSet(path, rec);
  Logger.log((parsed.ok ? 'OK ' : 'RAW-ONLY ') + msgId + ' / ' + (parsed.bookingId || '?'));
}

// ══════════════════════════════════════════════════════════════════
// 파싱 — 실제 Booking.com 호스트 알림메일 구조 (Fable 회신 실물 3건 기준)
//   From : {예약번호}-{난수}@guest.booking.com  (이 주소로 회신 = 게스트 도달)
//   제목 : "{게스트명} 님의 메시지가 도착했습니다"
//   본문 : … "예약 번호: {10자리}" … "{게스트명} 님의 메시지:" {본문} "답변 -->" {링크}
//   ⚠️ 예약번호는 부킹 원번호(10자리). Firebase Sirvoy 내부번호(5자리)와 다름 → M2 매핑 과제.
//   실패해도 raw 는 ingestMessage_ 에서 항상 보존됨(§6c).
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// 파서 v2 — 3채널(부킹 EN / 아고다 / 익스피디아) 실물 형식 대응.
//   라벨 필터가 3채널 모두 cs/booking 으로 걸려 폴링에 섞여 옴 → From 도메인으로 채널 판별이 1차 관문.
// ══════════════════════════════════════════════════════════════════

function detectChannel_(from) {
  var f = String(from || '').toLowerCase();
  if (f.indexOf('@guest.booking.com') >= 0) return 'booking';
  if (f.indexOf('agoda-messaging.com') >= 0) return 'agoda';
  if (f.indexOf('expediapartnercentral.com') >= 0) return 'expedia';
  return null;
}
function newParse_() {
  return { ok: false, source: null, channel: null, bookingId: null, guest: null, guestEmail: null,
           lang: null, message: null, bookingIdMismatch: false, rawTail: false,
           checkinDate: null, checkoutDate: null, guestCount: null, roomCount: null,
           propertyName: null, emailReply: true };
}

// 엔트리: 채널 판별 → 채널별 파서. 비대상 발신자는 {channel:null, skip:true} → 적재 안 함.
function parseBooking_(raw) {
  var channel = detectChannel_(raw.from);
  if (!channel) { var s = newParse_(); s.skip = true; return s; }
  var out = channel === 'booking' ? parseBookingCh_(raw)
          : channel === 'agoda'   ? parseAgoda_(raw)
          :                         parseExpedia_(raw);
  out.channel = channel; out.source = channel;
  // 공통 이력 오염 방지: 종료마커 실패(rawTail)면 message를 앞 1000자로 제한
  if (out.rawTail && out.message && out.message.length > 1000) out.message = out.message.slice(0, 1000);
  return out;
}

// 1) 부킹 — 영문 템플릿 + 한국어 레거시 폴백
function parseBookingCh_(raw) {
  var out = newParse_();
  var body = raw.body || '', subject = raw.subject || '', from = raw.from || '';
  var lines = body.split('\n');

  // 게스트명: EN "We received this message from {name}" / KO "{name} 님의 메시지가 도착했습니다"
  var mEN = subject.match(/We received this message from\s+(.+?)\s*$/i);
  if (mEN) out.guest = mEN[1].trim();
  else { var mKO = subject.match(/^(.*?)\s*님의\s*메시지가\s*도착했습니다/); if (mKO) out.guest = mKO[1].trim(); }

  // 예약번호: From {번호}@guest.booking.com (1차, 실측작동) + 본문 Confirmation/Booking number/예약 번호 (교차검증)
  var mFrom = from.match(/([0-9]+)(?:-[a-z0-9.]+)?@guest\.booking\.com/i);
  var fromNum = mFrom ? mFrom[1] : null;
  out.guestEmail = (from.match(/[\w.\-]+@guest\.booking\.com/i) || [])[0] || null;
  var confRaw = findLineValue_(lines, 'Confirmation number') || findLineValue_(lines, 'Booking number');
  var bodyNum = confRaw ? ((String(confRaw).match(/(\d{6,})/) || [])[1] || null) : null;
  if (!bodyNum) { var mk = body.match(/예약\s*번호\s*[:：]\s*([0-9]{6,})/); if (mk) bodyNum = mk[1]; }
  if (fromNum && bodyNum && fromNum !== bodyNum) out.bookingIdMismatch = true;
  out.bookingId = fromNum || bodyNum || null;

  // 예약 상세 (EN 라벨 + KO 레거시). normDate_ 가 영문 날짜도 처리.
  out.checkinDate  = normDate_(findLineValue_(lines, 'Check-in')  || findLineValue_(lines, '체크인'));
  out.checkoutDate = normDate_(findLineValue_(lines, 'Check-out') || findLineValue_(lines, '체크아웃'));
  out.guestCount   = findLineValue_(lines, 'Total guests') || findLineValue_(lines, '총 투숙객 수');
  out.roomCount    = findLineValue_(lines, 'Total rooms')  || findLineValue_(lines, '총 객실 수');
  out.propertyName = findLineValue_(lines, 'Property name') || findLineValue_(lines, '숙소 명칭');
  if (!out.guest) out.guest = findLineValue_(lines, 'Guest name');

  // 메시지: "{name} said:"(EN) 또는 "님의 메시지:"(KO) 줄 다음 ~ 종료마커 전까지 (줄 단위)
  var si = -1;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (/said:\s*$/i.test(t) || t.indexOf('님의 메시지:') >= 0) { si = i; break; }
  }
  if (si >= 0) {
    if (!out.guest) { var sm = lines[si].trim().match(/^(.*?)\s+said:\s*$/i); if (sm) out.guest = sm[1].trim(); }
    var msg = [];
    for (var j = si + 1; j < lines.length; j++) {
      var u = lines[j].trim();
      if (u === 'Reply' || u.indexOf('-->') === 0 || u.indexOf('Reservation details') === 0
          || u === '답변' || u.indexOf('예약 상세 정보') === 0 || u.indexOf('© Copyright') === 0) break;
      msg.push(lines[j]);
    }
    out.message = msg.join('\n').trim() || null;
  } else {
    out.message = body.trim() || null; out.rawTail = true; // 마커 못 찾음 → 전체(상한은 dispatcher에서)
  }

  out.lang = guessLang_(out.message);
  out.ok = !!(out.bookingId && out.message);
  return out;
}

// 2) 아고다 — 한글 템플릿
function parseAgoda_(raw) {
  var out = newParse_();
  var body = raw.body || '', subject = raw.subject || '', from = raw.from || '';
  var lines = body.split('\n');

  // 게스트명: 제목 "Reply from {name} (...)" 괄호 전까지, 없으면 From 표시명
  var mg = subject.match(/Reply from\s+(.+?)\s*\(/i);
  if (mg) out.guest = mg[1].trim();
  else { var dm = from.match(/^\s*"?([^"<]+?)"?\s*</); if (dm) out.guest = dm[1].trim(); }

  // 예약번호: 본문 "예약 번호:" (한국어 정규식 그대로)
  var mk = body.match(/예약\s*번호\s*[:：]\s*([0-9]{6,})/);
  out.bookingId = mk ? mk[1] : null;

  // 체크인/아웃: 제목 괄호의 날짜 범위 "Jul 11-12, 2026"
  var mr = subject.match(/\(([^)]+)\)/);
  if (mr) {
    var d = mr[1].match(/([A-Za-z]{3,})\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s*(\d{4})/);
    if (d) { var mo = monthNum_(d[1]); if (mo) { out.checkinDate = d[4] + '-' + pad2_(mo) + '-' + pad2_(d[2]); out.checkoutDate = d[4] + '-' + pad2_(mo) + '-' + pad2_(d[3]); } }
  }

  // 메시지: 게스트 메시지 첫 블록만 (종료마커 전까지, 헤더 라인 스킵).
  //   ※ 실물 스펙에 메시지 '시작' 마커가 없어, 종료마커 이전 '첫 산문 블록'을 취함(헤더 제외) — 런타임 확인 필요.
  var endIdx = lines.length;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t.indexOf('아래 원문 메시지') >= 0 || t.indexOf('Did you know?') >= 0 || t.indexOf('이전 메시지') >= 0) { endIdx = i; break; }
  }
  var mm = [], started = false;
  for (var j = 0; j < endIdx; j++) {
    var raw2 = lines[j], u = raw2.trim();
    var isHeader = /^예약\s*번호/.test(u) || /^Reply from/i.test(u) || (out.guest && u === out.guest);
    if (!started) { if (u === '' || isHeader) continue; started = true; mm.push(raw2); }
    else { if (u === '' || isHeader) break; mm.push(raw2); }
  }
  out.message = mm.join('\n').trim() || null;

  out.lang = guessLang_(out.message);
  out.ok = !!(out.bookingId && out.message);
  return out;
}

// 3) 익스피디아 — 한글 템플릿 (예약번호 없음, 이메일 회신 미지원)
function parseExpedia_(raw) {
  var out = newParse_();
  out.emailReply = false; // 이메일 회신 경로 없음 → 발송 워커가 error 처리(파트너센트럴 웹 전용)
  var body = raw.body || '', subject = raw.subject || '';

  // 게스트명: 제목 "...고객 {name} 님의 메시지"
  var mg = subject.match(/고객\s+(.+?)\s*님의\s*메시지/);
  if (mg) out.guest = mg[1].trim();

  // 메시지: "{name} 님이 메시지를 보냈습니다." 다음의 따옴표 인용문
  var idx = body.indexOf('님이 메시지를 보냈습니다');
  if (idx >= 0) {
    var after = body.slice(idx);
    var q = after.match(/["“”‘’]([\s\S]+?)["“”‘’]/);
    if (q) out.message = q[1].trim();
    else { var ls = after.split('\n'); for (var i = 1; i < ls.length; i++) { if (ls[i].trim()) { out.message = ls[i].trim(); break; } } }
  }

  out.bookingId = null;                       // 실물에 없음 (null 허용)
  out.lang = guessLang_(out.message);
  out.ok = !!(out.guest && out.message);      // expedia: 게스트+메시지로 ok 판정
  return out;
}

// 언어 추정 — 유니코드 블록 기반 간이 휴리스틱 (기본 en)
function guessLang_(text) {
  if (!text) return 'en';
  if (/[가-힣]/.test(text)) return 'ko';
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';
  if (/[฀-๿]/.test(text)) return 'th';
  if (/[À-ſ]/.test(text)) return 'eu'; // 서유럽 계열(불/독/스페인 등) — 세분화는 M2
  return 'en';
}

function safeId_(msg) { try { return msg.getId(); } catch (e) { return '?'; } }

// (threadHasLabel_ 제거: 저연비 라벨-이동 방식으로 대체되어 미사용. 예산 밖 getLabels 호출 제거.)

// 라벨 줄 값 추출: "라벨: 값"(같은 줄) 또는 라벨 다음 첫 비어있지 않은 줄. 없으면 null.
function findLineValue_(lines, label) {
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t.indexOf(label) === 0) {
      var rest = t.substring(label.length).replace(/^[:：]\s*/, '').trim();
      if (rest) return rest;
      for (var j = i + 1; j < lines.length; j++) { var n = lines[j].trim(); if (n) return n; }
      return null;
    }
  }
  return null;
}

function monthNum_(s) {
  var M = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  return M[String(s || '').slice(0, 3).toLowerCase()] || null;
}
// 날짜 정규화 → YYYY-MM-DD. 숫자형(YYYY-MM-DD / . / "YYYY년 M월 D일") + 영문형("Tue 7 Jul 2026"/"Jul 7, 2026"). 실패 null.
function normDate_(s) {
  if (!s) return null;
  var m = s.match(/(\d{4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/);
  if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  var e = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);        // "Tue 7 Jul 2026" / "7 Jul 2026"
  if (e && monthNum_(e[2])) return e[3] + '-' + pad2_(monthNum_(e[2])) + '-' + pad2_(e[1]);
  var e2 = s.match(/([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})/);     // "Jul 7, 2026"
  if (e2 && monthNum_(e2[1])) return e2[3] + '-' + pad2_(monthNum_(e2[1])) + '-' + pad2_(e2[2]);
  return null;
}
function pad2_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

// ══════════════════════════════════════════════════════════════════
// 수동 점검용 (트리거 아님) — GAS 에디터에서 직접 실행해 파싱 결과만 로그로 확인
// ══════════════════════════════════════════════════════════════════
function debugPeekLatest() {
  var label = gmGetLabel_(CS_LABEL);
  if (_gmailStop) return;
  if (!label) { Logger.log('라벨 없음: ' + CS_LABEL); return; }
  var threads = gmGetThreads_(label, 0, 1);
  if (_gmailStop || !threads.length) { if (!_gmailStop) Logger.log('라벨에 메일 없음'); return; }
  var msg = gmGetMessages_(threads[0])[0];
  if (!msg) return;
  var raw = { from: msg.getFrom(), subject: msg.getSubject(), body: msg.getPlainBody(), receivedAt: msg.getDate().toISOString() };
  Logger.log(JSON.stringify(parseBooking_(raw), null, 2));
}

// ══════════════════════════════════════════════════════════════════
// M2a — 코퍼스 + 초안 생성 + 텔레그램 푸시
// ══════════════════════════════════════════════════════════════════

var CLAUDE_MODEL   = 'claude-haiku-4-5-20251001'; // 저비용 라인 (haiku급)
var CLAUDE_MAXTOK  = 1024;                         // 보수적
var CS_DB_SHEET_ID = '1JHbIEJ9XX1Pxp0JPPgQmJ-1xWI7e5fKtrws4x-iCcJg'; // CLAUDE.md §7
var PENDING_PATH   = 'app/pendingBookings';                          // Firebase 실측 확정 경로 (Fable)
var DRAFT_BATCH    = 5;  // 폴링 1회당 최대 초안 생성 수 (실행시간·비용 캡)

// ---- 클라라 페르소나 (시스템 프롬프트) ----
var CLARA_SYSTEM =
  '당신은 파라다이스워크 레지던스(Paradise Walk Residence)의 호스트 "클라라"입니다. ' +
  'OTA(부킹닷컴) 게스트 메시지에 클라라의 말투(간결·다정·실용)로 답합니다. ' +
  '아래 [과거 응대 예시]의 어투와 사실을 최대한 따르세요. ' +
  '확실치 않은 사실(가격·정책·주소·시설 세부 등)은 지어내지 말고, 확인 후 안내하겠다고 정중히 답합니다. ' +
  '[숙소 확정 정보] 아래는 게스트 가이드(https://pwr-guide.online)의 확정 사실입니다. 관련 문의엔 이 정보로 직접 정확히 답하고, 되도록 가이드 링크를 함께 안내하세요(아래에 없는 세부는 지어내지 말 것):\n' +
  '· 위치/셔틀: 인천공항 T1 인근 무인 셀프 체크인 레지던스. 무료 순환버스 — T1은 3층 3·12번 게이트, T2는 3층 7번 게이트에서 03번 버스(AICC행) 탑승 → Grand Hyatt Hotel 하차(T1 첫 정류장, T2 4번째) → 횡단보도 건너면 건물. 공항 복귀는 04번 버스(T1 약 5분, T2 약 25분).\n' +
  '· 체크인/아웃: 체크인 15:00부터, 체크아웃 11:00까지. 체크인 전·체크아웃 후 짐 보관 불가(현장 사무실 없음).\n' +
  '· 객실: Wi-Fi 정보는 TV가 놓인 서랍장 끝 스티커. 냉난방은 팬코일(패널은 욕실 문 옆).\n' +
  '· 주차: 건물 내 유료만 — 첫 20분 ₩1,000, 이후 30분당 ₩1,000, 1일 최대 ₩50,000. 공항 인근 규정으로 무료 주차 지원 불가.\n' +
  '· 하우스룰: 전면 금연(위반 시 특별 청소비), 최대 2인, 반려동물 불가, 파티·소음 금지, 예고 없는 방문자에게 문 열지 말 것(저희 팀은 사전 안내 없이 방문하지 않음).\n' +
  '· 도어코드: 개인정보·안전을 위해 객실 번호·도어코드는 도착 당일 예약 플랫폼 메시지로만 발송.\n' +
  '· 문의: WhatsApp +82 10-8227-2845, LINE·WeChat ID pwresi, 지원 시간 09:00–21:00 KST(그 외 시간대 답변 지연 가능).\n' +
  '게스트 언어가 영어가 아니면 reply 끝에 한 줄 번역 면책 문구를 그 게스트 언어로 덧붙이세요. ' +
  '[안내 이미지 링크] 관련된 문의일 때만 아래 URL을 답변(reply)에 플레인텍스트 전체 URL로 자연스럽게 포함하세요(마크다운·대괄호 금지, 강제 삽입 금지, 관련 없으면 넣지 말 것):\n' +
  '- 셔틀/오시는길/공항 이동 문의: https://pwr-clair.github.io/cs/assets/images/Map-shuttle-overview.jpeg (공항↔숙소 전체 경로), https://pwr-clair.github.io/cs/assets/images/map-to-airport.png (숙소→버스정류장 도보)\n' +
  '- 건물을 못 찾거나 첫 도착 안내: https://pwr-clair.github.io/cs/assets/images/Building.jpg (건물 외관), https://pwr-clair.github.io/cs/assets/images/Elevator-1st-floor-01.jpeg (1층 엘리베이터)\n' +
  '응답은 반드시 JSON 하나로만 출력: ' +
  '{"reply": 게스트 언어 답변, "replyKo": 한국어 대역, "category": 짧은 분류(한국어), "confidence": 0~1 숫자}. ' +
  'JSON 외 다른 텍스트를 출력하지 마세요.';

// ---- (2) 초안 생성 파이프라인: 신규 inbox → cs/drafts ----
function processInboxToDrafts() {
  var inbox = fbGet('cs/inbox'); if (!inbox) return;
  var drafts = fbGet('cs/drafts') || {};
  var ids = Object.keys(inbox), made = 0;
  for (var i = 0; i < ids.length && made < DRAFT_BATCH; i++) {
    var id = ids[i], rec = inbox[id];
    if (!rec || rec.parseFailed) continue; // 파싱 실패건은 초안 생략(수동 처리)
    if (drafts[id]) continue;              // 이미 초안 있음(멱등)
    try { makeDraftFor_(id, rec); made++; }
    catch (e) { Logger.log('draft 실패 ' + id + ': ' + e); }
  }
  if (made) Logger.log('drafts 생성: ' + made + '건');
}

function makeDraftFor_(msgId, inbox) {
  var examples = retrieveExamples_(inbox);
  var d = claudeDraft_(inbox, examples);
  var sirvoy = findSirvoy_(inbox.bookingId); // {sirvoyId, room} 또는 null

  var rec = {
    reply: d.reply, replyKo: d.replyKo, category: d.category, confidence: d.confidence,
    status: 'pending', editedReply: null,
    lang: inbox.lang || 'en', guest: inbox.guest || null, bookingId: inbox.bookingId || null,
    replyTo: inbox.replyTo || null,
    threadId: inbox.threadId || null,           // 발송 스레드 (없으면 발송 워커가 error 처리)
    emailReply: inbox.emailReply !== false,     // false(expedia) → 발송 워커가 error 처리
    origMsg: (inbox.parsed && inbox.parsed.message) || null, // 승인 UI에 게스트 원문 표시용
    sirvoyId: sirvoy ? sirvoy.sirvoyId : null,  // pendingBookings 매칭 키(Sirvoy 내부번호). 실패 시 null.
    room: sirvoy ? sirvoy.room : null,
    receivedAt: inbox.receivedAt || null,       // 게스트 원 메일 수신시각(정렬·지난문의 판별용, inbox에서 승계)
    model: CLAUDE_MODEL, examplesUsed: examples.length, createdAt: new Date().toISOString()
  };
  fbSet('cs/drafts/' + msgId, rec);

  // (3) 텔레그램 푸시
  var first = (((inbox.parsed && inbox.parsed.message) || '').split('\n')[0] || '').trim();
  if (first.length > 40) first = first.slice(0, 40) + '…';
  tgNotify_('[PWR CS] ' + (inbox.guest || '게스트') + ' (' + (rec.room || '미상') + ') ' + first + ' → 초안 대기');
}

// (2b) 1회성 백필: receivedAt 없는 기존 draft에 inbox의 receivedAt 승계.
//   - 추가만(다른 필드·상태 불변), 멱등(이미 있으면 스킵). 발송/예산/파서 미접촉.
//   - Gmail 미사용(fbGet/fbUpdate만) → 예산 미차감. 백로그 정렬·지난문의 판별 정확도 확보용.
//   Clara가 GAS 에디터에서 1회 실행.
function backfillDraftReceivedAt() {
  var drafts = fbGet('cs/drafts'); if (!drafts) { Logger.log('drafts 없음'); return; }
  var inbox = fbGet('cs/inbox') || {};
  var ids = Object.keys(drafts), filled = 0, skipped = 0, noSrc = 0;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], d = drafts[id];
    if (!d) continue;
    if (d.receivedAt) { skipped++; continue; }            // 이미 있음 → 멱등 스킵
    var src = (inbox[id] || {}).receivedAt;
    if (!src) { noSrc++; continue; }                        // inbox에 없으면 앱이 createdAt 폴백
    fbUpdate('cs/drafts/' + id, { receivedAt: src });       // 추가만
    filled++;
  }
  Logger.log('backfill 완료 — 채움:' + filled + ' / 이미있음:' + skipped + ' / inbox없음:' + noSrc);
}

// corpus 유사사례 검색: 같은 언어 우선 + 키워드 겹침 점수 상위 5건 (임베딩 아님 — M2a 범위)
function retrieveExamples_(inbox) {
  var corpus = fbGet('cs/corpus'); if (!corpus) return [];
  var lang = inbox.lang || 'en';
  var msg = (((inbox.parsed && inbox.parsed.message) || '')).toLowerCase();
  var toks = msg.split(/\s+/).filter(function (w) { return w.length > 1; });
  var arr = [];
  for (var k in corpus) {
    var c = corpus[k]; if (!c || !c['최종답변']) continue;
    var score = (c.lang === lang ? 5 : 0);
    var hay = (((c['상황요약'] || '') + ' ' + (c['최종답변'] || ''))).toLowerCase();
    for (var t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) >= 0) score++;
    arr.push({ c: c, score: score });
  }
  arr.sort(function (a, b) { return b.score - a.score; });
  var out = []; for (var i = 0; i < arr.length && i < 5; i++) out.push(arr[i].c);
  return out;
}

// Claude API 호출 (UrlFetchApp). 키는 스크립트 속성 ANTHROPIC_KEY 에서만.
function claudeDraft_(inbox, examples) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!key) throw new Error('스크립트 속성 ANTHROPIC_KEY 미설정');

  var ex = '';
  for (var i = 0; i < examples.length; i++)
    ex += '상황: ' + (examples[i]['상황요약'] || '') + '\n답변: ' + (examples[i]['최종답변'] || '') + '\n---\n';
  var message = (inbox.parsed && inbox.parsed.message) || (inbox.raw && inbox.raw.body) || '';
  var user = '[과거 응대 예시]\n' + (ex || '(예시 없음)\n') +
             '\n[이번 게스트 메시지] (언어=' + (inbox.lang || 'en') + ')\n' + message +
             '\n\n위 지침대로 JSON만 출력하세요.';

  var payload = { model: CLAUDE_MODEL, max_tokens: CLAUDE_MAXTOK, system: CLARA_SYSTEM,
                  messages: [{ role: 'user', content: user }] };
  var res = csFetch_('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('Claude API ' + res.getResponseCode() + ': ' + res.getContentText());
  var body = JSON.parse(res.getContentText());
  var text = (body.content && body.content[0] && body.content[0].text) || '';
  var obj = extractJson_(text);
  if (!obj) throw new Error('Claude 응답 JSON 파싱 실패: ' + text.slice(0, 200));
  return {
    reply: obj.reply || '', replyKo: obj.replyKo || '',
    category: obj.category || '기타',
    confidence: (typeof obj.confidence === 'number' ? obj.confidence : null)
  };
}
function extractJson_(s) {
  var i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < 0) return null;
  try { return JSON.parse(s.substring(i, j + 1)); } catch (e) { return null; }
}

// ---- 매핑: cs/inbox.bookingId(원번호) ↔ pendingBookings.channelBookingId ----
var _pendingCache = null;
function loadPending_() {
  if (_pendingCache !== null) return _pendingCache;
  try { var d = fbGet(PENDING_PATH); if (d) { _pendingCache = d; return d; } } catch (e) {}
  _pendingCache = {}; return _pendingCache;
}
function findSirvoy_(bookingId) {
  if (!bookingId) return null;
  var p = loadPending_();
  for (var key in p) {
    var b = p[key];
    if (b && String(b.channelBookingId) === String(bookingId))
      return { sirvoyId: key, room: (b.assignedRoom || null) }; // 문자열 방번호(예 "620"). 미배정 시 필드 없음 → null → 푸시 "미상"
  }
  return null; // 매칭 실패 → null 허용 (폴백 미구현, Fable 지시)
}

// ---- (3) 텔레그램 ----
function tgNotify_(text) {
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty('TG_TOKEN'), chat = props.getProperty('TG_CHAT');
  if (!tok || !chat) { Logger.log('TG 미설정 — 푸시 스킵: ' + text); return; }
  try {
    csFetch_('https://api.telegram.org/bot' + tok + '/sendMessage', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chat, text: text }), muteHttpExceptions: true
    });
  } catch (e) { Logger.log('TG 실패: ' + e); }
}

// ══════════════════════════════════════════════════════════════════
// (1) 코퍼스 구축 — 1회성 함수 (트리거 아님, Clara가 GAS 에디터에서 실행)
// ══════════════════════════════════════════════════════════════════

// (1a) CS-DB 시트 임포트 → cs/corpus
// ※ Gmail 예산 가드 대상(§5): 이 함수는 SpreadsheetApp만 사용하고 GmailApp 호출이 없어
//   Gmail 쿼터를 소모하지 않음 → 감쌀 Gmail 호출 없음(예산 영향 N/A).
function importCorpusFromSheet() {
  var ss = SpreadsheetApp.openById(CS_DB_SHEET_ID);
  var sheet = ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) { Logger.log('시트 데이터 없음'); return; }

  // 확정 헤더(Fable): A=lang, B=guest_message, C=clara_reply, D=category. 정확 일치 요구, 불일치 시 중단(추측 금지).
  var EXPECT = ['lang', 'guest_message', 'clara_reply', 'category'];
  var header = values[0].map(function (h) { return String(h).trim(); });
  for (var c = 0; c < EXPECT.length; c++) {
    if (header[c] !== EXPECT[c]) {
      Logger.log('헤더 불일치: [' + header.join(' | ') + '] — 기대 [' + EXPECT.join(' | ') + ']. 중단.');
      return;
    }
  }

  var n = 0, skippedNoAns = 0;
  for (var r = 1; r < values.length; r++) {
    var lang = String(values[r][0] || '').trim();   // A lang
    var situ = String(values[r][1] || '').trim();   // B guest_message → 상황요약
    var ans  = String(values[r][2] || '').trim();   // C clara_reply   → 최종답변
    var cat  = String(values[r][3] || '').trim();   // D category
    if (!situ && !ans) continue;                     // 완전 빈 행
    // 답변 미기입 행은 흡수하지 않고 corpus 마킹도 안 함 → 나중에 답을 채우면 재실행 시 정상 흡수(D3).
    if (!ans) { skippedNoAns++; continue; }
    if (!lang) lang = guessLang_(ans || situ);
    var id = 'sheet_' + r;                           // 행 위치 기반 멱등(행 삽입·삭제 금지 전제 — export는 말단 append만)
    if (fbGet('cs/corpus/' + id)) continue;          // 재실행 멱등(이미 흡수한 답변 행)
    fbSet('cs/corpus/' + id, {
      '상황요약': situ, '최종답변': ans, lang: lang, category: cat || null, origin: '구축', src: 'sheet'
    });
    n++;
  }
  if (skippedNoAns) Logger.log('답변 미기입 스킵: ' + skippedNoAns + '건 (클라라가 clara_reply 채운 뒤 재실행하면 흡수)');
  Logger.log('시트 임포트 완료: corpus +' + n + '건');
}

// ── 순수(테스트용): 질문 정규화(중복 판정용) / 단순 인사·감사 판별 ──
function normQ_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…~]+$/,'').trim();
}
function isTrivialMessage_(s) {
  var t = normQ_(s);
  if (!t || t.length <= 3) return true; // 빈/너무 짧음
  // 메시지 전체가 인사/감사뿐(질문 요소 없음)일 때만 true — 실제 질문은 통과.
  var TRIVIAL = /^(hi|hello|hey|yo|thanks|thank you|thx|ty|ok|okay|good (morning|afternoon|evening|night|day)|안녕하세요|안녕|감사합니다|감사해요|고맙습니다|고마워요|넵|네|알겠습니다|ありがとうございます|ありがとう|こんにちは|よろしくお願いします|谢谢|谢谢你|你好|好的)[\s!.~,]*$/i;
  return TRIVIAL.test(t);
}

// (2c) 백로그 질문 → CS-DB 시트 말단 적재 (D, 수동 실행). 클라라가 clara_reply 열만 채우면 importCorpusFromSheet가 흡수.
//   - cs/drafts 전체(dismissed 포함)에서 게스트 질문(origMsg) 추출.
//   - 단순 인사·감사 제외, 중복은 대표 1개(정규화 일치). 멱등: 기존 시트 B열(guest_message) 정규화값을 seen에 시드 → 재실행/기존 코퍼스 중복 방지.
//   - 기존 행 무접촉(수정·삭제·삽입 금지). 마지막 데이터행 아래에 [A=lang, B=질문, C=빈칸, D=category] 블록만 추가.
//   - urlfetch: cs/drafts 조회 1회(수동 함수 → 쿨다운 무시). Gmail 미사용.
function exportBacklogQuestionsToSheet() {
  var drafts = fbGet('cs/drafts');
  if (!drafts) { Logger.log('cs/drafts 없음 — 적재할 질문 없음'); return; }
  var ss = SpreadsheetApp.openById(CS_DB_SHEET_ID);
  var sheet = ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  // 헤더 검증(임포트와 동일 기대) — 불일치 시 중단(엉뚱한 열 오염 방지)
  var EXPECT = ['lang', 'guest_message', 'clara_reply', 'category'];
  var header = (values[0] || []).map(function (h) { return String(h).trim(); });
  for (var c = 0; c < EXPECT.length; c++) {
    if (header[c] !== EXPECT[c]) { Logger.log('헤더 불일치 — 적재 중단. [' + header.join(' | ') + ']'); return; }
  }
  // seen: 기존 B열(질문) 정규화값 → 중복·기존 코퍼스 재적재 방지(멱등)
  var seen = {};
  for (var r = 1; r < values.length; r++) { var q0 = normQ_(values[r][1]); if (q0) seen[q0] = true; }

  var ids = Object.keys(drafts), rows = [], appended = 0, dup = 0, trivial = 0, noText = 0;
  for (var i = 0; i < ids.length; i++) {
    var d = drafts[ids[i]]; if (!d) continue;
    var q = String(d.origMsg || '').trim();
    if (!q) { noText++; continue; }
    if (isTrivialMessage_(q)) { trivial++; continue; }
    var key = normQ_(q);
    if (!key || seen[key]) { dup++; continue; }
    seen[key] = true;
    rows.push([ d.lang || guessLang_(q), q, '', d.category || '' ]); // C(clara_reply)는 빈칸 — 클라라가 채움
    appended++;
  }
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows); // 말단 블록 추가(기존 행 무접촉)
  }
  Logger.log('백로그 질문 시트 적재: +' + appended + '건 (중복 ' + dup + ' · 인사/단순 ' + trivial + ' · 원문없음 ' + noText + ' 스킵). clara_reply 채운 뒤 importCorpusFromSheet 실행.');
}

// (1b) Gmail 마이닝 → cs/corpus (게스트 메시지 ↔ 클라라 회신 쌍)
// 재개 가능한 배치 마이닝 (Clara 수동 실행, 트리거 없음).
//   1회 최대 CS_MINE_BATCH(기본 25)스레드. 커서 CS_MINE_CURSOR에 진행 위치 저장 → 재실행 시 이어서.
//   전량 완료 시 커서 제거 + "MINING COMPLETE" 로그. 예산 소진 시 진행분까지 커서 저장 후 중단.
//   모든 Gmail 호출은 예산 게이트 경유.
function mineCorpusFromGmail() {
  var p = PropertiesService.getScriptProperties();
  var batch = parseInt(p.getProperty('CS_MINE_BATCH') || '25', 10);
  var cursor = parseInt(p.getProperty('CS_MINE_CURSOR') || '0', 10);
  var me = Session.getActiveUser().getEmail();

  var threads = gmSearch_('from:guest.booking.com', cursor, batch);
  if (_gmailStop) { Logger.log('⛔ 예산 소진 — 마이닝 미진행. cursor=' + cursor + ' 유지.'); mirrorBudget_(); return; }
  if (!threads.length) { p.deleteProperty('CS_MINE_CURSOR'); Logger.log('MINING COMPLETE — 더 없음(시작 cursor=' + cursor + '). cursor 제거.'); mirrorBudget_(); return; }

  var processed = 0, made = 0;
  for (var t = 0; t < threads.length && !_gmailStop; t++) {
    var msgs = gmGetMessages_(threads[t]);
    if (_gmailStop) break;
    var pendingGuest = null;
    for (var m = 0; m < msgs.length; m++) {
      var from = msgs[m].getFrom();
      if (/@guest\.booking\.com/i.test(from)) {
        var raw = { from: from, subject: msgs[m].getSubject(), body: msgs[m].getPlainBody() };
        var pp = parseBooking_(raw);
        pendingGuest = { id: msgs[m].getId(), msg: (pp.message || raw.body || '').trim(), lang: pp.lang };
      } else if (me && from.indexOf(me) >= 0 && pendingGuest) {
        var reply = stripQuoted_(msgs[m].getPlainBody());
        if (reply && !fbGet('cs/corpus/' + pendingGuest.id)) {
          fbSet('cs/corpus/' + pendingGuest.id, {
            '상황요약': pendingGuest.msg, '최종답변': reply,
            lang: pendingGuest.lang || guessLang_(pendingGuest.msg), origin: '구축', src: 'gmail'
          });
          made++;
        }
        pendingGuest = null; // 쌍 소비
      }
    }
    processed++;
  }

  var out = miningOutcome_(cursor, processed, threads.length, batch, _gmailStop);
  if (out.cursor === null) p.deleteProperty('CS_MINE_CURSOR');
  else p.setProperty('CS_MINE_CURSOR', String(out.cursor));
  if (out.complete)      Logger.log('MINING COMPLETE — 이번 ' + processed + '건 처리, corpus +' + made + '. 전량 완료(cursor 제거).');
  else if (out.partial)  Logger.log('⛔ 예산 소진 — 부분 처리 ' + processed + '건, corpus +' + made + ', cursor=' + out.cursor + ' (다음 실행 시 이어서).');
  else                   Logger.log('마이닝 배치: ' + processed + '건 처리, corpus +' + made + ', cursor=' + out.cursor + ' (재실행으로 계속).');
  mirrorBudget_(); // run 종료 시 예산 사용량 미러링
}

// 순수(테스트용): 마이닝 커서/완료 판정. 반환 {cursor: 새 커서 or null(완료), complete, partial}
function miningOutcome_(cursor, processed, threadsLen, batch, stopped) {
  var next = cursor + processed;
  if (stopped) return { cursor: next, complete: false, partial: true };
  if (threadsLen < batch) return { cursor: null, complete: true, partial: false }; // 마지막 배치 처리 완료
  return { cursor: next, complete: false, partial: false };
}

// 회신 본문에서 인용/원문 꼬리 제거 (클라라가 "##-" 마커 위에 입력)
function stripQuoted_(body) {
  if (!body) return '';
  var lines = body.split('\n'), out = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^>/.test(ln)) break;
    if (/wrote:\s*$/.test(ln)) break;
    if (ln.indexOf('##-') >= 0) break;
    if (/^-----/.test(ln)) break;
    if (/^________/.test(ln)) break;
    if (/^On .*(202\d|오후|오전).*$/.test(ln)) break;
    out.push(ln);
  }
  return out.join('\n').trim();
}
