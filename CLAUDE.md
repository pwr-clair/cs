# PWR CS 자동화 — 클로드코드 인수인계 패키지 (전체)
> 2026-07-04 / 발주: Clara / 기획: Fable(챗 세션)
> 지금부터 CS 프로젝트의 코드 작성·실행·커밋·배포는 전부 클코 담당.
> 기획·설계 판단·지시문·검증은 Fable(챗) 담당. 설계 변경이 필요해 보이면
> 구현하지 말고 질문으로 회신할 것 (지난주 HK에서 즉석 A/B 재설계로 크게 꼬인 전례 있음).

## ⚡ 열쇠 프로토콜 (2026-07-12 — 최우선, 시스템 전역 정본 = pwr-clair/pwr-docs/PWR_MASTER.md)
- 클라라가 **`0917`** 입력 → **시작 리추얼**: ①pwr-clair/pwr-docs를 스크래치패드에 clone(최신) ②Notion 미러(PWR_MASTER, page 397b9d1f-a416-81f8-8e12-eeccfdefc21b) 헤더 "최종 갱신" 날짜와 레포 헤더를 비교, **더 최신인 쪽을 정본으로 양쪽 동기화**(역동기화 포함) ③PWR_MASTER 기준 현재 상태·다음 액션(B1)·오늘 아젠다를 짧게 브리핑하고 대기.
- 클라라가 **"오늘은 여기까지"** 입력 → **마감 리추얼 한 세트**: ①PWR_MASTER Part B 제자리 갱신(헤더 최종 갱신 시각 필수) ②status-board.html **DATA 블록** 갱신(완료 todo 삭제, meta.updated) ③`~/Documents/status-board.html` 복사 ④pwr-docs 커밋·푸시 + **HEAD==origin 확인** ⑤Notion 미러 동기화 ⑥완료 보고(증거 포함).
- 이 프로토콜은 이 문서의 다른 내용보다 우선한다. 아래 본문은 CS 프로젝트 인수인계(2026-07-04 기준)로, 최신 상태와 어긋나면 PWR_MASTER가 정본.

## 0. 첫 액션 (순서대로)
1. GitHub에 새 레포 `pwr-clair/cs` 생성 (public, GitHub Pages 사용 예정)
2. 이 문서 전체를 레포 루트 `CLAUDE.md`로 커밋 — 이후 모든 세션은 이 파일부터 읽는다
3. Clara가 전달하는 `cs_mockup_v0.3.html`을 `/design/`에 커밋 (UI 기준안)
4. 아래 §6 M1 착수

## 1. 프로젝트 한 줄 정의
OTA(부킹/아고다/익스피디아) 게스트 메시지 → 클라라 말투로 답변 초안 생성 →
승인(또는 야간 자동) 발송. 클라라의 실제 답변을 계속 학습해 점점 클라라처럼 대답하는 시스템.

## 2. 포지셔닝 (이유까지 — 재논쟁 금지)
- OTA 알림메일 자체가 3~10분 지연됨 (클라라 실측). 속도 경쟁은 구조적으로 불가능.
- 가치 = 커버리지: 클라라가 자거나 부재중일 때 5~10분 뒤에라도 답이 나가는 것.
  킬러 유스케이스 = 야간·부재 자동 응대.
- 낮에 클라라가 익스트라넷에서 먼저 답한 건 → 앱에서 "이미 처리" 원탭 스킵.

## 3. 확정 설계 (클라라 결정 — 변경 금지)
- 완전 분리: 레포 pwr-clair/cs + GAS 신규 프로젝트 "PWR-CS-Engine" + 별도 html.
  HK(housekeeping)와는 버튼+뱃지 하나로만 연결. HK의 app/* 네임스페이스 쓰기 금지
  (suggestions 승인 반영 제외).
- 학습 중심: 템플릿 선택이 아니라 클라라 답변 코퍼스 검색+few-shot (파인튜닝 아님).
  학습 루프: 무수정 승인=정답 적재 / 수정 후 발송=(초안,수정본) 쌍 저장 ← 핵심 연료.
  지표: 무수정 승인율 — 승인앱 상시 표시, 자동발송 켤 타이밍의 객관 근거.
- 발송: 전건 승인 시작. autoSend 토글 ON = 야간창(00:00–08:00 KST) 내 전건 즉시
  자동발송, 승인 큐 없음(완전 자동). 그 외 시간은 승인. '영구 승인 카테고리' 없음.
  confidence 안전판은 보류 — 무수정 승인율 상승 후 재논의 (지금 넣지 말 것).
- 번역: 게스트 언어로 직접 생성 + 한국어 대역 병기. 영어 외 모든 언어에
  번역 면책 문구 자동 첨부.
- 업무(태스크): 답변 속 약속 중 기존 자동화(HK의 s1~s6 메일)가 커버하지 않는 것만
  업무화. 단 절대 금지가 아님 — 커버되더라도 부연·개별 안내가 필요하면 업무화.
  원칙은 최~소화.
- HK 연결: ETA·특별요청 감지 → cs/suggestions → 승인 시 HK에 반영.
  후기요청: 감성 긍정+소통 원활 게스트만, 체크아웃 익일, 토글 따라 자동/승인.
- UI: /design/cs_mockup_v0.3.html이 기준 (아이보리 라이트+전광판 다크, Pretendard+
  Space Grotesk, 탭: 대기/업무/제안/후기/보냄, 자동응대 스위치+야간창, 승인율 게이지).
  v0.4(컬러 배경 시안)는 M1과 병렬 — 시안 제작은 클코, 채택 판단은 Clara/Fable.

## 4. 아키텍처
OTA 알림메일 → Gmail(라벨/필터) → GAS 1분 폴링 → 파싱 → Firebase cs/inbox
→ Claude API 초안(코퍼스 few-shot) → cs/drafts (+폰 푸시, 채널 미확정: 텔레그램 추천)
→ 승인 웹앱(이 레포, GitHub Pages, 모바일 우선, 기존 Firebase Auth 재사용)
→ [승인 or 야간 자동] → Gmail 회신 발송 → cs/sent
- Firebase: 기존 프로젝트 paradise-walk-residence 공유, cs/* 네임스페이스만 사용.
- 발송 도달성: OTA 알림메일의 회신 경로로 게스트 도달 확실(클라라 확인). M1에서 1회만 재확인.
- GAS 명명: HK GAS = PWR-HK-Engine (구 ParadiseWalk-CS, 2026-07-04 개명). CS GAS = PWR-CS-Engine.
  과거 문서에 ParadiseWalk-CS로 표기된 것은 전부 HK 쪽을 가리킴.
- CS 엔진 실행 계정: **paradisewalkresidence@gmail.com** (부킹 알림 실수신 계정, 2026-07-07 이사).
  joi.hurricane 쪽 구 프로젝트는 트리거 없는 폐가. **HK와 Gmail 쿼터 완전 분리됨** (다른 계정).
  코드는 계정 무관이라 이사로 인한 코드 변경은 없음. Gmail 예산 가드(CS_GMAIL_BUDGET)는 여전히 유효(CS 자체 상한).

## 5. cs/ 네임스페이스
cs/
  inbox/{msgId}     : source, bookingId, guest, lang, receivedAt, raw, parsed
  drafts/{msgId}    : reply, replyKo, category, confidence, status, editedReply
  sent/{msgId}      : 원문+최종답변+승인자+시각
  corpus/{id}       : 상황요약, 최종답변, lang, origin(구축/수정쌍/승인)
  tasks/{id}        : title, due, bookingId, source, status
  suggestions/{bid} : checkinTime?, specialRequests[], status
  guestScore/{bid}  : sentiment, msgCount, lastAt
  reviewQueue/{bid} : due, status
  config/           : autoSend(false), nightWindow("00-08"), notifyChannel

## 6. M1 — 수신 증명 (지금 착수할 범위)
클코 몫:
  a. 레포 셋업(§0) + GAS용 Code.gs를 레포 /gas/Code.gs 로 작성·버전관리
     (주의: 클코 환경에서 script.google.com 접근 불가 확인됨 → 코드는 레포에 두고
      Clara가 GAS 에디터에 붙여넣는 방식. clasp 사용 가능하면 제안만 하고 강행 금지)
  b. Code.gs 내용: Gmail 라벨("CS/부킹") 검색 폴링(1분 트리거용 함수) → 부킹 알림메일
     파싱(게스트명, bookingId, 메시지 본문, 수신시각, 언어 추정) → Firebase cs/inbox 적재.
     Firebase 접근은 HK GAS와 동일 패턴: fbGet/fbSet/fbUpdate/fbDelete 4함수 + ?auth=
     (DB secret은 스크립트 속성 FB_AUTH에서만 읽기 — 코드·레포·채팅에 절대 넣지 말 것)
  c. 파싱 실패 시 cs/inbox에 raw만이라도 적재(파싱실패 플래그) — 메일 유실 금지
Clara 수동 몫 (체크리스트로 안내할 것):
  d. GAS 신규 프로젝트 "PWR-CS-Engine" 생성 + Code.gs 붙여넣기
  e. 스크립트 속성 FB_AUTH 등록 (HK GAS와 동일 값)
  f. Gmail 필터: 부킹 알림메일 → 라벨 "CS/부킹" 자동 부여
  g. 1분 시간트리거 설정
M1 검증 (완료 조건):
  ①실제 부킹 알림메일 1건이 cs/inbox에 정확 파싱되어 적재
  ②그 메일에 Gmail 회신 → 게스트 도달 1회 확인 (Clara가 익스트라넷에서 확인)
  ③알림메일에 호스트(익스트라넷) 답변이 포함되는지 확인 — 포함되면
    "이미 처리" 자동 마킹이 가능해지므로 M2 설계에 반영 (보고서에 결과 명시)

## 7. 로드맵 (M1 이후 — 착수 전 Fable 지시문 대기)
- M2: 코퍼스 구축(CS-DB 시트 1JHbIEJ9XX1Pxp0JPPgQmJ-1xWI7e5fKtrws4x-iCcJg 임포트
  + Gmail 과거 스레드 마이닝) + Claude API 초안 생성 + 승인 웹앱 + 푸시 + 승인 발송
- M3: 아고다·익스피디아 확장 + suggestions + 업무 탭 + HK 버튼·뱃지
- M4: autoSend(야간창) + 후기요청 + 승인율 지표

## 8. 작업 규칙 (전 세션 공통)
- 모든 커밋: push 후 배포 초록 + pages_build_version이 해당 커밋 SHA인지까지 확인
  (7/4 HK에서 Pages coalescing으로 옛 버전이 배포된 사고 있었음)
- 시크릿(FB_AUTH, API키, 봇토큰): GAS 스크립트 속성에만. 레포·채팅 금지.
- 지시문 범위 밖 개선 아이디어: 코드에 넣지 말고 완료 보고의 '제안' 섹션에만.
- 완료 보고 형식: 수정 지점 before/after 요지 + 검증 결과 + 배포 결과 + 제안.
- 미결정 사항(푸시 채널, Gmail 마이닝 범위)은 임의 결정 금지 — 질문 회신.
- 클라라 복붙 반영물(GAS 등, 2026-07-14 지시): ①채팅에 바로 복붙 가능하게 주거나
  ②정확한 원클릭 URL(예: raw.githubusercontent.com 파일 링크)만 줄 것.
  "레포 가서 파일 열고 복사해서…" 식 다단계 안내 금지.
  배포 절차는 클라라가 숙지 — "배포까지 하세요" 한 줄이면 충분, 단계 나열 불필요.
  (CS GAS raw: https://raw.githubusercontent.com/pwr-clair/cs/main/gas/Code.gs)

## 9. 미결정 잔여 (임의 결정 금지 — Fable 회송)
- **부킹 예약번호 ↔ Sirvoy 매핑 (M2 과제)**: 부킹 알림메일의 예약번호는 부킹 원번호(10자리)로,
  Firebase의 Sirvoy 내부번호(5자리)와 다르다. M1은 원번호를 그대로 `cs/inbox.bookingId`에 적재.
  M2에서 원번호↔Sirvoy번호 매핑 방식을 설계할 것.
- 푸시 채널: 텔레그램 봇(추천) vs 웹푸시 — M2 전 결정.
- Gmail 마이닝 범위: 전체 vs 최근 N개월 — M2 전 결정.
- confidence 안전판: 보류 (무수정 승인율 상승 후 재논의).
- (참조) 상세 설계 원본: `PWR_CS자동화_설계확정본_v3_2026-07-04.md` (v3, 이 문서의 상위 소스).
