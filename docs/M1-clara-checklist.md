# M1 — Clara 수동 작업 체크리스트

클코가 못 하는(GAS 접근 권한) 부분만 남김. 순서대로.

## GitHub — ✅ 클코 처리 완료
- [x] `pwr-clair/cs` public 레포 생성 + 커밋 푸시 + Pages 활성화 (클코, 키체인 인증으로 처리)

## 확인 사항 — ✅ Fable 회신으로 전부 확정 (2026-07-04)
- [x] FB_BASE = `…-default-rtdb.asia-southeast1.firebasedatabase.app` (반영됨)
- [x] fb 헬퍼 = 클코 작성본 그대로 확정 ("동일 패턴"이면 됨, 코드 일치 불요)
- [x] 부킹 알림메일 구조 = 실물 3건 기준 파서 반영됨

## GAS "PWR-CS-Engine" — ⬜ Clara 몫 (§6 d~g)
- [ ] d. 새 GAS 프로젝트 "PWR-CS-Engine" 생성 → `gas/Code.gs` 내용 붙여넣기
- [ ] e. 프로젝트 설정 → 스크립트 속성 → `FB_AUTH` = (HK GAS와 **동일 값**)
- [ ] f. Gmail 필터: 부킹 호스트 알림메일(from `*@guest.booking.com`) → 라벨 `CS/부킹` 자동 부여
- [ ] g. 트리거: `pollCsInbox` 를 **1분 시간 기반** 트리거로 추가
- [ ] (권장) 먼저 `debugPeekLatest` 를 에디터에서 1회 실행 → 파싱 결과 로그 확인 후 트리거 켜기

## M1 검증 (완료 조건 §6) — ⬜ Clara 확인 후 클코에 회신
- [ ] ① 실제 부킹 알림메일 1건이 `cs/inbox/{msgId}` 에 정확 파싱 적재되는지 (bookingId 10자리·guest·message·lang)
- [ ] ② 그 메일에 Gmail 회신(→ `*@guest.booking.com`) → 게스트 도달 1회 확인 (익스트라넷에서)
- [ ] ③ **후속 메일에 호스트(익스트라넷) 답변이 full body로 인용되는지** 확인 → 결과를 클코에 회신
      (되면 M2 "이미 처리" 자동 마킹 구현 가능 — 스니펫만으론 미확정 상태)
