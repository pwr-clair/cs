// ============================================================
// 후기 작성 감지 (2026-08-04 클라라 지시) — 이미 후기를 쓴 게스트에게 요청 재제안 금지
// ============================================================
// 배경: 후기 요청을 HK에서 CS로 일원화(HK s6 자동발송 off)했는데, 게스트가 이미
// 후기를 남긴 경우에도 후기 탭이 요청을 제안함 → 중복 요청 리스크.
// 원리: OTA(부킹)는 게스트가 후기를 남기면 파트너 계정(이 GAS 실행 계정)으로
// 알림메일을 보낸다. 그 메일에서 게스트 이름을 매칭해 cs/guestScore/{bid}.reviewedAt
// 도장 → 후기 탭의 proposed 후보를 자동 건너뜀(skipped/already_reviewed) 처리.
//
// ★ 별도 파일 설계: Code.gs는 수정하지 않는다 (GAS는 프로젝트 내 전 파일이 전역
//   스코프를 공유하므로 fbGet/fbUpdate/gmSearch_ 등 Code.gs 헬퍼를 그대로 사용).
//   선별(reviewQueueWorker_)은 그대로 두고, 이 파일의 스윕이 매시간 뒷정리한다
//   — 알림이 선별보다 늦게 와도, 먼저 와도 결과는 동일(제안 최대 1시간 노출 후 자동 건너뜀).
//
// 설치(1회): ①GAS 에디터에 새 파일 ReviewDedup.gs로 이 내용 붙여넣기
//   ②setupReviewedScanTrigger 실행(1시간 트리거 자동 등록) ③diagReviewAlerts 실행해
//   실제 알림메일이 검색되는지 확인. 배포 불필요(트리거 함수는 배포와 무관).
// 이름 매칭: 토큰 단위 전원 일치. 순서 무관("LEE, BUMRAE"="Bumrae Lee"),
//   발음기호 무시(Gugić=Gugic), 부분 문자열 불인정(Lee≠Leeds), 1자 토큰(이니셜) 제외.
//   확신 없으면 막지 않는 안전 기본값 — 익명 후기·표기 불일치는 후보 유지.

var REVIEW_ALERT_QUERY = '{subject:review subject:리뷰 subject:후기} from:booking.com newer_than:14d';

// 순수(테스트용): 이름 → 정규화 토큰. 소문자·발음기호 제거·비문자 분리·2자 미만(이니셜) 제거·정렬.
function normNameTokens_(name) {
  var s = String(name == null ? '' : name).toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {} // é→e, ć→c
  return s.replace(/[^a-z가-힣]+/g, ' ').split(' ')
    .filter(function (t) { return t.length >= 2; }).sort();
}
// 순수(테스트용): 알림메일 텍스트에 게스트 이름의 '전 토큰'이 단어 단위로 등장하는가.
function reviewAlertMatches_(mailText, guestName) {
  var toks = normNameTokens_(guestName);
  if (!toks.length) return false;
  var hay = ' ' + normNameTokens_(mailText).join(' ') + ' ';
  for (var i = 0; i < toks.length; i++) if (hay.indexOf(' ' + toks[i] + ' ') < 0) return false;
  return true;
}
// 순수(테스트용): 후기 탭 자동 건너뜀 판정 — 제안 상태 + 후기 작성 도장.
function reviewedAutoSkip_(q, s) {
  return !!(q && q.status === 'proposed' && s && s.reviewedAt);
}

// 매시간 트리거: ①알림메일 스캔 → guestScore에 reviewedAt 도장 ②proposed 후보 스윕 → 자동 건너뜀
function reviewedScanTick() {
  if (typeof _gmailStop !== 'undefined' && _gmailStop) return;
  var p = PropertiesService.getScriptProperties();
  var now = new Date().toISOString();
  var scores = fbGet('cs/guestScore') || {};

  // ① 알림메일 스캔 (처리한 스레드는 CS_REVIEWED_SEEN에 기록 — 14일 검색창 밖으로 빠지면 자연 소멸)
  var q = p.getProperty('CS_REVIEW_ALERT_QUERY') || REVIEW_ALERT_QUERY; // 실제 알림 제목이 다르면 속성으로 교체(diagReviewAlerts로 확인)
  var threads = gmSearch_(q, 0, 30);
  if (threads.length) {
    var seen = {}; try { seen = JSON.parse(p.getProperty('CS_REVIEWED_SEEN') || '{}'); } catch (e) {}
    var newSeen = {};
    for (var t = 0; t < threads.length; t++) {
      var tid = threads[t].getId();
      newSeen[tid] = 1;
      if (seen[tid]) continue;
      var msgs = gmGetMessages_(threads[t]);
      if (!msgs.length) { delete newSeen[tid]; continue; } // 예산 게이트로 못 읽은 스레드는 다음 시간에 재시도
      var text = '';
      for (var m = 0; m < msgs.length; m++) text += msgs[m].getSubject() + '\n' + msgs[m].getPlainBody() + '\n';
      var hit = 0;
      for (var key in scores) {
        var s = scores[key];
        if (!s || s.reviewedAt || !s.guest) continue;
        if (!reviewAlertMatches_(text, s.guest)) continue;
        s.reviewedAt = now; // 아래 스윕이 같은 run에서 보도록 메모리에도 반영
        fbUpdate('cs/guestScore/' + key, { reviewedAt: now, reviewedThread: tid });
        Logger.log('후기 작성 감지: ' + (s.guest || '?') + ' (' + key + ')');
        hit++;
      }
      if (!hit) Logger.log('후기 알림 매칭 없음(익명 후기 또는 이름 표기 차이): ' + msgs[0].getSubject());
    }
    p.setProperty('CS_REVIEWED_SEEN', JSON.stringify(newSeen));
  }

  // ② 스윕: 이미 후기 쓴 게스트의 proposed 후보 → 자동 건너뜀 (선별이 알림보다 먼저 돌았어도 여기서 정리)
  var queue = fbGet('cs/reviewQueue') || {};
  for (var k in queue) {
    if (!reviewedAutoSkip_(queue[k], scores[k])) continue;
    fbUpdate('cs/reviewQueue/' + k, { status: 'skipped', skippedReason: 'already_reviewed', skippedAt: now });
    Logger.log('후기 후보 자동 건너뜀(이미 작성): ' + ((scores[k] && scores[k].guest) || k));
  }
}

// 설치(1회 실행): reviewedScanTick 1시간 트리거 등록 — 재실행해도 중복 등록 안 됨.
function setupReviewedScanTrigger() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'reviewedScanTick') ScriptApp.deleteTrigger(ts[i]);
  }
  ScriptApp.newTrigger('reviewedScanTick').timeBased().everyHours(1).create();
  Logger.log('등록 완료: reviewedScanTick 1시간 트리거');
}

// 진단(수동 실행): 후기 알림메일이 실제로 어떤 제목·발신자로 오는지 + 이름 매칭 결과 확인.
function diagReviewAlerts() {
  var p = PropertiesService.getScriptProperties();
  var q = p.getProperty('CS_REVIEW_ALERT_QUERY') || REVIEW_ALERT_QUERY;
  Logger.log('검색 쿼리: ' + q);
  var threads = GmailApp.search(q, 0, 30);
  Logger.log('매치 스레드: ' + threads.length + '건');
  var scores = fbGet('cs/guestScore') || {};
  for (var t = 0; t < threads.length; t++) {
    var msg = threads[t].getMessages()[0];
    Logger.log(Utilities.formatDate(msg.getDate(), 'Asia/Seoul', 'MM-dd HH:mm') + ' | ' + msg.getFrom() + ' | ' + msg.getSubject());
    var text = msg.getSubject() + '\n' + msg.getPlainBody(), any = false;
    for (var key in scores) {
      var s = scores[key];
      if (s && s.guest && reviewAlertMatches_(text, s.guest)) { Logger.log('   ↳ 매칭: ' + s.guest + ' (' + key + ')' + (s.reviewedAt ? ' [이미 도장]' : '')); any = true; }
    }
    if (!any) Logger.log('   ↳ 매칭 없음');
  }
  Logger.log('판독: 스레드 0건=쿼리가 실제 알림메일과 안 맞음 → 받은편지함에서 후기 알림 제목 확인 후 스크립트 속성 CS_REVIEW_ALERT_QUERY 교체 / 매칭 없음=guestScore 이름 표기와 대조. 재스캔은 CS_REVIEWED_SEEN 속성 삭제.');
}
