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

function pollCsInbox() {
  var label = GmailApp.getUserLabelByName(CS_LABEL);
  if (!label) { Logger.log('라벨 없음: ' + CS_LABEL + ' — §6f 필터 확인'); return; }

  var doneLabel = GmailApp.getUserLabelByName(CS_DONE_LABEL) || GmailApp.createLabel(CS_DONE_LABEL);

  // 슬래시 포함 라벨명은 Gmail 검색 문법으로 못 찾음(중첩라벨 기벽) → 라벨 객체로 직접 조회
  var threads = label.getThreads(0, 20);
  if (!threads.length) return;

  for (var t = 0; t < threads.length; t++) {
    // 이미 적재된(=CS_DONE_LABEL 부여) 스레드는 skip (기존 검색의 -label 대체)
    if (threadHasLabel_(threads[t], CS_DONE_LABEL)) continue;
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length; m++) {
      try {
        ingestMessage_(msgs[m]);
      } catch (e) {
        Logger.log('적재 실패 msgId=' + safeId_(msgs[m]) + ' : ' + e);
        // 개별 메시지 실패가 스레드 전체 라벨링을 막지 않도록 계속 진행하되,
        // 실패 메시지가 하나라도 있으면 아래 doneLabel 부여를 건너뛴다.
        threads[t]._hadFailure = true;
      }
    }
    if (!threads[t]._hadFailure) threads[t].addLabel(doneLabel);
  }
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

// 스레드에 특정 이름의 라벨이 붙어있는지 (getLabels() 이름 비교 — 검색 -label 대체)
function threadHasLabel_(thread, name) {
  var ls = thread.getLabels();
  for (var i = 0; i < ls.length; i++) if (ls[i].getName() === name) return true;
  return false;
}

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
  var label = GmailApp.getUserLabelByName(CS_LABEL);
  if (!label) { Logger.log('라벨 없음: ' + CS_LABEL); return; }
  var threads = label.getThreads(0, 1);
  if (!threads.length) { Logger.log('라벨에 메일 없음'); return; }
  var msg = threads[0].getMessages()[0];
  var raw = { from: msg.getFrom(), subject: msg.getSubject(), body: msg.getPlainBody(), receivedAt: msg.getDate().toISOString() };
  Logger.log(JSON.stringify(parseBooking_(raw), null, 2));
}

// ══════════════════════════════════════════════════════════════════
// M2 선행 확인용 (트리거 아님) — pendingBookings 에 "부킹 원번호(10자리)" 필드 존재 여부 점검.
//   Clara가 GAS 에디터에서 1회 실행 → 실행 로그를 Fable/클코에 전달.
//   (클코 샌드박스는 FB_AUTH 없어 Firebase 직접 읽기 불가 → GAS에서 확인 필요)
// ══════════════════════════════════════════════════════════════════
function debugPeekPending() {
  var candidates = ['pendingBookings', 'app/pendingBookings', 'app/pending'];
  var data = null, usedPath = null;
  for (var c = 0; c < candidates.length; c++) {
    try { var d = fbGet(candidates[c]); if (d) { data = d; usedPath = candidates[c]; break; } }
    catch (e) { Logger.log('read fail ' + candidates[c] + ': ' + e); }
  }
  if (!data) { Logger.log('pendingBookings 데이터를 못 찾음 — 실제 경로를 알려주세요 (시도: ' + candidates.join(', ') + ')'); return; }

  var keys = Object.keys(data).slice(0, 5);
  Logger.log('경로=' + usedPath + ' / 총 ' + Object.keys(data).length + '건 중 샘플 ' + keys.length + '건');
  for (var i = 0; i < keys.length; i++) {
    var rec = data[keys[i]];
    // 값이 10자리 숫자인 필드 = 부킹 원번호 후보
    var tenDigitFields = [];
    for (var f in rec) { if (/^\d{10}$/.test(String(rec[f]))) tenDigitFields.push(f + '=' + rec[f]); }
    Logger.log('── [' + keys[i] + '] 필드=' + Object.keys(rec).join(',')
      + ' | 10자리필드=' + (tenDigitFields.join(', ') || '(없음)'));
    Logger.log(JSON.stringify(rec));
  }
}
