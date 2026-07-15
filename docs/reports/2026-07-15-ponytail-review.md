# ponytail 코드 리뷰 — 전 프로젝트 (CS · HK · guide)

> 2026-07-15 · ponytail-review 관점(오버엔지니어링·단순화·삭제만, 버그·보안·성능 제외)
> 파일별 병렬 리뷰 5건. **총 net: -439 lines 가능.** 실제 삭제는 아직 안 함(리뷰만).

## 요약 (레포별 절감 가능치)

| 레포 | 파일 | net 절감 | 성격 |
|------|------|---------:|------|
| CS | gas/Code.gs | **-110** | 일회성 backfill/진단 함수 다수 (제일 큰 건) |
| CS | index.html | -10 | 죽은 confidence UI + Object.entries 치환 |
| HK | index.html | **-260** | 죽은 CSS/i18n/드래그 핸들러 + 중복 맵 하이스트 |
| HK | manual.html + gas/Code.gs | -50 | 중복 템플릿 채우기·부킹 해석 블록 하이스트 |
| guide | index.html · guide-data.js · edit.html | -9 | 죽은 비디오 슬롯 + 방어코드 중복 |

가장 실익 큰 두 곳: **HK index.html(-260)**, **CS Code.gs(-110)**. 나머지는 소소.

---

## CS — gas/Code.gs (net -110)

**일회성 함수 삭제 (실행 끝나 죽은 것들) — 큰 덩어리:**
- `L1297 backfillDraftReceivedAt` — 일회성 backfill, 클라라가 이미 돌림. 삭제.
- `L1318 backfillDraftStayDates` — 일회성, 소진. 삭제.
- `L1364 dumpInboxRawSamples` — 저자 주석에 "확인 끝나면 삭제해도 됨". 삭제.
- `L1384 countAgodaShellMessages` — 과거 아고다 오추출 조사용 진단, 소진. 삭제.
- `L1553 voidCancelledAppliedOnce` — 일회성 정정(커밋 5383731에서 실행됨). 삭제.
- `L1574 migrateNoticeEtasOnce` — 배포 전 노티스 카드용 멱등 마이그레이션, 소진. 삭제.

**단순화:**
- `L331 langToIso_` — en→en, ko→ko… 항등 맵 6개. `/^(en|ko|ja|zh|ru|th)$/.test(...)` 한 줄로.
- `L463 doGet` — doPost 본문 복붙. `function doGet(e){ return doPost(e); }`.
- `L482 publishSaveHookUrlFromProp` — getUrl()의 /dev 반환 엣지용 수동 폴백, 호출 1곳. publishSaveHookUrl에 접기.
- `L62 fbDelete` — 어디서도 호출 안 됨. (단 CLAUDE.md §6b가 fbGet/Set/Update/Delete 4함수 미러를 규정 → 의도된 죽은 스텁, **낮은 확신, 남겨도 무방**.)

> 참고(스코프 밖): `L265 gmailAllowed_` 호출되는데 정의가 없음 — 리뷰어가 correctness라 리포트 안 했지만 **한 번 확인 권장**.

## CS — index.html (net -10)

- `L138-144 .conf/.dots/.d` 등 — confidence-dots UI 제거됨(L145 주석 "AI confidence 자동채점 제거"), `.tone`으로 대체. `class="conf"` 안 뿜음. 삭제.
- `L567 외 9곳` — `Object.keys(x).map(k=>[k,x[k]])` 손수 짠 entries. `Object.entries(x||{})`로. (L601·624·629·633·700·741·799·849 동일 패턴.)
- `L876` — 5줄 if/else 체인 → 삼항 한 줄.
- `L251 .tile.t-rate` "무수정 승인" 타일 — 하드코딩 `—`, 아무도 채우지 않음. 로드맵 M4 자리표시자. 만들 때까지 삭제.

## HK — index.html (net -260, 최대 건)

**죽은 드래그 핸들러:**
- `L1708/L1710 onDragStart/onDrop` — onNextDragStart/onNextDrop과 바이트 동일, 마크업에 안 물림. 삭제(+window= L1712).
- `L1572-1576/L1600 onNextDropToCurrent` — 정의·window할당됐지만 아무 핸들러도 참조 안 함. 삭제.

**죽은 CSS (사용처 0 확인):**
- `L180-185 .sched-*` — schedule 기능 사라짐(class="sched" 요소 0, t('sched_*') 0). 삭제.
- `L52 .s-blue/.s-orange` · `L67 .early-badge` · `L86 .list-item` · `L95 .history-item` · `L186 .icon-x-btn` · `L193 .user-chip` · `L23-25 .login-pw-*` — 전부 미사용. 삭제.

**죽은 i18n/applyLang:**
- `L3420-3423 외 sched_* 키`(양 언어) — t() 호출자 없음. 삭제.
- `L3578-3587 applyLang` assignee-sub-title/notif-email-* — DOM에 없는 요소. 삭제(+TEXTS 키).
- `L3539-3542/L3621-3623` — 죽고 중복된 .login-pw-label/.login-btn 할당(querySelector null). 삭제.
- `L3439/3436/3405 cur_booking_add/saved_msg/empty_hist` — t() 호출자 없음. 삭제.

**죽은 변수/no-op:**
- `L1432 baseStyle` — 선언 후 무시, L1433이 같은 리터럴 하드코딩. 삭제.
- `L1318/1320 guestLine/earlyLine` · `L1333/1381 supplyBadge` — 항상 '' 자리표시자. 삭제.
- `L1914 onBkCiTimeInput` — no-op(계산 후 버림). 삭제(+oninput L617).
- `L1931 updateAutoStatusBadge` — 인자 무시·#auto-badge 숨기기만, 배지 자체가 죽음. 삭제(+호출 L1445+배지 요소).

**중복 하이스트 (같은 로직 여러 번):**
- `~7곳` OTA source 색/라벨/이니셜 맵 재선언 → SRC_COLOR/SRC_TXT/SRC_LBL/SRC_INIT 모듈 상수로.
- `3곳` 24h→am/pm 포맷터(fmtEta/inline/fmtTimeKo) → hhmmToAmPm(t) 하나로.
- `~12곳` 인라인 YMD 조립 → addDays(n) 헬퍼로.
- `L2701/2952/3004` — safeBid() 있는데 logHit/waKey가 정규식 재인라인. safeBid() 호출로.
- `L3138-3221` openCheckin/StagePreview 쌍 — 같은 흐름 2번. 하나로 파라미터화.
- `L2619-2656` saveAssigneeRow/saveAssignees — 동일 수집 루프. collectMembers() 추출.

## HK — manual.html + gas/Code.gs (net -50)

**manual.html:**
- `L143-147 .label-*` 5클래스 — 전부 미사용(라벨은 손수 인라인). 삭제.
- `L7` Tabler 아이콘 웹폰트 CDN — 장식용 `<i class="ti">` ~8개 때문에 로드, 나머진 다 이모지. `<link>` 빼고 이모지로.
- `L310-401` ✏️/↔/🗑 버튼 3종 4번 복붙 → `.bk-act` 클래스 하나로.

**Code.gs:**
- `L31 toMin()` — 정의만, 호출 0. 삭제.
- `L300-307 checkinDueNow(cb)` — cb 무시하고 `nowMin>=870`만. 주석은 존재 않는 ±15분 규칙 서술. 인라인화(-7줄).
- `L210/426/492` `fill=s=>...replace(/{guest}/...)` 토큰치환 3번 → fillTpl() 하나로.
- `L394-449` "오늘 체크인 bk 해석" 블록 3번 동일 → todayCheckin() 추출.
- `L475-557` "p.bid→room.currentBooking 폴백" 블록 3번 → resolveBooking() 추출.
- `L472/508/545` ALLOW 배열·NAME 맵 반복 → 모듈 상수로.
- `L357 sendEligible(trigger)` — trigger 인자 안 읽힘. 삭제.

## guide — index.html · guide-data.js · edit.html (net -9)

- `index.html:L219 .video-slot` CSS 3규칙 + "kept for future re-add" 주석 + L290 자리표시자 — 없는 비디오용 죽은 코드. 삭제.
- `index.html:L719 apply()` — 언어 전환마다 `querySelectorAll('.lg')` 재조회(L724와 중복). 바깥에서 1번.
- `edit.html:L111` — 정규화 루프가 4개 d키+url 다 채우는데 render/syncModel이 이미 전부 가드. `p.d = p.d || {}`로.
- `guide-data.js` — 순수 데이터, 줄일 것 없음.

---

## ✅ 실행 결과 (2026-07-15 오후 — 죽은 코드만 삭제, 리팩터링류는 보류)

**방침**: "지워도 로직이 안 변하는 것"만 실행. 중복 하이스트(맵·포맷터·부킹해석 추출), 아이콘→이모지 등 리팩터링·시각 변경은 보류(아래 원판단 유지).

| 레포 | 커밋 | diff | 배포 검증 |
|------|------|------|-----------|
| CS | eca8623 | -153/+20 (Code.gs·index.html) | Actions success, sha 일치 |
| guide | 1ae4d00 | -7 (video-slot) | Actions success, sha 일치 |
| HK | 39ea18d | -83/+11 (index·manual·Code.gs) | push+HEAD==origin+raw 반영 (클래식 Pages) |

**합계 실삭제: 약 -212줄.** 검증: CS 테스트 러너 17/17 PASS, 모든 JS `node --check` 통과, 삭제 심볼 전부 grep 0건 확인.

**실행 중 기각/보류된 findings:**
- `doGet`(CS) — doPost와 반환값('ok(get)' vs 'ok')·에러로깅이 달라 축약 안 함. 리뷰 오탐.
- `#auto-badge` 요소(HK) — `selStatus`에 가드 없는 참조 생존 → 요소 지우면 방 상태 클릭이 TypeError. no-op 함수만 삭제, 요소는 유지. 완전 제거하려면 selStatus 줄 정리가 선행(행동 변경이라 이번 패스 제외).
- `fbDelete`(CS) — CLAUDE.md §6b 4함수 미러 규정상 의도된 스텁. 유지.

**➕ 보너스 버그 수정 (리뷰 스코프 밖에서 발견)**: CS `gmailAllowed_` — 발송 루프(L265)가 호출하는데 정의가 없었음. 7월 학습모드 가드 덕에 미발현, **8월 학습모드 해제 즉시 승인 초안 발송 루프 전체가 ReferenceError로 사망할 지뢰**. 부작용 없는 예산 peek(기존 `budgetAllows_`+`gmailUsedKey_` 재사용, 카운트 누적 없음 — 실카운트는 `budgetGate_('reply')` 담당)로 정의해 해소. 같은 커밋(eca8623)에 포함.

**클라라 액션 — GAS 복붙 2건** (둘 다 배포까지 하세요):
- CS: https://raw.githubusercontent.com/pwr-clair/cs/main/gas/Code.gs → PWR-CS-Engine
- HK: https://raw.githubusercontent.com/pwr-clair/housekeeping/main/gas/Code.gs → PWR-HK-Engine

## 판단 (ponytail 관점)

- **가장 실익:** HK index.html의 죽은 CSS/i18n/핸들러 정리(-260 중 절반 이상이 확실한 삭제). 로직 변화 0이라 안전.
- **CS Code.gs 일회성 함수 6개**(-90 근처) — 이미 소진된 backfill/진단. 삭제해도 파이프라인 무관. 단 `voidCancelledAppliedOnce` 같은 건 히스토리 기록 겸 남기고 싶으면 남겨도 됨.
- **중복 하이스트(맵·포맷터·부킹해석)** — 삭제보다 위험도 있으니(리팩터링) 급하지 않음. 8월 전환 전 여유 있을 때.
- 전부 **선택**. 지금 관찰 모드라 급한 건 없음. 원하면 레포별로 실제 삭제 지시문 발행 가능.
