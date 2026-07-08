# tests/ — 순수 로직 검증

GAS(`gas/Code.gs`)·승인앱(`index.html`)의 **순수 함수**를 브라우저/GAS 없이 검증한다.
각 파일은 대상 코드와 **동일 구현을 미러**한 뒤 어서션을 돌린다(외부 의존 없음).

## 실행 (macOS, node 불필요 — JavaScriptCore 사용)
```sh
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
"$JSC" tests/cs-desk-dismiss-sort.test.js
"$JSC" tests/urlfetch-cooldown.test.js
"$JSC" tests/quota-knowledge.test.js
```
또는 `sh tests/run.sh` (전부 실행, 각 파일 끝에 "N PASS / M FAIL" 출력).
node가 있으면 `node <file>`로도 동작(순수 JS).

## 파일 ↔ 대상
| 테스트 | 대상(Code.gs / index.html) | 커버 |
|---|---|---|
| `cs-desk-dismiss-sort.test.js` | 승인앱 dismiss/정렬 (`msgTimeMs`·`kstDayStartMs`·`waitCmpDesc`·inflight/actionable) | dismiss 상태 전이·일괄 기준(0시 KST)·수신시각 정렬 |
| `urlfetch-cooldown.test.js` | A 쿨다운 (`isUrlfetchExhausted_`·`cooldownUntilIso_`·`inCooldown_`) | 소진 감지·기록→스킵→만료 해제·수동 무시 |
| `quota-knowledge.test.js` | B/D (`cutoffMs_`·`isBeforeCutoff_`·`normQ_`·`isTrivialMessage_`) | 컷오프·질문 정규화/중복/멱등·빈답변 스킵→나중 흡수 |
| `urlfetch-meter.test.js` | urlfetch 계기판 (`fetchUsedKeyFor_`·`incCounter_`·`budgetSnapshot_`) | 일일 카운터 증가·날짜 롤오버·미러 fetchUsed 필드 |

> 미러 방식이라 대상 코드 수정 시 해당 테스트의 함수 정의도 같이 맞춰야 한다.
