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
// ⚠️ 확인 필요 (Clara/HK) — 아래 2개는 추정값. M1 전에 HK GAS 원본과 대조할 것.
// ══════════════════════════════════════════════════════════════════

// (1) Firebase RTDB 베이스 URL.
//     HK GAS의 fbGet/fbSet 이 쓰는 값과 반드시 동일해야 한다.
//     HK Code.gs 상단에서 그대로 복사해 덮어쓸 것.
//     (newer 프로젝트는 …-default-rtdb.firebaseio.com, older US 프로젝트는 …firebaseio.com)
var FB_BASE = 'https://paradise-walk-residence-default-rtdb.firebaseio.com';

// (2) 폴링 대상 Gmail 라벨 (§6f 필터로 자동 부여). 필요시 Clara가 라벨명 확정.
var CS_LABEL = 'CS/부킹';
var CS_DONE_LABEL = 'CS/적재됨'; // 중복 방지용 — 적재 성공 시 부여 (자동 생성)

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

  // 아직 적재 안 된(=CS_DONE_LABEL 미부여) 스레드만
  var threads = GmailApp.search('label:"' + CS_LABEL + '" -label:"' + CS_DONE_LABEL + '"', 0, 20);
  if (!threads.length) return;

  for (var t = 0; t < threads.length; t++) {
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
    receivedAt: raw.receivedAt,
    raw: raw,                 // §6c: 파싱 실패해도 raw 는 항상 보존 — 메일 유실 금지
    parsed: parsed.ok ? { message: parsed.message } : null,
    parseFailed: !parsed.ok, // §6c: 파싱실패 플래그
    ingestedAt: new Date().toISOString()
  };

  fbSet(path, rec);
  Logger.log((parsed.ok ? 'OK ' : 'RAW-ONLY ') + msgId + ' / ' + (parsed.bookingId || '?'));
}

// ══════════════════════════════════════════════════════════════════
// 파싱
// ⚠️ 확인 필요: 아래 정규식은 실제 Booking.com 호스트 알림메일 샘플이 없어
//    heuristic 으로 작성함. Clara가 실제 메일 1건 전달하면 필드 규칙을 확정한다.
//    실패해도 parseBooking_ 은 ok:false 를 반환할 뿐, raw 는 ingestMessage_ 에서 보존됨.
// ══════════════════════════════════════════════════════════════════

function parseBooking_(raw) {
  var out = { ok: false, source: 'booking', bookingId: null, guest: null, lang: null, message: null };
  var body = raw.body || '';
  var subject = raw.subject || '';

  // 예약번호: "Reservation number: 1234567890" / "예약 번호: 1234567890" / 10자리 숫자
  var mId = body.match(/(?:reservation\s*number|예약\s*번호)\D*(\d{6,})/i) || body.match(/\b(\d{10})\b/);
  if (mId) out.bookingId = mId[1];

  // 게스트명: 제목 "New message from Jane Doe" / 본문 "Guest: Jane Doe" 류
  var mG = subject.match(/(?:message from|message de|메시지[:\s])\s*(.+?)\s*$/i)
        || body.match(/(?:guest name|guest|게스트)\s*[:\-]\s*(.+)/i);
  if (mG) out.guest = mG[1].trim();

  // 메시지 본문: 알림메일 정형 구간을 못 특정하므로 전체 plainBody 를 message 로 넘기고
  //   실제 구획 규칙은 샘플 확보 후 확정 (예: "---" 구분선 사이만 추출).
  out.message = body.trim() || null;

  out.lang = guessLang_(out.message);
  out.ok = !!(out.bookingId || out.guest); // 최소 식별자 하나라도 잡히면 파싱 성공으로 간주
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

// ══════════════════════════════════════════════════════════════════
// 수동 점검용 (트리거 아님) — GAS 에디터에서 직접 실행해 파싱 결과만 로그로 확인
// ══════════════════════════════════════════════════════════════════
function debugPeekLatest() {
  var threads = GmailApp.search('label:"' + CS_LABEL + '"', 0, 1);
  if (!threads.length) { Logger.log('라벨에 메일 없음'); return; }
  var msg = threads[0].getMessages()[0];
  var raw = { from: msg.getFrom(), subject: msg.getSubject(), body: msg.getPlainBody(), receivedAt: msg.getDate().toISOString() };
  Logger.log(JSON.stringify(parseBooking_(raw), null, 2));
}
