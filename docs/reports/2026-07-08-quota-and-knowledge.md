# 통합 v2 — 쿼터 보호 2건 + 초안 지식·재료 보강 (A~D)

- 날짜: 2026-07-08
- 대상: `gas/Code.gs` (PWR-CS-Engine) — GAS 전용, Pages 미트리거
- 커밋: `feat(cs): quota guards + guide facts in prompt + backlog questions to sheet`
- 순수 로직 테스트: **A 16/0 · B·C·D 23/0 = 총 39 PASS** (jsc, 스크래치패드)
- 원칙 준수: 발송 워커·예산 가드·파서 v2·dismiss 로직 **미변경**(명시 지점 외), 시트 기존 행 무접촉.

## 반영 위치 (A~D)
| 항목 | 함수/위치 | 요지 |
|---|---|---|
| **A** urlfetch 쿨다운 | `csFetch_`(모든 fetch 6곳 경유), `isUrlfetchExhausted_`/`cooldownUntilIso_`/`inCooldown_`(순수), `enterUrlfetchCooldown_`/`urlfetchCooldownActive_`, `pollCsInbox` 시작부 게이트 | 소진 예외 감지 시 `CS_URLFETCH_COOLDOWN_UNTIL=now+60분` 기록·로그, 같은 run 이후 fetch 차단. 자동 run은 쿨다운 중 즉시 skip(Gmail 미접촉), 만료 시 속성 제거. 수동 함수는 게이트 미호출 → 무시하고 시도 |
| **B** 백로그 컷오프 | `cutoffMs_`/`isBeforeCutoff_`(순수), `pollCsInbox` 스레드 루프 | `CS_CUTOFF`(ISO) 이전 스레드 최신 메시지는 적재·초안 없이 라벨만 이동(Gmail만, urlfetch 미사용). 로그 "컷오프 이전 — 초안 스킵: N건". 미설정 시 `cutoffMs_=null` → 현행 동작 |
| **C** 가이드 팩트 | `CLARA_SYSTEM` [숙소 확정 정보] 블록 | guide 원문 발췌·압축(아래 대조표). 관련 문의엔 팩트로 직접 답하고 https://pwr-guide.online 안내 권장 |
| **D** 백로그 질문 적재 | `exportBacklogQuestionsToSheet`(신설, 수동), `normQ_`/`isTrivialMessage_`(순수), `importCorpusFromSheet` 수정 | cs/drafts(dismissed 포함) 질문 → CS-DB 시트 **말단 append**([A=lang,B=질문,C=빈칸,D=category]). import는 clara_reply 빈 행 스킵(마킹 안 함) → 나중 채우면 흡수 |

## C 팩트 대조표 (CLARA_SYSTEM ↔ guide 라이브 원문)
| 팩트 | guide 원문(pwr-guide.online) | 프롬프트 반영 | 일치 |
|---|---|---|---|
| 셔틀 T1 | 3F **Gate 3 or 12** → **Bus No.03** → **Grand Hyatt Hotel**(1st stop) | 3층 3·12번 게이트→03번(AICC)→Grand Hyatt(T1 첫 정류장) | ✅ |
| 셔틀 T2 | 3F **Gate 7** → Bus No.03 → Grand Hyatt(4th stop) | 3층 7번 게이트→03번→Grand Hyatt(T2 4번째) | ✅ |
| 공항 복귀 | **Bus No.04**, T1 **~5 min**, T2 **~25 min** | 04번 버스, T1 약 5분·T2 약 25분 | ✅ |
| 체크인/아웃 | **From 3:00 PM** / **By 11:00 AM** | 15:00부터 / 11:00까지 | ✅ |
| 짐 보관 | no storage before check-in/after check-out | 체크인 전·체크아웃 후 불가 | ✅ |
| Wi-Fi | sticker at the **end of the TV cabinet** | TV 서랍장 끝 스티커 | ✅ |
| 주차 | first 20 min **₩1,000**, then **₩1,000 per 30 min**, daily max **₩50,000**, no free parking | 첫 20분 ₩1,000·이후 30분당 ₩1,000·일 최대 ₩50,000·무료 불가 | ✅ |
| 하우스룰 | Strictly non-smoking(cleaning fee)/Max 2 guests/No pets/No parties/Don't open door to unannounced visitors | 금연(청소비)/최대2인/반려동물 불가/파티·소음 금지/미확인 방문자 문 열지말것 | ✅ |
| 도어코드 | room number & door code via booking platform's message (privacy/safety) | 개인정보·안전 위해 예약 플랫폼 메시지로만 도착 당일 발송 | ✅ |
| 문의 | WhatsApp **+82 10-8227-2845**, LINE·WeChat **pwresi**, **09:00–21:00 KST** | 동일 | ✅ |

창작 없음 — 프롬프트에 없는 세부는 "확인 후 안내" 기존 규칙 유지.

## D 멱등·흡수 설계 (테스트로 검증)
- **export 멱등**: 기존 시트 B열(guest_message) 정규화값을 seen에 시드 → 재실행·기존 코퍼스 중복 방지. 배치 내 중복은 대표 1개. 단순 인사/감사(`isTrivialMessage_`) 제외. 말단 블록 append만(기존 행 무접촉).
- **import 함정 해소(핵심)**: 기존 멱등은 `id='sheet_'+행번호`(행 위치 기반). 종전엔 질문만 있고 답변 빈 행도 corpus에 적재+마킹 → 나중에 답 채워도 스킵되어 **영영 미흡수**였음. → `if(!ans) 스킵(마킹 안 함)`으로 수정. 시나리오 테스트 PASS: 빈답변 행 skip→답 채움→흡수→재실행 skip-dup. (전제: export가 말단 append만 하므로 행 위치 불변)

## 클라라 실행 순서
1. **Code.gs 재붙여넣기 1회** (A·B·C·D 전부 포함) — PWR-CS-Engine.
2. **A/C는 자동 적용**(쿨다운 가드·프롬프트 팩트) — 별도 실행 없음.
3. **B 컷오프 켜기(선택)**: Script Properties `CS_CUTOFF` = ISO 날짜(예: `2026-07-08`) 설정. 그 이전 게스트 수신 스레드는 초안 없이 라벨만 이동. 끄려면 속성 삭제. ※ 바 없는 날짜는 UTC 자정 기준 — KST 정밀 컷이 필요하면 `2026-07-08T00:00:00+09:00` 형식 사용.
4. **D 코퍼스 재료화**: `exportBacklogQuestionsToSheet()` 1회 실행 → CS-DB 시트 말단에 질문 행 추가 → 클라라가 **clara_reply(C열)만** 채움 → `importCorpusFromSheet()` 실행하면 답 채운 행만 흡수(빈 행은 "답변 미기입 스킵" 로그). 답을 나눠 채우고 여러 번 재실행해도 안전.

## 미결/유의
- `CS_CUTOFF` 바 없는 날짜의 시간대(UTC) 해석은 위 3에 명시. 필요 시 KST 오프셋 사용.
- export의 "유사" 중복은 **정규화 완전일치**만 제거(보수적) — 표현이 다른 근접 중복은 둘 다 남을 수 있음(질문 유실 방지 우선). 클라라가 시트에서 취사 가능.
- 순수 로직 테스트는 스크래치패드 실행(레포 미커밋). 원할 시 `tests/`로 커밋 가능.
