# 완료 보고 — CS 엔진 Gmail 저연비 재설계 (HK 쿼터 보호)

> 2026-07-07 / 클코 / 승인됨. 대상: PWR-CS-Engine `gas/Code.gs`만. HK 및 HK 레포 무변경.
> 배경: CS의 Gmail 대량 사용(1분 폴링+마이닝 ~201스레드)이 공유 구글 계정 일일 Gmail 쿼터를 소진 → 같은 계정 HK 자동발송 하루 마비. 최상위 원칙: **CS는 어떤 경우에도 HK의 Gmail 사용을 침해하지 않는다.**

## before → after
| 항목 | before | after |
|---|---|---|
| **예산 가드** | 없음 | CS의 **모든 Gmail 호출을 `budgetGate_` 래퍼 경유**. 일일 사용량 `CS_GMAIL_USED_<KST날짜>` 누적, 상한 `CS_GMAIL_BUDGET`(기본 150) 초과 시 **해당 run Gmail 작업 즉시 중단(예외 던지지 않음)**, 다음 날 새 날짜키로 자동 재개. 구글 실수치 하드코딩 안 함 |
| **트리거** | 1분 `pollCsInbox`(클라라가 이미 삭제) | 자동 설치 **없음**. `installCsTriggers()` 제공 — 기존 CS 프로젝트 트리거 전삭제 후 **5분 주기 `pollCsInbox` 1개만** 설치. **실행은 클라라 수동** |
| **폴링 저연비** | 매 run 최근 20스레드 조회 + 스레드별 `getLabels()`로 done 스킵 | **라벨 이동**: 처리 완료 스레드를 `CS_LABEL`에서 제거(+`CS_DONE_LABEL` 부여) → 매 run **미처리분만 조회**. 스레드별 `getLabels()` 제거. `ingestMessage_`의 fbGet 멱등 이중안전판 유지 |
| **마이닝** | 1회 실행에 최대 400스레드 전량 순회 | **재개형 배치**: 1회 `CS_MINE_BATCH`(기본 25)스레드, 진행 위치 `CS_MINE_CURSOR` 저장→재실행 시 이어서, 전량 완료 시 커서 제거 + `"MINING COMPLETE"` 로그. **트리거 없음, 클라라 수동** |
| **시트 임포트** | — | `importCorpusFromSheet`는 SpreadsheetApp만 사용, GmailApp 호출 없음 → 예산 영향 N/A(주석 명시) |

- 카운팅 단위: Gmail 서버 호출(getLabel/createLabel/getThreads/search/getMessages/addLabel/removeLabel)당 1. 메시지 getter(getFrom/getSubject/getPlainBody 등)는 이미 fetch된 메시지에서 읽으므로 별도 카운트 안 함.

## 검증
- ✅ **순수 로직 JXA 테스트 PASS**:
  - `budgetAllows_` 경계(149/150 허용, 150/150 차단, n>잔여 차단).
  - **카운터 증가·차단 시퀀스**: used 148→149→150 후 3번째 호출 차단, 차단 호출은 **미증가**, 이후 계속 차단(stop 플래그).
  - `miningOutcome_`: 배치 전진(cursor+processed)·전량완료(cursor=null)·예산소진 부분처리(partial, cursor 저장).
- ✅ **brace balance 151/151**.
- ✅ **Gmail 호출 전수 감사**: 모든 `GmailApp.*` 및 스레드 Gmail 메서드가 `gm*_` 래퍼(예산 게이트) 내부에만 존재. 래퍼 밖 원시 Gmail 호출 **0건**. (미사용 `threadHasLabel_` 제거로 예산 밖 getLabels도 제거.)
- ✅ 트리거 자동 설치 없음(`installCsTriggers`는 함수일 뿐 자동 호출 없음). 마이닝 트리거 없음.
- ⏸️ **오늘 GAS에서 Gmail 테스트 실행 안 함**(쿼터 미복구 — 지시 준수). 런타임 검증은 쿼터 복구 후 클라라 몫.

## 클라라 실행 순서 (쿼터 복구 후)
1. **HK 자동발송 정상화(쿼터 회복) 확인** 후 진행.
2. 레포의 새 `gas/Code.gs` 전체를 PWR-CS-Engine에 덮어붙이기.
3. (선택) 스크립트 속성 조정: `CS_GMAIL_BUDGET`(기본 150, 더 보수적이면 낮게), `CS_MINE_BATCH`(기본 25). 자동 생성되는 `CS_GMAIL_USED_<날짜>`·`CS_MINE_CURSOR`는 건드릴 필요 없음.
4. **`installCsTriggers()` 1회 실행** → 5분 폴링 재개(이게 유일한 CS 트리거).
5. **마이닝**: `mineCorpusFromGmail()`을 반복 실행(1회 25스레드). 로그의 `cursor` 진행 확인, **`MINING COMPLETE`** 뜰 때까지. 예산 소진 로그가 뜨면 그날은 중단하고 다음 날 이어서 실행.
6. **`importCorpusFromSheet()`** 1회(시트 소스, Gmail 무관 — 아무 때나).

## 배포
- 이 커밋은 `gas/**`·`docs/**` 변경 → Pages 경로 필터에 안 걸림 → **Deploy Pages 미트리거가 정상**. 검증은 `push 성공(SHA==HEAD)`만.

## 제안
- 폴링을 더 아끼려면 `CS_GMAIL_BUDGET`를 낮춰 CS 몫을 명시적으로 제한(HK에 더 큰 여유). 최적치는 쿼터 복구 후 실사용 관찰로 결정 권장.
