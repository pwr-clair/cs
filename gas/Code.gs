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

// ── 7월 학습모드 스위치(Q3) : cs/config/learnMode (Firebase, 기본 ON) ──
//   ON  = 실발송·autoSend 비활성(잠금, 삭제 아님) + 승인분을 CS-DB 시트에 학습저장.
//   OFF = 8월 실발송 복귀(sendApprovedDrafts/autoApprovePass 정상 동작).
//   DESK도 같은 노드를 읽어 버튼·상태·탭 라벨을 전환. 노드 부재 시 안전상 ON(발송 금지) 취급.
//   run-local 캐시(_learnModeCache) — 한 트리거 실행 내 fbGet 1회로 제한.
var _learnModeCache = null;
function learnModeOn_() {
  if (_learnModeCache !== null) return _learnModeCache;
  var v = fbGet('cs/config/learnMode');
  _learnModeCache = (v === null || v === undefined) ? true : (v === true);
  return _learnModeCache;
}

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
// 부작용 없는 예산 엿보기 — 카운트 누적 없음(실제 카운트는 발송 시 budgetGate_('reply')가 담당).
// sendApprovedDrafts가 초안을 sending으로 잠그기 전에 호출: 소진이면 approved 유지 → 다음 run/날 재시도.
function gmailAllowed_(n) {
  var p = PropertiesService.getScriptProperties();
  var budget = parseInt(p.getProperty('CS_GMAIL_BUDGET') || '150', 10);
  var used = parseInt(p.getProperty(gmailUsedKey_()) || '0', 10);
  return budgetAllows_(used, budget, n);
}
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
function mirrorBudget_(scanned) {
  var p = PropertiesService.getScriptProperties();
  var date = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var snap = budgetSnapshot_(p.getProperty('CS_GMAIL_USED_' + date), p.getProperty('CS_GMAIL_BUDGET'), date,
                             p.getProperty(fetchUsedKey_()));
  // 하트비트(07-15 승인, 07-20 탑재): 기존 fbSet 1회에 필드만 얹음 — 추가 urlfetch 0, 아이들 run 미접촉.
  snap.hbAt = new Date().toISOString();
  if (scanned != null) snap.hbScanned = scanned;
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
  if (learnModeOn_()) return; // 학습모드: 자동 승인 비활성 — 수동 승인만이 학습신호(자가흉내 저장 방지)
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
  if (learnModeOn_()) return; // 학습모드(7월): 실발송 비활성 — saveApprovedToSheet_ 가 대신 시트 저장(삭제 아님, 8월 복귀)
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
    var finalReply = resolveGuestFinal_(fresh) || fresh.finalReply || fresh.reply || ''; // 클라라 편집(한국어)→게스트 언어 발송본(무료)
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
        lang: lang, category: d.category || null, stage: d.stayStage || null, ts: new Date().toISOString()
      });
    } else {
      fbSet('cs/corpus/' + id, {
        '상황요약': orig, '최종답변': finalReply, lang: lang, category: d.category || null,
        stage: d.stayStage || null, origin: 'approved' // stage(#2): 동단계 예시 검색 가중용
      });
    }
  } catch (e) { Logger.log('learn 실패 ' + id + ': ' + e); }
}

// ══════════════════════════════════════════════════════════════════
// 학습모드 저장 워커(Q2) — approved 초안을 CS-DB 시트에 append (게스트 발송 없음)
//   ▣ 배치: pollCsInbox 에서 urlfetch 쿨다운 게이트 '앞'에서 호출(발송 멈춤과 무관하게 저장 진행).
//   ▣ 비용: cs/drafts 소수 읽기(urlfetch) + 시트 native 쓰기(쿼터 무관). 하드 소진이면 첫 fbGet에서
//      예외 → 호출부 catch 가 "하드 소진 가능" 로그(자기노출). 그 외(자체 60분 타이머)엔 정상 저장.
//   ▣ 시트 열: A=lang B=guest_message C=clara_reply D=category E=clara_self_score(자기평가).
//      importCorpusFromSheet/exportBacklogQuestionsToSheet 는 0~3열만 검증 → E열 추가 안전.
//   ▣ 중복 가드: draft.savedToSheet 플래그(재승인·재실행 재저장 방지). 저장 성공 시 status='saved'.
// ══════════════════════════════════════════════════════════════════
function ensureSelfScoreHeader_(sheet) {
  var h = sheet.getRange(1, 5).getValue();
  if (String(h).trim() !== 'clara_self_score') sheet.getRange(1, 5).setValue('clara_self_score');
}
// ── 편집 기준 언어(A안) → 게스트 언어 발송본 (무료 LanguageApp, Claude 미사용) ──
//   클라라는 비영어권=한국어(replyKo), 영어권=영어(reply)로 편집(claraFinal/claraFinalLang).
//   발송본: 게스트 언어==편집 언어면 그대로 / 미편집이면 Claude 원문(reply, 이미 게스트 언어) /
//           편집됐고 언어 다르면 LanguageApp 번역. 타깃 코드 불명(guessLang_의 'eu' 등)이면 원문 폴백.
function langToIso_(l) { return /^(en|ko|ja|zh|ru|th)$/.test(String(l||'').toLowerCase()) ? String(l).toLowerCase() : null; }
// 단축 치환(2026-07-20 클라라): 편집본/초안의 {가이드}·{guide} → 가이드 URL. 번역 전·후 모두 통과하도록
// resolveGuestFinal_ 의 모든 출구에서 적용(번역기가 {가이드}→{Guide}로 바꿔도 잡힘).
function subShortcuts_(s) { return String(s == null ? '' : s).replace(/\{\s*(가이드|guide)\s*\}/gi, 'https://pwr-guide.online'); }
function resolveGuestFinal_(d) {
  var editLang = d.claraFinalLang || (String(d.lang||'').toLowerCase() === 'en' ? 'en' : 'ko');
  var claraFinal = subShortcuts_(String(d.claraFinal || d.finalReply || d.replyKo || d.reply || '')); // 번역 전 치환
  var guestLang = String(d.lang || 'en').toLowerCase();
  if (guestLang === editLang) return claraFinal;          // ko게스트+ko편집 / en게스트+en편집 → 그대로
  if (!d.editedByClara) return subShortcuts_(d.reply || claraFinal); // 미편집 → Claude 원문(이미 게스트 언어, 번역 불필요)
  var iso = langToIso_(guestLang);
  var target = iso || 'en';                                // (4) 타깃 코드 불명(eu 등) → 영어로 발송(원문 폴백 아님)
  if (target === editLang) return claraFinal;              // 영어권+영어편집 등
  try { return subShortcuts_(LanguageApp.translate(claraFinal, editLang, target)); } // 무료 번역(불명이면 en) — 번역 후 재치환
  catch (e) { Logger.log('LanguageApp 번역 실패(' + editLang + '→' + target + '): ' + e); return subShortcuts_(d.reply || claraFinal); }
}

function saveApprovedToSheet_() {
  if (!learnModeOn_()) return;               // 실발송 모드(8월)면 저장 워커 비활성
  // 스크립트 락: 즉시저장(doPost)과 5분 폴링(pollCsInbox)이 동시에 돌아도 이중 append 방지.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (le) { Logger.log('save 락 획득 실패 — skip(다른 실행이 저장 중)'); return; }
  try {
    var drafts = fbGet('cs/drafts'); if (!drafts) return; // 하드 소진이면 여기서 throw → 호출부 catch
    var ids = Object.keys(drafts), targets = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], d = drafts[id];
      if (!d || d.status !== 'approved') continue; // 승인 대기분만
      if (d.savedToSheet) continue;                // 이미 저장(멱등)
      targets.push([id, d]);
    }
    if (!targets.length) return;

    var rows = [];
    for (var k = 0; k < targets.length; k++) {
      var dd = targets[k][1];
      var q = String(dd.origMsg || '').trim();
      // 코퍼스 clara_reply = 클라라가 확정한 편집본(비영어권=한국어, 영어권=영어) — 기계번역 아닌 클라라 원문.
      var claraFinal = String(dd.claraFinal || dd.finalReply || dd.replyKo || dd.reply || '').trim();
      var lang = dd.lang || guessLang_(claraFinal || q); // 상황(게스트) 언어 — 검색용
      var cat = dd.category || '';
      var score = (dd.claraToneScore != null && dd.claraToneScore !== 0) ? dd.claraToneScore : ''; // 미평가는 빈칸
      rows.push([lang, q, claraFinal, cat, score]);
    }

    var now = new Date().toISOString(), startRow = 0;
    try {
      var ss = SpreadsheetApp.openById(CS_DB_SHEET_ID);
      var sheet = ss.getSheets()[0];
      ensureSelfScoreHeader_(sheet);
      startRow = sheet.getLastRow() + 1;                    // 이 배치의 첫 행(재편집 갱신용 sheetRow 기록)
      sheet.getRange(startRow, 1, rows.length, 5).setValues(rows); // native 쓰기(쿼터 무관)
    } catch (se) {
      // 시트 쓰기 실패(권한·시트 오류 등) → status 'approved' 유지 + saveError 마킹.
      // DESK가 '저장 실패 · 재시도' 표시 → 무한 '저장 대기중' 방지.
      var epatch = {};
      for (var e2 = 0; e2 < targets.length; e2++) {
        epatch[targets[e2][0] + '/saveError'] = String(se).slice(0, 180);
        epatch[targets[e2][0] + '/saveErrorAt'] = now;
      }
      try { fbUpdate('cs/drafts', epatch); } catch (fe) { Logger.log('saveError 마킹 실패: ' + fe); }
      Logger.log('⛔ 학습 시트 저장 실패: ' + se);
      return;
    }

    // 성공 → saved 마킹 + saveError 클리어 + 게스트 언어 발송본(무료 번역) 보관.
    var patch = {};
    for (var m = 0; m < targets.length; m++) {
      var sid = targets[m][0], dm = targets[m][1];
      var editLang = dm.claraFinalLang || (String(dm.lang||'').toLowerCase() === 'en' ? 'en' : 'ko');
      patch[sid + '/status'] = 'saved';
      patch[sid + '/savedToSheet'] = true;
      patch[sid + '/savedAt'] = now;
      patch[sid + '/saveError'] = null;
      patch[sid + '/finalReply'] = resolveGuestFinal_(dm);   // 게스트 언어 발송본(발송 대비)
      patch[sid + '/finalReplyKo'] = (editLang === 'ko') ? (dm.claraFinal || dm.replyKo || null) : (dm.replyKo || null); // 한국어 표시본
      patch[sid + '/sheetRow'] = startRow + m;               // (2) 재편집 시 이 행을 갱신(새 행 추가 아님)
    }
    fbUpdate('cs/drafts', patch);
    Logger.log('학습 저장: ' + rows.length + '건 시트 append(row ' + startRow + '~) + status=saved');
  } finally { lock.releaseLock(); }
}

// (2) 학습됨 재편집 정정: pendingCorrection & sheetRow 있는 저장분 → 해당 시트 '행을 갱신'(새 행 아님).
//   7월 학습기간만(learnModeOn_). 코퍼스 중복 방지 = 같은 행 in-place 갱신 → importCorpusFromSheet 재실행 시 같은 sheet_r 키로 흡수.
function correctSavedRows_() {
  if (!learnModeOn_()) return;                              // 8월 실발송 전환 시 재편집 비활성
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (le) { Logger.log('정정 락 실패 — skip'); return; }
  try {
    var drafts = fbGet('cs/drafts'); if (!drafts) return;
    var ids = Object.keys(drafts), targets = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], d = drafts[id];
      if (!d || d.status !== 'saved' || !d.pendingCorrection || !d.sheetRow) continue;
      targets.push([id, d]);
    }
    if (!targets.length) return;
    var ss = SpreadsheetApp.openById(CS_DB_SHEET_ID);
    var sheet = ss.getSheets()[0];
    var now = new Date().toISOString(), patch = {}, n = 0;
    for (var k = 0; k < targets.length; k++) {
      var sid = targets[k][0], dm = targets[k][1];
      var q = String(dm.origMsg || '').trim();
      var claraFinal = String(dm.claraFinal || dm.replyKo || dm.reply || '').trim();
      var lang = dm.lang || guessLang_(claraFinal || q);
      var cat = dm.category || '';
      var score = (dm.claraToneScore != null && dm.claraToneScore !== 0) ? dm.claraToneScore : '';
      try {
        sheet.getRange(dm.sheetRow, 1, 1, 5).setValues([[lang, q, claraFinal, cat, score]]); // 같은 행 갱신
      } catch (se) {
        patch[sid + '/saveError'] = String(se).slice(0, 180); patch[sid + '/saveErrorAt'] = now; continue;
      }
      var editLang = dm.claraFinalLang || (String(dm.lang||'').toLowerCase() === 'en' ? 'en' : 'ko');
      patch[sid + '/finalReply'] = resolveGuestFinal_(dm);
      patch[sid + '/finalReplyKo'] = (editLang === 'ko') ? (dm.claraFinal || dm.replyKo || null) : (dm.replyKo || null);
      patch[sid + '/pendingCorrection'] = null;
      patch[sid + '/savedAt'] = now;
      patch[sid + '/saveError'] = null;
      n++;
    }
    if (Object.keys(patch).length) fbUpdate('cs/drafts', patch);
    Logger.log('학습 정정: ' + n + '건 행 갱신(새 행 추가 없음)');
  } finally { lock.releaseLock(); }
}

// ── 승인 즉시저장 웹앱 엔드포인트(doPost) ─────────────────────────────
//   DESK 승인 → 이 URL로 POST → saveApprovedToSheet_ 즉시 실행(5분 폴링 대기 없음).
//   결과는 Firebase(status=saved / saveError)로 반영되므로 응답 본문은 무의미(no-cors 사용).
//   보안: 처리 대상은 '이미 승인된(approved) draft'뿐 — 게스트 발송 없음·멱등·락 보호. 시크릿 불필요(레포에 시크릿 금지).
//   배포(Clara 1회): 배포 → 새 배포 → 웹앱 / 실행=본인(paradisewalkresidence) / 액세스=모든 사용자 → 배포 후 publishSaveHookUrl 실행.
function doPost(e) {
  try { processManualQueue_(); saveApprovedToSheet_(); correctSavedRows_(); return ContentService.createTextOutput('ok'); }
  catch (err) { Logger.log('doPost 처리 실패: ' + err); return ContentService.createTextOutput('err:' + err); }
}
function doGet(e) { // 브라우저 수동 점검용(같은 동작)
  try { processManualQueue_(); saveApprovedToSheet_(); correctSavedRows_(); return ContentService.createTextOutput('ok(get)'); }
  catch (err) { return ContentService.createTextOutput('err:' + err); }
}
// 배포 후 1회 실행: 현재 웹앱 배포 URL을 cs/config/saveHookUrl 에 등록 → DESK가 자동으로 읽어 즉시저장 호출.
// (가드 2026-07-14) /dev(테스트 배포) URL은 익명 호출이 거부돼 즉시경로가 죽으므로 등록을 거부한다 — 07-13 사고 재발 방지.
function publishSaveHookUrl() {
  var url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log('웹앱 미배포 — 먼저 [배포]로 웹앱 배포 후 실행'); return; }
  if (url.indexOf('/dev') >= 0 || url.indexOf('/exec') < 0) {
    Logger.log('⚠ 현재 URL이 /dev(테스트 배포) — 등록 중단(등록해도 즉시경로 안 삶).');
    Logger.log('해결: [배포]→[새 배포]→유형 웹 앱(실행=나, 액세스=모든 사용자)→배포 → 이 함수 재실행.');
    Logger.log('그래도 /dev면: [배포]→[배포 관리]에서 웹 앱 /exec URL 복사 → 스크립트 속성 SAVE_HOOK_URL에 저장 → publishSaveHookUrlFromProp 실행.');
    return;
  }
  fbSet('cs/config/saveHookUrl', url);
  Logger.log('saveHookUrl 등록 완료: ' + url);
}
// (수동 폴백) getUrl()이 /dev만 돌려주는 환경용: 스크립트 속성 SAVE_HOOK_URL에 /exec URL을 넣고 이 함수 실행.
function publishSaveHookUrlFromProp() {
  var url = String(PropertiesService.getScriptProperties().getProperty('SAVE_HOOK_URL') || '').trim();
  if (url.indexOf('https://') !== 0 || url.indexOf('/exec') < 0) {
    Logger.log('스크립트 속성 SAVE_HOOK_URL에 /exec로 끝나는 웹앱 URL을 먼저 저장하세요. 현재값: ' + (url || '(없음)'));
    return;
  }
  fbSet('cs/config/saveHookUrl', url);
  Logger.log('saveHookUrl 수동 등록 완료: ' + url);
}

// ---- 트리거 설치 (Clara 수동 실행 전용 — 자동 설치 금지) ----
// 이 프로젝트(PWR-CS-Engine)의 기존 트리거 전부 삭제 후 pollCsInbox 1분 주기 1개만 설치.
// (A안 2026-07-14: 5분→1분. 아이들 run은 Gmail 2회로 즉시 종료라 안전 — pollCsInbox 상단 주석 참조)
function installCsTriggers() {
  var trg = ScriptApp.getProjectTriggers(); // 이 프로젝트 한정 — HK와 무관
  var removed = 0;
  for (var i = 0; i < trg.length; i++) { ScriptApp.deleteTrigger(trg[i]); removed++; }
  ScriptApp.newTrigger('pollCsInbox').timeBased().everyMinutes(1).create();
  Logger.log('CS 트리거 재설치: 기존 ' + removed + '개 삭제 → pollCsInbox 1분 주기 1개 설치 (A안)');
}

// (진단) 즉시경로 점검 — diagImmediatePath()
//   ①웹앱 배포 URL vs 등록된 saveHookUrl 일치 여부 ②최근 즉석 생성 요청 10건의 상태·소요·에러를 로그로.
//   실행: 함수 diagImmediatePath 선택 → 실행 → 로그 복사. urlfetch 2회(읽기), Claude 0회.
function diagImmediatePath() {
  var deployed = ScriptApp.getService().getUrl() || '(미배포)';
  var hook = fbGet('cs/config/saveHookUrl') || '(미등록)';
  Logger.log('웹앱 배포 URL : ' + deployed);
  Logger.log('등록 saveHookUrl: ' + hook);
  Logger.log(deployed === hook ? '→ 일치 (정상)' : '→ ⚠ 불일치! publishSaveHookUrl 재실행 필요');
  if (String(hook).indexOf('/dev') >= 0) Logger.log('→ ⚠ /dev URL — 익명 호출 거부됨. 웹앱 새 버전(/exec) 배포 후 publishSaveHookUrl 재실행');
  if (String(hook).indexOf('/exec') < 0 && hook !== '(미등록)') Logger.log('→ ⚠ /exec로 끝나지 않음 — 등록값 확인 필요');
  var q = fbGet('cs/manualQueue') || {};
  var ids = Object.keys(q).sort().slice(-10);
  Logger.log('--- 최근 즉석 생성 요청 ' + ids.length + '건 (오래된 순) ---');
  for (var i = 0; i < ids.length; i++) {
    var v = q[ids[i]] || {};
    var lag = (v.createdAt && v.doneAt) ? (' | 소요 ' + Math.round((Date.parse(v.doneAt) - Date.parse(v.createdAt)) / 1000) + 's') : '';
    Logger.log(ids[i] + ' | ' + (v.status || '?') + ' | 요청 ' + (v.createdAt || '?') + lag + (v.error ? ' | 에러: ' + v.error : ''));
  }
  Logger.log('판독: 소요 5~40s=즉시경로 정상 / 소요 수 분=폴링 폴백만 동작(URL·액세스 문제) / pending 방치=doPost 미도달 / error=원인 그대로.');
}

function safeDrafts_() { try { processInboxToDrafts(); } catch (e) { Logger.log('draft 파이프라인 실패: ' + e); } }

function pollCsInbox() {
  // (A안 2026-07-14) 1분 트리거 + 저비용 아이들 run:
  //   매 1분 = Gmail 라벨만 선체크(읽기 2회, urlfetch 0회). 새 메일 없으면 그 자리에서 종료.
  //   5분 슬롯(분%5==0) = 기존 풀 사이클(저장·정정·즉석큐 백업·자동승인·발송·예산 미러) 그대로.
  //   → 메일→데스크 우리 몫 지연: 평균 2.5분→약 30초, 최악 5분→약 1분. urlfetch 총량 불변.
  //   ⚠ Gmail 읽기 카운트 ~3천/일로 증가 — 스크립트 속성 CS_GMAIL_BUDGET 8000 권장(실쿼터 2만/일 대비 안전).
  var fullRun = (new Date().getMinutes() % 5 === 0);
  var label = gmGetLabel_(CS_LABEL);
  var pendingThreads = (label && !_gmailStop) ? gmGetThreads_(label, 0, 20) : [];
  if (!fullRun && !pendingThreads.length) return; // 아이들 1분 run 종료(Gmail 2회뿐, fb/Claude 미접촉)

  // (Q2) 학습모드 저장 워커 — 쿨다운 게이트 '앞'에서 먼저 실행 (풀 사이클에서만 — 주 경로는 doPost 즉시).
  //   쿨다운은 '비싼 초안 대량생성' 방어용 자체 타이머라, 저비용(소수 읽기+시트 native)인 저장까지
  //   막을 이유가 없음. 실제 하드 소진이면 saveApprovedToSheet_ 첫 fbGet 에서 예외 → 여기서 catch(자기노출).
  if (fullRun) {
    try { saveApprovedToSheet_(); } catch (e) { Logger.log('학습 저장 워커 실패(=urlfetch 하드 소진 가능): ' + e); }
    try { correctSavedRows_(); } catch (e) { Logger.log('학습 정정 워커 실패: ' + e); } // (2) 재편집 행 갱신(백업 경로)
  }

  if (urlfetchCooldownActive_()) return; // urlfetch 쿨다운 중: 이하 초안 대량생성·발송은 skip. 만료 시 내부에서 해제 후 진행.
  if (_gmailStop) { if (fullRun) safeDrafts_(); return; }
  if (!label) { Logger.log('라벨 없음: ' + CS_LABEL + ' — §6f 필터 확인'); if (fullRun) safeDrafts_(); return; }

  var doneLabel = gmGetLabel_(CS_DONE_LABEL) || gmCreateLabel_(CS_DONE_LABEL);
  if (_gmailStop || !doneLabel) { if (fullRun) safeDrafts_(); return; }

  // 저연비: 처리 완료 스레드는 CS_LABEL에서 제거(라벨 이동)하므로 매 run 미처리분만 조회됨.
  // (멱등 이중 안전판: ingestMessage_ 의 fbGet 존재체크가 재적재 방지)
  // 백로그 컷오프(B): CS_CUTOFF 이전 스레드는 초안·적재 건너뛰고 라벨만 이동(urlfetch 미사용).
  var cutoffMs = cutoffMs_(PropertiesService.getScriptProperties().getProperty('CS_CUTOFF'));
  var cutoffSkipped = 0;
  var threads = pendingThreads; // 위 선체크에서 이미 조회(Gmail 재호출 없음)
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

  if (fullRun) {
    // 즉석 답변 생성기 백업 경로(주 경로는 doPost 즉시). Claude 사용 → 게이트 이후.
    try { processManualQueue_(); } catch (e) { Logger.log('즉석 생성 큐 실패: ' + e); }
    // 제안 반영 워커: 승인된 제안(eta 등)을 HK에 반영 (§3 예외 경로, urlfetch 소량)
    try { applySuggestions_(); } catch (e) { Logger.log('제안 반영 워커 실패: ' + e); }
    // 후기 탭 워커: ①체크아웃 익일 후보 선별(하루 1회) ②승인분 후기 요청 초안 생성(Claude 1회/건)
    try { reviewQueueWorker_(); } catch (e) { Logger.log('후기 선별 워커 실패: ' + e); }
    try { reviewDraftWorker_(); } catch (e) { Logger.log('후기 초안 워커 실패: ' + e); }
  }
  // 초안 생성은 Gmail 미사용 → 예산과 무관하게 항상 진행 (수신과 분리)
  //   1분 run이라도 새 메일을 적재한 경우 여기 도달 → 바로 초안 생성(A안의 핵심: 1분 내 데스크 표시)
  safeDrafts_();
  if (fullRun) {
    // autoSend: ON & confidence>=0.8 → 자동 승인 (Firebase만, Gmail 미사용)
    try { autoApprovePass_(); } catch (e) { Logger.log('autoApprove 실패: ' + e); }
    // 발송 워커: approved → 원 스레드 reply + 학습 (예산 가드). 발송 실패가 위 단계를 막지 않음.
    try { sendApprovedDrafts(); } catch (e) { Logger.log('발송 워커 실패: ' + e); }
  }
  mirrorBudget_(pendingThreads.length); // run 종료 시 예산 사용량 미러링 (fetchUsed·하트비트 포함)
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
    extractFailed: parsed.extractFailed || false, // 아고다 "메시지:" 라벨 못 찾음(껍데기 미적재) — 초안 스킵
    notice: parsed.notice || false,          // 부킹 알림류(요청/취소) — 초안 없이 데스크 알림 카드(2026-07-14)
    eta: parsed.eta || null,                 // 알림에서 정형 추출된 도착예정 — 제안 탭 연료
    etaEvidence: parsed.etaEvidence || null, // 근거 문장(제안 카드 인용 표시)
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
  // 부킹 알림류(2026-07-14 B1-1 확정): 게스트 요청 확정/거절/대기(noreply@) + 취소요청(property.) —
  //   대화는 아니지만 조치가 필요한 메일. no-reply@agoda.com(예약 이벤트)은 클라라 지시로 제외.
  if (f.indexOf('noreply@booking.com') >= 0 || f.indexOf('@property.booking.com') >= 0) return 'booking_notice';
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
  var out = channel === 'booking_notice' ? parseBookingNotice_(raw)
          : channel === 'booking' ? parseBookingCh_(raw)
          : channel === 'agoda'   ? parseAgoda_(raw)
          :                         parseExpedia_(raw);
  out.channel = channel; out.source = (channel === 'booking_notice') ? 'booking' : channel;
  // 공통 이력 오염 방지: 종료마커 실패(rawTail)면 message를 앞 1000자로 제한
  if (out.rawTail && out.message && out.message.length > 1000) out.message = out.message.slice(0, 1000);
  return out;
}

// 1b) 부킹 알림류(요청 확정/거절/대기·취소요청) — 게스트 대화가 아닌 '조치 알림'.
//   초안 생성 없음(notice=true → processInboxToDrafts에서 경량 카드만), 이메일 회신 불가(emailReply=false).
//   조치는 익스트라넷에서. ETA 등 요청 내용이 실려 오는 통로라 데스크 가시화가 목적.
function parseBookingNotice_(raw) {
  var out = newParse_();
  out.ok = true; out.notice = true; out.emailReply = false;
  var subj = String(raw.subject || '').trim();
  var m = subj.match(/^(.+?)[’']s\s+request/i);            // "JIE MA's request ..." → 게스트명
  if (m) out.guest = m[1].trim();
  var b = String(raw.body || '');
  var conf = b.match(/Confirmation number:?\s*(\d{6,})/i);       // "Confirmation number: 6898654837"
  var bid = conf ? conf[1] : (b.match(/\b(\d{10})\b/) || [])[1]; // 폴백: 부킹 원번호(10자리)
  if (bid) out.bookingId = bid;
  // 예약 상세 날짜: "Check-in: Tue 21 Jul 2026" (요일 유무 모두 대응)
  var ci = b.match(/Check-?in:?\s*(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/i);
  if (ci) out.checkinDate = engDate_(ci[1], ci[2], ci[3]);
  var co = b.match(/Check-?out:?\s*(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/i);
  if (co) out.checkoutDate = engDate_(co[1], co[2], co[3]);
  // ETA 요청 정형 추출: "request check-in at 19:00 - 20:00" → 제안 탭 연료 (2026-07-14)
  var eta = b.match(/request\s+check-?in\s+(?:time\s+)?at\s+(\d{1,2}:\d{2})(?:\s*[-–~]\s*(\d{1,2}:\d{2}))?/i);
  if (eta) {
    out.eta = eta[1] + (eta[2] ? '-' + eta[2] : '');
    var pos = b.indexOf(eta[0]);
    out.etaEvidence = b.slice(Math.max(0, pos - 40), pos + eta[0].length + 60).replace(/\s+/g, ' ').trim();
  }
  out.lang = 'en';
  var snippet = b.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  out.message = '[부킹 알림] ' + subj + (snippet ? '\n' + snippet : '');
  return out;
}
// 영문 날짜(21, Jul, 2026) → 'YYYY-MM-DD'. 월 약칭 미인식 시 null.
function engDate_(d, mon, y) {
  var M = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
            jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' }[String(mon).slice(0, 3).toLowerCase()];
  if (!M) return null;
  return y + '-' + M + '-' + (String(d).length < 2 ? '0' + d : d);
}

// 종료마커: 게스트 메시지 뒤에 오는 booking 알림 고정 문자열(레거시·신형 공통).
function isBookingEndMarker_(t) {
  return t === '답변' || t === 'Reply' || t.indexOf('-->') === 0
      || t.indexOf('예약 상세 정보') === 0 || t.indexOf('Reservation details') === 0
      || t.indexOf('© Copyright') === 0;
}
// 상단 헤더 라인(신형: 시작마커 없이 본문 상단에 섞이는 것 — 관측된 것만): 이미지 alt·순수 URL/트래킹·제목/게스트명 반복.
function isBookingHeaderLine_(t, subject, guest) {
  if (/^\[image:/i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (subject && t === String(subject).trim()) return true;
  if (guest && t === guest) return true;
  return false;
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

  // 메시지 추출:
  //  (1) 레거시(참고 3건): "{name} said:"(EN)/"님의 메시지:"(KO) 시작마커 다음 ~ 첫 종료마커 전까지.
  //  (2) 신형(paradisewalkresidence 계정 실물, 시작마커 없음): 상단 헤더 스킵 후 첫 실질 라인 ~ 첫 종료마커 전까지.
  //  (3) 시작·종료 둘 다 실패한 진짜 예외만 rawTail(전체 → dispatcher에서 1000자 상한).
  var si = -1;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (/said:\s*$/i.test(t) || t.indexOf('님의 메시지:') >= 0) { si = i; break; }
  }
  if (si >= 0) {
    if (!out.guest) { var sm = lines[si].trim().match(/^(.*?)\s+said:\s*$/i); if (sm) out.guest = sm[1].trim(); }
    var msg = [];
    for (var j = si + 1; j < lines.length; j++) {
      if (isBookingEndMarker_(lines[j].trim())) break;
      msg.push(lines[j]);
    }
    out.message = msg.join('\n').trim() || null;
  } else {
    // 신형: 헤더 스킵 후 첫 실질 라인부터 첫 종료마커 직전까지.
    var picked = [], began = false, hitEnd = false;
    for (var k = 0; k < lines.length; k++) {
      var w = lines[k].trim();
      if (isBookingEndMarker_(w)) { hitEnd = began; break; }
      if (!began) { if (w === '' || isBookingHeaderLine_(w, subject, out.guest)) continue; began = true; picked.push(lines[k]); }
      else { picked.push(lines[k]); }
    }
    if (began) {
      out.message = picked.join('\n').trim() || null;
      if (!hitEnd) out.rawTail = true;   // 시작만·종료 미검출 → 안전상 상한 적용
    } else {
      out.message = body.trim() || null; out.rawTail = true; // 시작·종료 둘 다 실패 = 진짜 예외
    }
  }

  out.lang = guessLang_(out.message);
  out.ok = !!(out.bookingId && out.message);
  return out;
}

// 2) 아고다 — 한글 템플릿
// 아고다 게스트 본문 종료마커(푸터). ※ 'agoda' 단어는 게스트 본문에 자주 등장하므로 종료마커로 쓰지 말 것.
function isAgodaEndMarker_(t) {
  if (!t) return false;
  return t.indexOf('Did you know?') >= 0
      || t.indexOf('이전 메시지') >= 0
      || t.indexOf('아래 원문') >= 0
      || t.indexOf('예약 관리') >= 0
      || t.indexOf('YCS') >= 0
      || t.indexOf('© ') >= 0 || t.indexOf('©Agoda') >= 0 || t.indexOf('Copyright') >= 0
      || t.indexOf('이 이메일') >= 0
      || t.indexOf('회신하려면') >= 0
      || /^[-─—=_]{3,}$/.test(t); // 구분선
}

// 2) 아고다 — 한글 껍데기 + "메시지:" 라벨 뒤 실제 게스트 본문. (라벨 한국어 고정, 본문은 게스트 언어 무관)
//   실물 구조(확인됨): "…안녕하세요." / "…여행객에게서 온 메시지입니다." / "[새 메시지] 문의 사항 (발신: {게스트명}님)"
//                     / "예약 번호: {번호}" / "메시지: {진짜 본문}"
//   ★ 예전 버그: 라벨 앵커 없이 '첫 산문 블록'을 취해 상단 껍데기를 게스트 원문으로 오추출 → 엉뚱한 초안.
function parseAgoda_(raw) {
  var out = newParse_();
  var body = raw.body || '', subject = raw.subject || '', from = raw.from || '';
  var lines = body.split('\n');

  // 게스트명: "[새 메시지] 문의 사항 (발신: {name}님)" 우선 → 제목 "Reply from" → From 표시명
  var gh = body.match(/발신\s*[:：]?\s*([^()\n]+?)\s*님/);
  if (gh) out.guest = gh[1].trim();
  else { var mg = subject.match(/Reply from\s+(.+?)\s*\(/i);
         if (mg) out.guest = mg[1].trim();
         else { var dm = from.match(/^\s*"?([^"<]+?)"?\s*</); if (dm) out.guest = dm[1].trim(); } }

  // 예약번호: 본문 "예약 번호: {번호}" (한국어 라벨). 게스트 본문 속 영문 'booking number'와 구분됨.
  var mk = body.match(/예약\s*번호\s*[:：]\s*([0-9]{6,})/);
  out.bookingId = mk ? mk[1] : null;

  // 체크인/아웃: 제목 괄호의 날짜 범위 "Jul 11-12, 2026"
  var mr = subject.match(/\(([^)]+)\)/);
  if (mr) {
    var d = mr[1].match(/([A-Za-z]{3,})\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s*(\d{4})/);
    if (d) { var mo = monthNum_(d[1]); if (mo) { out.checkinDate = d[4] + '-' + pad2_(mo) + '-' + pad2_(d[2]); out.checkoutDate = d[4] + '-' + pad2_(mo) + '-' + pad2_(d[3]); } }
  }

  // 게스트 본문: "메시지:" 라벨 뒤부터 첫 종료마커 전까지. ("이전 메시지"는 앵커로 쓰지 않음)
  var msgIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*메시지\s*[:：]/.test(lines[i]) && !/이전\s*메시지/.test(lines[i])) { msgIdx = i; break; }
  }
  if (msgIdx >= 0) {
    var collected = [];
    var firstAfter = lines[msgIdx].replace(/^\s*메시지\s*[:：]\s*/, '');
    if (firstAfter.trim()) collected.push(firstAfter);
    for (var j = msgIdx + 1; j < lines.length && collected.length < 40; j++) {
      if (isAgodaEndMarker_(lines[j].trim())) break;
      collected.push(lines[j]);
    }
    out.message = collected.join('\n').trim() || null;
    if (out.message && out.message.length > 1500) out.message = out.message.slice(0, 1500);
  }
  // 폴백: "메시지:" 라벨 못 찾음 → 껍데기 넣지 않고 추출 실패로 표시(엉뚱한 초안 방지). rawTail(전체 덤프) 금지.
  if (!out.message) out.extractFailed = true;

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
var CLAUDE_MAXTOK  = 2048;                         // 1024 잘림→JSON 파싱 실패(07-10 Renuka 유실) 재발 방지
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
  '· 위치/셔틀: 인천공항 T1 인근 무인 셀프 체크인 레지던스. 무료 순환버스 — T1은 3층 3·12번 게이트, T2는 3층 7번 게이트에서 03번 버스(AICC행) 탑승 → Grand Hyatt Hotel 하차(T1 첫 정류장, T2 4번째) → 횡단보도 건너면 건물. 공항 복귀는 04번 버스(T1 약 5분, T2 약 25분). 배차 7~20분. 첫차/막차(2026년 7월 기준) — 03번(공항→숙소): T1 3번게이트 05:08/00:30, T1 12번게이트 05:10/00:32, T2 7번게이트 04:48/23:48. 04번(숙소→공항, 국제업무단지 정류장 승차): 05:01/23:51.\n' +
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
  '[이전 대화 맥락] 사용자 메시지에 [이 예약의 이전 대화]가 함께 오면 반드시 그 흐름을 이어서 답하세요. ' +
  '이미 안내한 내용(도착/셔틀/체크인 등)을 반복하지 말고, 게스트가 짧은 감사·확인("thanks","ok","감사합니다")만 보냈으면 도착 안내 풀세트를 다시 붙이지 말고 짧고 따뜻하게 화답하세요. 새 질문에만 새 정보로 답합니다.\n' +
  '[예약 상태] 사용자 메시지에 [예약 상태](현재 시각·숙박일·단계)가 오면 반드시 그 단계에 맞춰 답하세요. ' +
  '게스트가 이미 도착·입실했다고 알려온 경우("we have arrived", "just checked in" 등) 객실 번호·도어코드를 곧 보내주겠다는 안내를 절대 하지 마세요 — 이미 입실했다면 코드는 이미 받은 상태이며, 그때는 짧은 환영 인사와 불편 시 연락처 안내로만 답합니다. ' +
  '체크아웃 후 게스트에게 도착·체크인 안내를 붙이지 마세요.\n' +
  '[업무(태스크) 추출] 이 메시지에 나중에 사람이 처리해야 할 요청·약속(예: 특정 시각 도착 반영, 추가 침구, 얼리체크인·레이트체크아웃, 개별 준비물)이 있으면 tasks 배열에 {"text": 한국어 할 일 한 줄, "dueHint": 시점 힌트(있으면 "체크아웃 전"/"도착일" 등, 없으면 "")}로 담으세요. 처리할 것이 없거나 단순 정보 문의면 tasks는 빈 배열 [].\n' +
  '[답변 필요도] replyNeeded: 이 메시지에 답장이 필요한지 판단하세요. 반드시 이전 대화 맥락을 함께 고려합니다 — 우리가 이미 답한 내용에 대한 단순 감사·확인·수신 알림("thanks","ok","알겠습니다", 자동 통지성 정보 등)이라 답을 안 보내도 자연스러우면 false, 질문·요청이 있거나 첫 인사라 답이 예의상 필요하면 true. 맺음말·서명 조각만 별도 메시지로 온 경우("Kind Regards","Best","이름만" 등 — 직전 메시지의 끝인사가 잘려 따로 도착한 것)도 false — 용건은 직전 메시지가 담당하며 이 조각에 따로 답하면 오히려 어색합니다. 기준: 이 메시지 자체에 새 질문·요청·새 정보가 하나도 없으면 false 쪽으로 판단하세요. false일 때 replyNote에 이유를 한국어 한 줄로(예: "안내 확인 감사 인사 — 답 없어도 자연스러움", "맺음말 조각 — 용건은 직전 메시지에서 처리").\n' +
  '[게스트 감정] sentiment: 이 게스트의 현재 감정·태도를 "positive"(만족·호의적), "neutral", "negative"(불만·불편) 중 하나로.\n' +
  '[도착시간(ETA) 감지] 게스트가 자기 도착 예정 시각을 대화체로 알려온 경우에만(예: "6시쯤 도착해요", "I\'ll arrive around 6pm", "비행기가 5시에 내려요 그리고 바로 갈게요") etaTime에 24시간 "HH:MM"으로(대략적 표현은 가까운 정시로, 비행기 착륙 시각만 말했으면 착륙 시각 그대로), etaQuote에 근거가 된 게스트 문장을 원문 그대로 담으세요. 다음은 ETA가 아님 — etaTime을 null로: 체크인 규정 질문("체크인 몇 시부터죠?"), 체크아웃·퇴실 시각, 우리가 안내한 시각, "저녁에요"처럼 시각 특정 불가한 표현.\n' +
  '응답은 반드시 JSON 하나로만 출력: ' +
  '{"reply": 게스트 언어 답변, "replyKo": 한국어 대역, "category": 짧은 분류(한국어), "confidence": 0~1 숫자, "tasks": [{"text": 한국어 할 일, "dueHint": 시점힌트}], "replyNeeded": true/false, "replyNote": 한국어 한 줄(replyNeeded가 false일 때만), "sentiment": "positive"/"neutral"/"negative", "etaTime": "HH:MM" 또는 null, "etaQuote": 근거 문장 또는 null}. ' +
  'JSON 외 다른 텍스트를 출력하지 마세요.';

// ---- (2) 초안 생성 파이프라인: 신규 inbox → cs/drafts ----
function processInboxToDrafts() {
  var inbox = fbGet('cs/inbox'); if (!inbox) return;
  var drafts = fbGet('cs/drafts') || {};
  var handled = fbGet('cs/handledManual') || {}; // 즉석 처리 기록(본문 매칭 중복제거)
  var ids = Object.keys(inbox), made = 0, dup = 0;
  for (var i = 0; i < ids.length && made < DRAFT_BATCH; i++) {
    var id = ids[i], rec = inbox[id];
    if (!rec || rec.parseFailed) continue; // 파싱 실패건은 초안 생략(수동 처리)
    if (drafts[id]) continue;              // 이미 초안 있음(멱등)
    if (rec.notice) {                      // 부킹 알림류: Claude 호출 없이 처리(저비용)
      var sv = findSirvoy_(rec.bookingId); // 방·숙박일자 보강 — 방금 들어온 예약이면 아직 null일 수 있음(제안 워커가 재시도)
      var base = {
        guest: rec.guest || null, bookingId: rec.bookingId || null, channel: rec.source || 'booking',
        sirvoyId: sv ? sv.sirvoyId : null, room: sv ? sv.room : null,
        checkinDate: (sv && sv.checkinDate) || rec.checkinDate || null,
        checkoutDate: (sv && sv.checkoutDate) || rec.checkoutDate || null,
        origMsg: (rec.parsed && rec.parsed.message) || (rec.raw && rec.raw.subject) || '',
        lang: rec.lang || 'en', receivedAt: rec.receivedAt || null, createdAt: new Date().toISOString()
      };
      if (rec.eta) {
        // ETA 요청 알림 → 자동 승인 제안 (2026-07-20 클라라: 이중 승인 제거 — 제안 탭 대기 없이
        // applySuggestions_가 5분 내 HK 반영. 취소예약 가드는 반영 시점에 그대로 작동)
        fbSet('cs/suggestions/' + id, {
          type: 'eta', status: 'approved', autoApproved: true, approvedAt: new Date().toISOString(),
          eta: rec.eta, evidence: rec.etaEvidence || '',
          sourceMsgId: id, guest: base.guest, bookingId: base.bookingId, sirvoyId: base.sirvoyId,
          room: base.room, checkinDate: base.checkinDate, checkoutDate: base.checkoutDate,
          receivedAt: base.receivedAt, createdAt: base.createdAt
        });
        base.status = 'sugg'; base.origin = 'notice-eta'; // 대기 미표시 마커(멱등 가드 겸용)
        fbSet('cs/drafts/' + id, base);
      } else {
        base.status = 'notice'; base.origin = 'notice'; base.category = '요청알림';
        fbSet('cs/drafts/' + id, base);
      }
      drafts[id] = true; continue;         // made 미집계(Claude 배치 한도와 무관한 저비용 건)
    }
    var msgText = (rec.parsed && rec.parsed.message) || '';
    if (msgText && isDuplicateOfManual_(msgText, handled)) { // 즉석 처리한 것과 동일 → 대기에 안 띄움(Claude 호출 없음)
      fbSet('cs/drafts/' + id, {
        status: 'dismissed', handledManual: true, origin: 'polling-dup',
        guest: rec.guest || null, bookingId: rec.bookingId || null, channel: rec.source || null,
        origMsg: msgText, lang: rec.lang || 'en', receivedAt: rec.receivedAt || null,
        dismissedAt: new Date().toISOString(), createdAt: new Date().toISOString()
      });
      drafts[id] = true; dup++; continue;
    }
    try { makeDraftFor_(id, rec, inbox, drafts); made++; } // (1)(4) 같은 run의 inbox·drafts 맵 전달(추가 fetch 없음)
    catch (e) { Logger.log('draft 실패 ' + id + ': ' + e); }
  }
  if (made) Logger.log('drafts 생성: ' + made + '건');
  if (dup) Logger.log('즉석 처리 중복 제외: ' + dup + '건 (대기 미표시·기록 보존)');
}

// ── 본문 매칭 중복제거(b) : 정규화 + Jaccard. 오탐(다른 문의 숨김) 방지 위해 높은 임계 + 짧은 텍스트 제외. ──
function normText_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')                 // URL 제거
    .replace(/[^0-9a-z가-힣぀-ヿ一-鿿\s]/gi, ' ') // 문장부호·기호 제거(영/한/일/중 유지)
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
// text가 이미 즉석 처리된 본문과 같은지. 순수(테스트용): handled 맵을 인자로 받음.
function isDuplicateOfManual_(text, handled) {
  var norm = normText_(text);
  if (!norm || norm.length < 8) return false;        // 너무 짧으면 판정 안 함(오탐 방지 → 정상 대기)
  for (var k in handled) {
    var h = handled[k]; if (!h || !h.norm) continue;
    if (h.norm === norm) return true;                 // 완전 일치
    if (norm.length >= 20 && jaccard_(norm, h.norm) >= 0.9) return true; // 충분히 높을 때만
  }
  return false;
}

// ── 즉석 답변 생성기(수동 큐) : DESK가 cs/manualQueue에 붙여넣기 요청 → 여기서 Claude 1회 생성 → cs/drafts ──
//   doPost(즉시)·pollCsInbox(백업) 둘 다 호출. Claude urlfetch 사용(생성이라 불가피, 문의당 1회).
function processManualQueue_() {
  var q = fbGet('cs/manualQueue'); if (!q) return;
  var ids = Object.keys(q);
  for (var i = 0; i < ids.length; i++) {
    var rid = ids[i], item = q[rid];
    if (!item || item.status !== 'pending') continue;
    var text = String(item.text || '').trim();
    if (!text) { fbUpdate('cs/manualQueue/' + rid, { status: 'error', error: '빈 메시지' }); continue; }
    try {
      makeManualDraft_(rid, text);                    // Claude 1회 → cs/drafts + handledManual
      fbUpdate('cs/manualQueue/' + rid, { status: 'done', doneAt: new Date().toISOString() });
    } catch (e) {
      fbUpdate('cs/manualQueue/' + rid, { status: 'error', error: String(e).slice(0, 180) });
      Logger.log('즉석 생성 실패 ' + rid + ': ' + e);
    }
  }
}
function makeManualDraft_(rid, text) {
  var inboxLike = { parsed: { message: text }, lang: guessLang_(text), bookingId: null, guest: null,
                    source: 'manual', emailReply: false, receivedAt: new Date().toISOString(), raw: { body: text } };
  var examples = retrieveExamples_(inboxLike);
  var d = claudeDraft_(inboxLike, examples, '', stayStateBlock_(null, null, null, null)); // 기존 초안 로직 재사용, 호출 1회. 예약 미상 → 현재 시각만 제공
  var manualId = 'manual_' + rid;
  fbSet('cs/drafts/' + manualId, {
    reply: d.reply, replyKo: d.replyKo, category: d.category, confidence: d.confidence,
    status: 'pending', editedReply: null, lang: inboxLike.lang, guest: null, bookingId: null,
    channel: 'manual', origin: 'manual', origMsg: text,
    receivedAt: inboxLike.receivedAt, createdAt: new Date().toISOString(),
    model: CLAUDE_MODEL, examplesUsed: examples.length
  });
  saveTaskCandidates_(manualId, d.tasks, { room: null, bookingId: null, guest: null, lang: inboxLike.lang });
  var norm = normText_(text);                          // 중복제거 기록
  if (norm) fbSet('cs/handledManual/' + manualId, { norm: norm, ts: new Date().toISOString(), src: 'manual' });
}

// ── 후기 선별 지표: cs/guestScore/{bookingId} — 감정·메시지 수·최근성 누적(초안 생성 시마다, 추가 Claude 호출 없음) ──
function updateGuestScore_(inbox, sentiment, sirvoy) {
  var bid = inbox.bookingId; if (!bid) return; // 예약 미상(즉석 생성 등)은 집계 불가
  var key = String(bid).replace(/[.#$\[\]\/]/g, '_');
  var cur = fbGet('cs/guestScore/' + key) || {};
  fbSet('cs/guestScore/' + key, {
    guest: inbox.guest || cur.guest || null,
    lang: inbox.lang || cur.lang || 'en',
    channel: inbox.source || cur.channel || null,
    threadId: inbox.threadId || cur.threadId || null, // 후기 요청 발송 시 회신할 최근 스레드
    msgCount: (cur.msgCount || 0) + 1,
    lastSentiment: sentiment || 'neutral',
    posCount: (cur.posCount || 0) + (sentiment === 'positive' ? 1 : 0),
    negCount: (cur.negCount || 0) + (sentiment === 'negative' ? 1 : 0),
    checkoutDate: (sirvoy && sirvoy.checkoutDate) || cur.checkoutDate || null,
    sirvoyId: (sirvoy && sirvoy.sirvoyId) || cur.sirvoyId || null,
    room: (sirvoy && sirvoy.room) || cur.room || null,
    lastAt: new Date().toISOString()
  });
}

// ── 후기 탭 (2026-07-14 B1-6, §3: 감성 긍정+소통 원활 게스트만·체크아웃 익일) ──────────
// ①선별(하루 1회): 어제 체크아웃 + 긍정(negCount 0·posCount≥1) + 대화 있음 → cs/reviewQueue proposed
// ②초안(5분 슬롯): 후기 탭에서 승인된 건 → Claude 1회로 후기 요청 초안 → cs/drafts에 곧장 approved 적재
//   (2026-07-20 클라라: 대기 탭 2차 승인 제거 — 후기 탭 승인 = 최종 승인, 발송 워커가 바로 발송.
//    대기 탭에는 표시 안 함(에러 시에만 노출), 발송되면 보냄 탭에서 확인. 발송 경로는 기존 워커 재사용.)
function reviewQueueWorker_() {
  var p = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  if (p.getProperty('CS_REVIEW_DATE') === today) return; // 하루 1회(이후 run은 urlfetch 0회)
  var yesterday = Utilities.formatDate(new Date(Date.now() - 864e5), 'Asia/Seoul', 'yyyy-MM-dd');
  var scores = fbGet('cs/guestScore') || {};
  var queue = fbGet('cs/reviewQueue') || {};
  var made = 0;
  for (var key in scores) {
    var s = scores[key]; if (!s) continue;
    if (s.checkoutDate !== yesterday) continue;  // 체크아웃 익일 대상
    if (queue[key]) continue;                    // 멱등
    if ((s.negCount || 0) > 0) continue;         // 불만 이력 게스트 제외
    if ((s.posCount || 0) < 1) continue;         // 긍정 신호 필요
    fbSet('cs/reviewQueue/' + key, {
      status: 'proposed', guest: s.guest || null, bookingId: key, lang: s.lang || 'en',
      channel: s.channel || null, room: s.room || null, threadId: s.threadId || null,
      checkoutDate: s.checkoutDate, msgCount: s.msgCount || 0, posCount: s.posCount || 0,
      createdAt: new Date().toISOString()
    });
    made++;
  }
  p.setProperty('CS_REVIEW_DATE', today);
  if (made) Logger.log('후기 후보 선별: ' + made + '건 (체크아웃 ' + yesterday + ')');
}
function reviewDraftWorker_() {
  if (learnModeOn_()) return; // 학습모드(발송 없음)엔 후기요청 초안 미생성 — 대기 탭 소음 방지(2026-07-20 클라라).
                              // 승인된 후보는 reviewQueue에 남아 8월 실발송 전환 시 자동으로 초안 생성 재개.
  var queue = fbGet('cs/reviewQueue'); if (!queue) return;
  for (var key in queue) {
    var q = queue[key];
    if (!q || q.status !== 'approved' || q.drafted) continue;
    try {
      var inboxLike = {
        parsed: { message: '[시스템] 어제 체크아웃한 게스트에게 보낼 짧은 후기 요청 메시지를 작성하세요. 게스트 언어=' + (q.lang || 'en') + '. 숙박에 대한 감사 + 후기가 큰 힘이 된다는 부담 없는 두세 문장. 새 정보 안내·질문 금지.' },
        lang: q.lang || 'en', bookingId: q.bookingId || null, guest: q.guest || null,
        source: q.channel || 'booking', emailReply: true, receivedAt: new Date().toISOString(),
        raw: { body: '' }, threadId: q.threadId || null, replyTo: null
      };
      var d = claudeDraft_(inboxLike, retrieveExamples_(inboxLike), '');
      var draftId = 'review_' + key;
      fbSet('cs/drafts/' + draftId, {
        reply: d.reply, replyKo: d.replyKo, category: '후기요청', confidence: d.confidence,
        status: 'approved', autoApproved: true, approvedAt: new Date().toISOString(), // 후기 탭 승인 = 최종 승인
        editedReply: null, lang: q.lang || 'en', guest: q.guest || null,
        bookingId: q.bookingId || null, channel: q.channel || null, origin: 'review',
        threadId: q.threadId || null, emailReply: !!q.threadId, room: q.room || null,
        origMsg: '(후기 요청 — ' + (q.guest || '게스트') + ', ' + (q.checkoutDate || '') + ' 체크아웃)',
        receivedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
        model: CLAUDE_MODEL
      });
      fbUpdate('cs/reviewQueue/' + key, { drafted: true, draftId: draftId, draftedAt: new Date().toISOString() });
      Logger.log('후기 요청 초안 생성: ' + key);
    } catch (e) {
      fbUpdate('cs/reviewQueue/' + key, { draftError: String(e).slice(0, 150), lastTriedAt: new Date().toISOString() });
      Logger.log('후기 초안 실패 ' + key + ': ' + e);
    }
  }
}

// (1) 같은 예약의 이전 대화 이력 → 프롬프트용 트랜스크립트(추가 Claude 호출 없음).
//   그룹핑: 같은 bookingId(있으면) 또는 같은 threadId. 현재 메시지보다 receivedAt 이른 것만, 시간순.
//   게스트 메시지(inbox.parsed.message) + 우리 답(drafts.finalReply, saved/sent/approved) 짝을 순서대로.
function retrieveThreadHistory_(msgId, cur, allInbox, allDrafts) {
  if (!allInbox) return '';
  var curBid = cur.bookingId, curTid = cur.threadId, curAt = Date.parse(cur.receivedAt || '') || Infinity;
  var items = [];
  var ids = Object.keys(allInbox);
  for (var i = 0; i < ids.length; i++) {
    var oid = ids[i]; if (oid === msgId) continue;
    var o = allInbox[oid]; if (!o) continue;
    var sameBooking = curBid && o.bookingId && String(o.bookingId) === String(curBid);
    var sameThread  = curTid && o.threadId && String(o.threadId) === String(curTid);
    if (!sameBooking && !sameThread) continue;
    var at = Date.parse(o.receivedAt || '') || 0;
    if (at > curAt) continue;                        // 현재 메시지 이후만 제외 — 동시 도착(같은 분 연속 전송)은 맥락에 포함(2026-07-20 Kind Regards 건)
    var gmsg = (o.parsed && o.parsed.message) || '';
    var ans = '';
    var od = allDrafts && allDrafts[oid];
    if (od && (od.status === 'saved' || od.status === 'sent' || od.status === 'approved'))
      ans = od.finalReply || od.editedReply || od.reply || '';
    if (gmsg || ans) items.push({ at: at, gmsg: gmsg, ans: ans });
  }
  if (!items.length) return '';
  items.sort(function (a, b) { return a.at - b.at; });
  if (items.length > 6) items = items.slice(items.length - 6); // 최근 6개만(프롬프트 비용 캡)
  var lines = [];
  for (var k = 0; k < items.length; k++) {
    if (items[k].gmsg) lines.push('게스트: ' + items[k].gmsg);
    if (items[k].ans)  lines.push('클라라(우리): ' + items[k].ans);
  }
  return lines.join('\n');
}

function makeDraftFor_(msgId, inbox, allInbox, allDrafts) {
  var sirvoy = findSirvoy_(inbox.bookingId); // {sirvoyId, svBid, room, checkinDate, checkoutDate} 또는 null — Claude 호출 전에 조회
  var ci = (sirvoy && sirvoy.checkinDate) || inbox.checkinDate || null;
  var co = (sirvoy && sirvoy.checkoutDate) || inbox.checkoutDate || null;
  var stage = stayStage_(todayKst_(), ci, co);            // (#2) 예약 단계 — 프롬프트·코퍼스 태그·검색 가중·금칙 체크 공용
  var codeSent = checkinMailSent_(sirvoy, stage);         // (#4) HK 체크인 안내 발송 사실(읽기 전용)
  var examples = retrieveExamples_(inbox, stage);         // (#2) 동단계 예시 가중
  var corrections = retrieveCorrections_(inbox);          // (#1) 클라라 교정쌍 few-shot
  var history = retrieveThreadHistory_(msgId, inbox, allInbox, allDrafts); // (1) 같은 예약 이전 대화
  var d = claudeDraft_(inbox, examples, history, stayStateBlock_(ci, co, stage, codeSent), corrections); // 초안 호출 1회에 전부 통합
  var flags = guardFlags_(stage, codeSent, d.reply);      // (#3) 금칙 셀프체크(표시용, 차단 아님)

  var rec = {
    reply: d.reply, replyKo: d.replyKo, category: d.category, confidence: d.confidence,
    status: 'pending', editedReply: null,
    lang: inbox.lang || 'en', guest: inbox.guest || null, bookingId: inbox.bookingId || null,
    channel: inbox.source || null,              // 플랫폼(booking/agoda/expedia) — DESK 그룹헤더 뱃지용. 기존분은 null.
    replyTo: inbox.replyTo || null,
    threadId: inbox.threadId || null,           // 발송 스레드 (없으면 발송 워커가 error 처리)
    emailReply: inbox.emailReply !== false,     // false(expedia) → 발송 워커가 error 처리
    origMsg: (inbox.parsed && inbox.parsed.message) || null, // 승인 UI에 게스트 원문 표시용
    sirvoyId: sirvoy ? sirvoy.sirvoyId : null,  // pendingBookings 매칭 키(Sirvoy 내부번호). 실패 시 null.
    room: sirvoy ? sirvoy.room : null,
    receivedAt: inbox.receivedAt || null,       // 게스트 원 메일 수신시각(정렬·지난문의 판별용, inbox에서 승계)
    // 숙박일자: HK app/pendingBookings(방번호와 동일 경로) 우선, 파서(inbox)값 폴백, 둘 다 없으면 null→'미상'.
    checkinDate: ci,
    checkoutDate: co,
    hasHistory: !!history,                       // 맥락 참조 여부(DESK 표시·디버그용)
    stayStage: stage,                            // (#2) 초안 생성 시점 예약 단계 — 학습 적재 시 코퍼스로 승계
    checkinMailSent: codeSent,                   // (#4) HK 체크인 안내 발송 여부(true/false/null=미확인)
    guardFlags: flags.length ? flags : null,     // (#3) 금칙 위반 의심 — DESK ⚠️ 표시(차단 아님, 판단은 클라라)
    correctionsUsed: corrections.length,         // (#1) 교정쌍 few-shot 사용 수(디버그)
    noReplySuggested: d.replyNeeded === false,   // 답불요 추천(7월 표시만, 자동처리 없음 — 2026-07-14 B1-5)
    noReplyNote: d.replyNeeded === false ? (d.replyNote || '') : null,
    sentiment: d.sentiment || 'neutral',         // 게스트 감정(후기 대상 선별 연료)
    model: CLAUDE_MODEL, examplesUsed: examples.length, createdAt: new Date().toISOString()
  };
  fbSet('cs/drafts/' + msgId, rec);
  updateGuestScore_(inbox, d.sentiment, sirvoy); // 후기 선별용 감정·소통 지표 누적(cs/guestScore)

  // 대화체 ETA → 자동 승인 제안 (B3 후속 2026-07-15 / 2026-07-20 이중 승인 제거): 정형(notice-eta)과
  // 동일 경로 재사용 — applySuggestions_ 가 5분 내 HK 반영(취소예약 가드 포함). 초안당 1회(drafts 멱등 가드 승계).
  if (d.etaTime) {
    fbSet('cs/suggestions/' + msgId, {
      type: 'eta', status: 'approved', autoApproved: true, approvedAt: new Date().toISOString(),
      eta: d.etaTime, evidence: d.etaQuote || '',
      origin: 'chat', sourceMsgId: msgId, guest: rec.guest, bookingId: rec.bookingId,
      sirvoyId: rec.sirvoyId, room: rec.room, checkinDate: rec.checkinDate,
      checkoutDate: rec.checkoutDate, receivedAt: rec.receivedAt, createdAt: rec.createdAt
    });
    tgNotify_('[PWR CS] ' + (rec.guest || '게스트') + ' 대화체 ETA ' + d.etaTime + ' — 5분 내 HK 자동 반영');
  }

  // (4) 업무 후보 저장 — 같은 초안 호출이 반환한 tasks[]를 cs/tasks 에 status='proposed'로 적재(추가 호출 없음).
  saveTaskCandidates_(msgId, d.tasks, rec);

  // 텔레그램 푸시
  var first = (((inbox.parsed && inbox.parsed.message) || '').split('\n')[0] || '').trim();
  if (first.length > 40) first = first.slice(0, 40) + '…';
  tgNotify_('[PWR CS] ' + (flags.length ? '⚠️ ' : '') + (inbox.guest || '게스트') + ' (' + (rec.room || '미상') + ') ' + first + ' → 초안 대기' + (flags.length ? ' · 금칙 의심: ' + flags.join(', ') : ''));
}

// (4) tasks[] → cs/tasks/{msgId_tN} (status='proposed'). 방번호·예약·게스트는 우리 데이터로 보강.
//   멱등: makeDraftFor_ 는 초안당 1회만 실행(drafts[id] 가드)이라 태스크도 1회만 적재.
function saveTaskCandidates_(msgId, tasks, rec) {
  if (!tasks || !tasks.length) return;
  var now = new Date().toISOString(), n = 0;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i]; if (!t) continue;
    var text = String(t.text || '').trim(); if (!text) continue;
    fbSet('cs/tasks/' + msgId + '_t' + i, {
      text: text, dueHint: String(t.dueHint || '').trim() || null,
      room: rec.room || null, bookingId: rec.bookingId || null, guest: rec.guest || null,
      msgId: msgId, lang: rec.lang || null, status: 'proposed', createdAt: now
    });
    n++;
  }
  if (n) Logger.log('업무 후보 저장: ' + n + '건 (msg ' + msgId + ')');
}

// (2c) 1회성 백로그 정리: 현재 pending(또는 status 없음) draft 전체를 dismissed로 전환.
//   - 삭제 아님(원문·필드 전부 보존) — status/dismissedAt 만 바꿈. 발송·학습 제외(앱 dismiss와 동일 의미).
//   - 앱의 bulkDismiss와 달리 시각 임계값 없음: 오늘 새벽 밀려든 백로그까지 현재 pending 전부 대상.
//   - 다중 경로 1회 fbUpdate('cs/drafts', patch)로 원자 반영. fbGet/fbUpdate만 → Gmail 미사용(예산 무관).
//   - 멱등: 재실행 시 pending 없으면 0건.
//   Clara가 GAS 에디터에서 1회 수동 실행(트리거 아님).
function cleanupPendingBacklog() {
  var drafts = fbGet('cs/drafts');
  if (!drafts) { Logger.log('cs/drafts 없음 — 정리할 백로그 없음 (0건)'); return 0; }
  var ids = Object.keys(drafts), now = new Date().toISOString(), patch = {}, n = 0;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], d = drafts[id];
    if (!d) continue;
    if (d.status && d.status !== 'pending') continue;   // pending 또는 status 없음만 대상
    patch[id + '/status'] = 'dismissed';
    patch[id + '/dismissedAt'] = now;
    n++;
  }
  if (n > 0) fbUpdate('cs/drafts', patch);
  Logger.log('백로그 pending 일괄 dismiss: ' + n + '건 (삭제 아님·보존, 발송·학습 제외)');
  return n;
}

// corpus 유사사례 검색: 같은 언어(+5) + 키워드 겹침 + 같은 예약 단계(+3, #2 — stage 태그는 신규 적재분부터) 상위 5건
function retrieveExamples_(inbox, stage) {
  var corpus = fbGet('cs/corpus'); if (!corpus) return [];
  var lang = inbox.lang || 'en';
  var msg = (((inbox.parsed && inbox.parsed.message) || '')).toLowerCase();
  var toks = msg.split(/\s+/).filter(function (w) { return w.length > 1; });
  var arr = [];
  for (var k in corpus) {
    var c = corpus[k]; if (!c || !c['최종답변']) continue;
    var score = (c.lang === lang ? 5 : 0);
    if (stage && c.stage === stage) score += 3;   // 동단계 우선 — 반대 단계(도착 전↔입실 후) 예시 혼입 완화
    var hay = (((c['상황요약'] || '') + ' ' + (c['최종답변'] || ''))).toLowerCase();
    for (var t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) >= 0) score++;
    arr.push({ c: c, score: score });
  }
  arr.sort(function (a, b) { return b.score - a.score; });
  var out = []; for (var i = 0; i < arr.length && i < 5; i++) out.push(arr[i].c);
  return out;
}

// (#1) cs/learn(초안→클라라 수정본 쌍) 유사사례 상위 2건 — "초안이 저지른 실수"를 few-shot으로 교정.
//   채택 기준: 언어 일치(+5) + 키워드 겹침, 합계 6점 이상(언어만 같아선 미채택 — 관련성 요구).
function retrieveCorrections_(inbox) {
  var learn = fbGet('cs/learn'); if (!learn) return [];
  var lang = inbox.lang || 'en';
  var msg = (((inbox.parsed && inbox.parsed.message) || '')).toLowerCase();
  var toks = msg.split(/\s+/).filter(function (w) { return w.length > 1; });
  var arr = [];
  for (var k in learn) {
    var c = learn[k]; if (!c || !c.before || !c.after) continue;
    if (String(c.before) === String(c.after)) continue; // 무의미 쌍 제외
    var score = (c.lang === lang ? 5 : 0);
    var hay = (((c.orig || '') + ' ' + (c.after || ''))).toLowerCase();
    for (var t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) >= 0) score++;
    if (score >= 6) arr.push({ c: c, score: score });
  }
  arr.sort(function (a, b) { return b.score - a.score; });
  var out = []; for (var i = 0; i < arr.length && i < 2; i++) out.push(arr[i].c);
  return out;
}

// 예약 단계 판정(순수, 테스트용): today/ci/co 는 'yyyy-MM-dd' 문자열(사전순=시간순).
// 반환 코드: 'pre'(도착 전)|'checkin'(체크인 당일)|'stay'(숙박 중)|'checkout'(체크아웃일)|'post'(퇴실 후)|null(날짜 전무)
function stayStage_(today, ci, co) {
  if (!ci && !co) return null;
  if (co && today > co) return 'post';
  if (co && today === co) return 'checkout';
  if (ci && today < ci) return 'pre';
  if (ci && today === ci) return 'checkin';
  return 'stay';
}
var STAGE_LABEL = {
  pre: '도착 전', checkin: '체크인 당일(15:00부터 입실)', stay: '숙박 중(이미 입실)',
  checkout: '체크아웃일(11:00까지 퇴실)', post: '체크아웃 후(이미 퇴실 — 도착·체크인 안내 금지)'
};
// 오늘(KST) 'yyyy-MM-dd'
function todayKst_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }
// [예약 상태] 프롬프트 블록: 현재 시각(KST)+숙박일+단계+체크인 안내 발송 여부(확인된 경우만).
function stayStateBlock_(ci, co, stage, codeSent) {
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  var s = '[예약 상태] 현재 시각 ' + now + ' (KST)';
  if (ci || co) s += ' · 체크인 ' + (ci || '미상') + ' ~ 체크아웃 ' + (co || '미상');
  if (stage) s += ' · 단계: ' + STAGE_LABEL[stage];
  if (codeSent === true)  s += ' · 체크인 안내(객실번호·도어코드) 이미 발송됨 — "곧 보내드리겠다"는 안내 금지, 이미 받았는지 확인만';
  if (codeSent === false) s += ' · 체크인 안내(객실번호·도어코드) 아직 발송 전 — 도착 당일 플랫폼 메시지로 발송 예정이라고 안내 가능';
  return s + '\n\n';
}
// (#4) HK 체크인 안내 메일(s3_checkin, 1박은 s34_combined — 객실번호·도어코드 포함) 발송 여부.
//   app/mailLogs 읽기 전용(§3의 app/* '쓰기' 금지 준수). 단계상 의미 있는 구간만 조회(urlfetch 절약).
//   true=발송됨 / false=미발송 확인 / null=확인 불가(매핑 실패·조회 불필요 구간·조회 실패)
function checkinMailSent_(sirvoy, stage) {
  if (!sirvoy || !sirvoy.svBid) return null;
  if (stage !== 'checkin' && stage !== 'stay' && stage !== 'checkout') return null;
  var bid = String(sirvoy.svBid).replace(/[.#$\[\]\/]/g, '_');
  try {
    if (fbGet('app/mailLogs/' + bid + '_s3_checkin')) return true;
    if (fbGet('app/mailLogs/' + bid + '_s34_combined')) return true;
    return false;
  } catch (e) { return null; }
}
// (#3) 발송 전 금칙 셀프체크(순수, 테스트용). 차단 아님 — DESK 대기 카드 ⚠️ 표시용.
var GUARD_CODE_NOUN    = /(room (number|no\b)|access ?code|door ?code|객실 ?번호|도어 ?코드|비밀번호)/i;
var GUARD_SEND_FUTURE  = /(will (be )?sen[dt]|will send|we('ll| will) send|going to send|sent (to you )?shortly|shortly|soon|곧 |보내드릴|보내 ?드릴게|발송해 ?드릴|전송해 ?드릴)/i;
var GUARD_ARRIVAL_GUIDE = /(check[- ]?in is (from|at)|check[- ]?in starts|shuttle|bus 0?3|03번|셔틀|체크인은 15|오시는 ?길)/i;
function guardFlags_(stage, codeSent, reply) {
  var r = String(reply || ''), flags = [];
  if (GUARD_CODE_NOUN.test(r) && GUARD_SEND_FUTURE.test(r)) {
    if (stage === 'stay' || stage === 'checkout' || stage === 'post') flags.push('입실 이후 게스트에게 코드 발송을 다시 약속하는 문구');
    else if (codeSent === true) flags.push('체크인 안내 기발송인데 코드 발송을 새로 약속하는 문구');
  }
  if (stage === 'post' && GUARD_ARRIVAL_GUIDE.test(r)) flags.push('퇴실한 게스트에게 도착·체크인 안내 문구');
  return flags;
}

// Claude API 호출 (UrlFetchApp). 키는 스크립트 속성 ANTHROPIC_KEY 에서만.
//   history(있으면) = 같은 예약 이전 대화 트랜스크립트 → 프롬프트에 얹어 맥락 반영(호출 수 불변, 1회).
//   state(있으면) = stayStateBlock_() 산출 [예약 상태] 블록 — 도착 전/입실/퇴실 단계 오답 방지(2026-07-25).
//   corrections(있으면) = retrieveCorrections_() 교정쌍 — 초안의 반복 실수 억제(#1, 2026-07-25).
function claudeDraft_(inbox, examples, history, state, corrections) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!key) throw new Error('스크립트 속성 ANTHROPIC_KEY 미설정');

  var ex = '';
  for (var i = 0; i < examples.length; i++)
    ex += '상황: ' + (examples[i]['상황요약'] || '') + '\n답변: ' + (examples[i]['최종답변'] || '') + '\n---\n';
  var corr = '';
  if (corrections && corrections.length) {
    corr = '[클라라 교정 사례] (시스템 초안을 클라라가 직접 고친 기록 — 초안이 저지른 실수의 방향을 파악해 같은 실수를 반복하지 말고, 수정본 쪽 태도·사실을 따르세요)\n';
    for (var ci2 = 0; ci2 < corrections.length; ci2++)
      corr += '상황: ' + String(corrections[ci2].orig || '').slice(0, 300) +
              '\n시스템 초안(잘못): ' + String(corrections[ci2].before || '').slice(0, 600) +
              '\n클라라 수정본(정답): ' + String(corrections[ci2].after || '').slice(0, 600) + '\n---\n';
    corr += '\n';
  }
  var message = (inbox.parsed && inbox.parsed.message) || (inbox.raw && inbox.raw.body) || '';
  var hist = history ? ('[이 예약의 이전 대화] (시간순, 이미 안내한 내용 반복 금지)\n' + history + '\n\n') : '';
  var user = '[과거 응대 예시]\n' + (ex || '(예시 없음)\n') + '\n' + corr + hist + (state || '') +
             '[이번 게스트 메시지] (언어=' + (inbox.lang || 'en') + ')\n' + message +
             '\n\n위 지침대로 JSON만 출력하세요.';

  var payload = { model: CLAUDE_MODEL, max_tokens: CLAUDE_MAXTOK, system: CLARA_SYSTEM,
                  messages: [{ role: 'user', content: user }] };
  // 파싱 실패만 1회 재시도(호출 최대 2회). API 에러(>=300)는 재시도 없이 즉시 throw.
  var text = '', obj = null;
  for (var attempt = 0; attempt < 2 && !obj; attempt++) {
    var res = csFetch_('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) throw new Error('Claude API ' + res.getResponseCode() + ': ' + res.getContentText());
    var body = JSON.parse(res.getContentText());
    text = (body.content && body.content[0] && body.content[0].text) || '';
    if (_diagRaw) Logger.log('RAW Claude 응답:\n' + text); // 진단(diagPeekTasks)에서만 켜짐
    obj = extractJson_(text);
  }
  if (!obj) throw new Error('Claude 응답 JSON 파싱 실패(재시도 포함 2회): ' + text.slice(0, 200));
  return {
    reply: obj.reply || '', replyKo: obj.replyKo || '',
    category: obj.category || '기타',
    confidence: (typeof obj.confidence === 'number' ? obj.confidence : null),
    tasks: sanitizeTasks_(obj.tasks), // (4) 업무 후보 배열(없으면 [])
    replyNeeded: (obj.replyNeeded === false ? false : true), // 답변 필요도(기본 true — 미출력 시 안전)
    replyNote: String(obj.replyNote || '').slice(0, 120),    // 답불요 사유(한국어 한 줄)
    sentiment: (['positive','neutral','negative'].indexOf(obj.sentiment) >= 0 ? obj.sentiment : 'neutral'), // 후기 대상 선별용
    etaTime: (/^\d{1,2}:\d{2}$/.test(String(obj.etaTime || '')) ? obj.etaTime : null), // 대화체 ETA(형식 불일치·null → 무시)
    etaQuote: String(obj.etaQuote || '').slice(0, 200)
  };
}
// 모델이 준 tasks[] 정제: 배열·객체·text 유효한 것만, 최대 5개.
function sanitizeTasks_(tasks) {
  if (!tasks || Object.prototype.toString.call(tasks) !== '[object Array]') return [];
  var out = [];
  for (var i = 0; i < tasks.length && out.length < 5; i++) {
    var t = tasks[i]; if (!t || typeof t !== 'object') continue;
    var text = String(t.text || '').trim(); if (!text) continue;
    out.push({ text: text, dueHint: String(t.dueHint || '').trim() });
  }
  return out;
}
function extractJson_(s) {
  var i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < 0) return null;
  try { return JSON.parse(s.substring(i, j + 1)); } catch (e) { return null; }
}

// (진단) 업무 탭 0 규명 — 지정 msgId 하나로 초안 호출 1회 실행 → 원응답 raw + 파싱된 tasks 로그.
//   Clara가 GAS에서 diagPeekTasks('<cs/inbox의 msgId>') 실행. Claude 호출 1회(비용 발생) — 156 재생성 아님.
//   tasks가 raw에 있으면 신규 파이프라인 정상, 기존 156의 0은 2a33058 이전 생성분이라 정상.
var _diagRaw = false;
function diagPeekTasks(msgId) {
  if (!msgId) { Logger.log('사용법: diagPeekTasks("cs/inbox의 msgId"). cs/inbox 키 하나를 넣으세요.'); return; }
  var inbox = fbGet('cs/inbox/' + msgId);
  if (!inbox) { Logger.log('inbox 없음: ' + msgId); return; }
  var allInbox = fbGet('cs/inbox') || {}, allDrafts = fbGet('cs/drafts') || {};
  _diagRaw = true;
  try {
    var sv = findSirvoy_(inbox.bookingId); // 프로덕션 makeDraftFor_ 와 동일 프롬프트 재현
    var dci = (sv && sv.checkinDate) || inbox.checkinDate || null, dco = (sv && sv.checkoutDate) || inbox.checkoutDate || null;
    var dstage = stayStage_(todayKst_(), dci, dco);
    var d = claudeDraft_(inbox, retrieveExamples_(inbox, dstage), retrieveThreadHistory_(msgId, inbox, allInbox, allDrafts),
                         stayStateBlock_(dci, dco, dstage, checkinMailSent_(sv, dstage)), retrieveCorrections_(inbox));
    Logger.log('파싱된 tasks[] = ' + JSON.stringify(d.tasks || []));
    Logger.log(d.tasks && d.tasks.length ? '→ 신규 파이프라인 정상(태스크 추출됨).' : '→ 이 메시지엔 처리할 태스크 없음(단순 정보 문의면 정상). 다른 "나중에~"류 메시지로 재확인 권장.');
  } catch (e) { Logger.log('diagPeekTasks 실패: ' + e); }
  finally { _diagRaw = false; }
}

// ══════════════════════════════════════════════════════════════════
// 제안 반영 워커 — 승인된 cs/suggestions를 HK에 반영 (fullRun 5분 주기)
//   §3 확정 설계의 유일한 app/* 쓰기 허용 경로: "suggestions 승인 반영".
//   eta 제안: app/pendingBookings/{key}.eta 갱신 + app/rooms/* 해당 예약 checkinTime 동기화
//   (HK GAS syncEtaToRoom과 동일 로직 — ETA 시작 시각만 checkinTime으로).
//   Sirvoy 매핑 실패(웹훅 아직 안 옴)는 applyError 마킹 후 다음 run 자동 재시도.
// ══════════════════════════════════════════════════════════════════
function applySuggestions_() {
  var sugg = fbGet('cs/suggestions'); if (!sugg) return;
  var pendAll = null, roomsAll = null; // 필요할 때만 1회 로드(urlfetch 절약)
  for (var id in sugg) {
    var s = sugg[id];
    if (!s || s.status !== 'approved') continue;
    if (s.type !== 'eta' || !s.eta) {
      fbUpdate('cs/suggestions/' + id, { status: 'applied', appliedAt: new Date().toISOString(), applyNote: '자동 반영 대상 아님' });
      continue;
    }
    if (pendAll === null) pendAll = fbGet('app/pendingBookings') || {};
    var key = (s.sirvoyId && pendAll[s.sirvoyId]) ? s.sirvoyId : null;
    if (!key && s.bookingId) {
      for (var k in pendAll) { var b = pendAll[k]; if (b && String(b.channelBookingId) === String(s.bookingId)) { key = k; break; } }
    }
    if (!key) {
      fbUpdate('cs/suggestions/' + id, { applyError: 'Sirvoy 매핑 실패 — 웹훅 도착 대기, 자동 재시도 중', lastTriedAt: new Date().toISOString() });
      continue;
    }
    var pendRec = pendAll[key];
    // 취소된 예약이면 반영하지 않고 종결 (2026-07-14 martina 건 — 요청 알림 후 취소된 예약에 반영됐던 구멍)
    if (pendRec && pendRec.cancelled) {
      fbUpdate('cs/suggestions/' + id, { status: 'rejected', applyNote: '취소된 예약 — 반영 안 함', rejectedAt: new Date().toISOString() });
      Logger.log('제안 기각(취소된 예약): ' + id + ' → ' + key);
      continue;
    }
    fbUpdate('app/pendingBookings/' + key, { eta: s.eta });
    var ciM = String(s.eta).match(/^(\d{1,2}):(\d{2})/);
    if (ciM && pendRec && pendRec.bookingId) {
      var ci = (String(ciM[1]).length < 2 ? '0' + ciM[1] : ciM[1]) + ':' + ciM[2];
      if (roomsAll === null) roomsAll = fbGet('app/rooms') || {};
      for (var rm in roomsAll) {
        var r = roomsAll[rm]; if (!r) continue;
        var changed = false;
        if (r.currentBooking && String(r.currentBooking.bookingId) === String(pendRec.bookingId) && r.currentBooking.checkinTime !== ci) { r.currentBooking.checkinTime = ci; r.currentBooking.etaFromCs = true; changed = true; } // etaFromCs: HK 빨간 점 마커(2026-07-20)
        if (Array.isArray(r.nextBookings)) {
          for (var i2 = 0; i2 < r.nextBookings.length; i2++) {
            var nb = r.nextBookings[i2];
            if (nb && String(nb.bookingId) === String(pendRec.bookingId) && nb.checkinTime !== ci) { nb.checkinTime = ci; nb.etaFromCs = true; changed = true; }
          }
        }
        if (changed) fbSet('app/rooms/' + rm, r);
      }
    }
    fbUpdate('cs/suggestions/' + id, { status: 'applied', appliedAt: new Date().toISOString(), appliedTo: key, applyError: null });
    Logger.log('제안 반영: ' + id + ' eta=' + s.eta + ' → ' + key);
  }
}

// ══════════════════════════════════════════════════════════════════
// (진단) 수신 누락 전수조사 — diagMissedInbox()  [2026-07-14, B1-1]
//   최근 N일(기본 3일) OTA 발신 도메인 메일을 라벨 무관 전수 검색 →
//   각 메일이 ①라벨(cs/booking·CS/적재됨) 붙었는지 ②cs/inbox 적재됐는지 대조해 로그로 출력.
//   실행: GAS 에디터에서 함수 diagMissedInbox 선택 → 실행 → 실행 로그 복사. 배포 불필요.
//   비용: Gmail 읽기 소량 + urlfetch 1회(shallow 키 목록만). 발송·초안 생성 없음.
// ══════════════════════════════════════════════════════════════════
function diagMissedInbox(days) {
  days = days || 3;
  // 3사 발신 도메인을 넓게 검색(변형 발신자 탐지 목적 — 마케팅 메일도 걸리니 제목 보고 판별)
  var q = 'newer_than:' + days + 'd from:(guest.booking.com OR booking.com OR agoda-messaging.com OR agoda.com OR expediapartnercentral.com OR expedia.com)';
  var threads = GmailApp.search(q, 0, 100);
  var res = UrlFetchApp.fetch(FB_BASE + '/cs/inbox.json?shallow=true&auth=' + fbAuth_(), { muteHttpExceptions: true });
  var inboxKeys = (res.getResponseCode() < 300 && JSON.parse(res.getContentText())) || {};
  var rows = [], nOk = 0, nNoLabel = 0, nSkipped = 0, nWait = 0;
  for (var t = 0; t < threads.length; t++) {
    var labels = threads[t].getLabels().map(function (L) { return L.getName(); });
    var hasCs = labels.indexOf(CS_LABEL) >= 0, hasDone = labels.indexOf(CS_DONE_LABEL) >= 0;
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      if ((Date.now() - msg.getDate().getTime()) > days * 864e5) continue; // 스레드 내 옛 메시지 제외
      var id = msg.getId();
      var ch = detectChannel_(msg.getFrom());
      var state;
      if (inboxKeys[id]) { state = 'OK 적재됨'; nOk++; }
      else if (!hasCs && !hasDone) { state = '[R]라벨없음 — Gmail 필터가 이 발신자를 안 잡음'; nNoLabel++; }
      else if (!ch) { state = '[Y]라벨O·비대상발신자 — 파서가 모르는 From(스킵된 채 완료처리)'; nSkipped++; }
      else if (hasDone && !hasCs) { state = '[O]완료라벨인데 inbox 없음 — 스킵/유실 의심'; nSkipped++; }
      else { state = '대기중(다음 폴링에 처리 예정)'; nWait++; }
      rows.push([Utilities.formatDate(msg.getDate(), 'Asia/Seoul', 'MM-dd HH:mm'), (ch || '?'), state, msg.getFrom(), String(msg.getSubject() || '').slice(0, 60), id, '라벨[' + (labels.join('+') || '없음') + ']'].join(' | '));
    }
  }
  rows.sort(); rows.reverse();
  Logger.log('===== 수신 누락 전수조사: 최근 ' + days + '일, 스레드 ' + threads.length + '개 =====');
  for (var i = 0; i < rows.length; i++) Logger.log(rows[i]);
  Logger.log('===== 요약: 적재 ' + nOk + ' / [R]라벨없음 ' + nNoLabel + ' / [Y·O]라벨O·미적재 ' + nSkipped + ' / 대기 ' + nWait + ' =====');
  Logger.log('[R]이 게스트 메시지면 → Gmail 필터 조건에 그 발신자 추가 필요. [Y·O]가 있으면 → 그 줄 전체를 클코에 전달(파서 확장).');
}

// (진단) Gmail 사용자 라벨 전수 목록 — 라벨 양분(예: cs/booking vs CS/booking) 여부 확정용.
//   실행: 함수 diagListLabels 선택 → 실행 → 로그 확인. Gmail 읽기만, urlfetch 0회.
function diagListLabels() {
  var labels = GmailApp.getUserLabels();
  Logger.log('===== Gmail 사용자 라벨 전체 (' + labels.length + '개) =====');
  for (var i = 0; i < labels.length; i++) {
    var name = labels[i].getName();
    var n = labels[i].getThreads(0, 100).length;
    Logger.log(name + ' | 스레드 ' + (n >= 100 ? '100+' : n) + '개');
  }
  Logger.log('확인 포인트: 대소문자만 다른 쌍(cs/booking vs CS/booking)이 같이 있으면 양분 사고 → 클코에 보고. CS/적재됨은 코드가 쓰는 정상 처리완료함.');
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
    if (b && b.cancelled) continue; // 취소된 예약은 매칭 제외(방·일자 보강에 취소 기록 오염 방지, 2026-07-14)
    if (b && String(b.channelBookingId) === String(bookingId))
      // 방번호·숙박일자를 같은 HK 레코드에서 함께 반환(HK index.html:1268 확인 — checkinDate/checkoutDate/assignedRoom 동일 레코드).
      return { sirvoyId: key, svBid: (b.bookingId || null), // svBid: HK mailLogs 키 재료(체크인 안내 발송 여부 조회, #4)
               room: (b.assignedRoom || null),
               checkinDate: (b.checkinDate || null), checkoutDate: (b.checkoutDate || null) };
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
