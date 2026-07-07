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
  var res = UrlFetchApp.fetch(fbUrl_(path), { muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('fbGet ' + path + ': ' + res.getContentText());
  var body = res.getContentText();
  return body === 'null' || body === '' ? null : JSON.parse(body);
}
function fbSet(path, obj) {
  var res = UrlFetchApp.fetch(fbUrl_(path), {
    method: 'put', contentType: 'application/json',
    payload: JSON.stringify(obj), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('fbSet ' + path + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function fbUpdate(path, obj) {
  var res = UrlFetchApp.fetch(fbUrl_(path), {
    method: 'patch', contentType: 'application/json',
    payload: JSON.stringify(obj), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('fbUpdate ' + path + ': ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function fbDelete(path) {
  var res = UrlFetchApp.fetch(fbUrl_(path), { method: 'delete', muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('fbDelete ' + path + ': ' + res.getContentText());
  return true;
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
function budgetSnapshot_(usedStr, budgetStr, date) { // 순수(테스트용)
  return { used: parseInt(usedStr || '0', 10), budget: parseInt(budgetStr || '150', 10), date: date };
}
function mirrorBudget_() {
  var p = PropertiesService.getScriptProperties();
  var date = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var snap = budgetSnapshot_(p.getProperty('CS_GMAIL_USED_' + date), p.getProperty('CS_GMAIL_BUDGET'), date);
  try { fbSet('cs/meta/gmailBudget', snap); } catch (e) { Logger.log('budget mirror 실패: ' + e); }
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
  var label = gmGetLabel_(CS_LABEL);
  if (_gmailStop) { safeDrafts_(); return; }
  if (!label) { Logger.log('라벨 없음: ' + CS_LABEL + ' — §6f 필터 확인'); safeDrafts_(); return; }

  var doneLabel = gmGetLabel_(CS_DONE_LABEL) || gmCreateLabel_(CS_DONE_LABEL);
  if (_gmailStop || !doneLabel) { safeDrafts_(); return; }

  // 저연비: 처리 완료 스레드는 CS_LABEL에서 제거(라벨 이동)하므로 매 run 미처리분만 조회됨.
  // (멱등 이중 안전판: ingestMessage_ 의 fbGet 존재체크가 재적재 방지)
  var threads = gmGetThreads_(label, 0, 20);
  for (var t = 0; t < threads.length && !_gmailStop; t++) {
    var msgs = gmGetMessages_(threads[t]);
    if (_gmailStop) break;
    var hadFailure = false;
    for (var m = 0; m < msgs.length; m++) {
      try { ingestMessage_(msgs[m]); }
      catch (e) { Logger.log('적재 실패 msgId=' + safeId_(msgs[m]) + ' : ' + e); hadFailure = true; }
    }
    if (!hadFailure) { gmAddLabel_(threads[t], doneLabel); gmRemoveLabel_(threads[t], label); }
  }

  // 초안 생성은 Gmail 미사용 → 예산과 무관하게 항상 진행 (수신과 분리)
  safeDrafts_();
  mirrorBudget_(); // run 종료 시 예산 사용량 미러링
}

function ingestMessage_(msg) {
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

  var parsed = parseBooking_(raw); // { ok, source, bookingId, guest, lang, message }

  var rec = {
    source: parsed.source || 'booking',
    bookingId: parsed.bookingId || null,
    guest: parsed.guest || null,
    lang: parsed.lang || guessLang_(parsed.message || raw.body),
    replyTo: parsed.guestEmail || null,      // 게스트 회신 주소(=발신주소). M2 발송 경로.
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

function parseBooking_(raw) {
  var out = { ok: false, source: 'booking', bookingId: null, guest: null,
              guestEmail: null, lang: null, message: null, bookingIdMismatch: false,
              rawTail: false, checkinDate: null, checkoutDate: null,
              guestCount: null, roomCount: null, propertyName: null };
  var body = raw.body || '';
  var subject = raw.subject || '';
  var from = raw.from || '';

  // 예약번호 1차: From 로컬파트 앞 숫자 ({번호}-{난수}@guest.booking.com)
  var mFrom = from.match(/([0-9]+)(?:-[a-z0-9.]+)?@guest\.booking\.com/i);
  var fromNum = mFrom ? mFrom[1] : null;
  // 게스트 회신 주소 = From 의 guest.booking.com 주소 그 자체 (회신 경로 = 발신 주소)
  var mAddr = from.match(/[\w.\-]+@guest\.booking\.com/i);
  out.guestEmail = mAddr ? mAddr[0] : null;

  // 예약번호 2차: 본문 "예약 번호: {숫자}"
  var mBody = body.match(/예약\s*번호\s*[:：]\s*([0-9]{6,})/);
  var bodyNum = mBody ? mBody[1] : null;

  // 교차검증: 둘 다 있고 다르면 플래그(적재는 진행), 하나만 있으면 그것 사용
  if (fromNum && bodyNum && fromNum !== bodyNum) out.bookingIdMismatch = true;
  out.bookingId = fromNum || bodyNum || null;

  // 게스트명: 제목 "{게스트명} 님의 메시지가 도착했습니다"
  var mG = subject.match(/^(.*?)\s*님의\s*메시지가\s*도착했습니다/);
  if (mG) out.guest = mG[1].trim();

  // Edit 3 — 예약 상세 정보 블록 필드 추출 (메시지 자르기 전, 전체 본문 기준)
  var allLines = body.split('\n');
  out.checkinDate  = normDate_(findLineValue_(allLines, '체크인'));
  out.checkoutDate = normDate_(findLineValue_(allLines, '체크아웃'));
  out.guestCount   = findLineValue_(allLines, '총 투숙객 수');
  out.roomCount    = findLineValue_(allLines, '총 객실 수');
  out.propertyName = findLineValue_(allLines, '숙소 명칭');

  // Edit 1 — 메시지 본문: "님의 메시지:" 이후 ~ 최초 종료마커 전까지 (줄 단위 매칭).
  //   결함 대응: "답변 -->"가 실제론 "답변\n\n-->"로 줄바꿈됨 → 문자열 indexOf 실패.
  //   종료마커: ①독립 줄 "답변"  ②"예약 상세 정보"  ③"© Copyright"  (가장 먼저 등장하는 지점)
  var startMarker = '님의 메시지:';
  var si = body.indexOf(startMarker);
  if (si >= 0) {
    var afterLines = body.substring(si + startMarker.length).split('\n');
    var cut = -1;
    for (var li = 0; li < afterLines.length; li++) {
      var ln = afterLines[li].trim();
      if (ln === '답변' || ln.indexOf('예약 상세 정보') === 0 || ln.indexOf('© Copyright') === 0) { cut = li; break; }
    }
    if (cut >= 0) {
      out.message = afterLines.slice(0, cut).join('\n').trim() || null;
    } else {
      out.message = afterLines.join('\n').trim() || null; // 마커 없음 → 전체 유지
      out.rawTail = true;
    }
  }

  // Edit 2 — 언어 감지는 절단된 clean message 기준 (꼬리 한국어 오염 방지)
  out.lang = guessLang_(out.message);
  out.ok = !!(out.bookingId && out.message); // 식별자+메시지 둘 다 잡혀야 파싱 성공
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

// 날짜 정규화 → YYYY-MM-DD (YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD / "YYYY년 M월 D일" 지원). 실패 null.
function normDate_(s) {
  if (!s) return null;
  var m = s.match(/(\d{4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/);
  return m ? (m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3])) : null;
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
    sirvoyId: sirvoy ? sirvoy.sirvoyId : null,  // pendingBookings 매칭 키(Sirvoy 내부번호). 실패 시 null.
    room: sirvoy ? sirvoy.room : null,
    model: CLAUDE_MODEL, examplesUsed: examples.length, createdAt: new Date().toISOString()
  };
  fbSet('cs/drafts/' + msgId, rec);

  // (3) 텔레그램 푸시
  var first = (((inbox.parsed && inbox.parsed.message) || '').split('\n')[0] || '').trim();
  if (first.length > 40) first = first.slice(0, 40) + '…';
  tgNotify_('[PWR CS] ' + (inbox.guest || '게스트') + ' (' + (rec.room || '미상') + ') ' + first + ' → 초안 대기');
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
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
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
    UrlFetchApp.fetch('https://api.telegram.org/bot' + tok + '/sendMessage', {
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

  var n = 0;
  for (var r = 1; r < values.length; r++) {
    var lang = String(values[r][0] || '').trim();   // A lang
    var situ = String(values[r][1] || '').trim();   // B guest_message → 상황요약
    var ans  = String(values[r][2] || '').trim();   // C clara_reply   → 최종답변
    var cat  = String(values[r][3] || '').trim();   // D category
    if (!situ && !ans) continue;
    if (!lang) lang = guessLang_(ans || situ);
    var id = 'sheet_' + r;
    if (fbGet('cs/corpus/' + id)) continue; // 재실행 멱등
    fbSet('cs/corpus/' + id, {
      '상황요약': situ, '최종답변': ans, lang: lang, category: cat || null, origin: '구축', src: 'sheet'
    });
    n++;
  }
  Logger.log('시트 임포트 완료: corpus +' + n + '건');
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
