# M1 — Clara 수동 작업 체크리스트

클코가 못 하는(권한/접근) 부분. 순서대로.

## GitHub (§0)
- [ ] `pwr-clair/cs` 레포 생성 (public). 이후 이 로컬 폴더를 remote 로 push.
      (클코 환경엔 `gh` 없음/org 인증 없음 → Clara가 생성하거나 `gh` 설치+인증 후 클코에 위임)

## GAS "PWR-CS-Engine" (§6 d~g)
- [ ] d. 새 GAS 프로젝트 "PWR-CS-Engine" 생성 → `gas/Code.gs` 내용 붙여넣기
- [ ] e. 프로젝트 설정 → 스크립트 속성 → `FB_AUTH` = (HK GAS와 **동일 값**)
- [ ] f. Gmail 필터: 부킹 호스트 알림메일 → 라벨 `CS/부킹` 자동 부여
- [ ] g. 트리거: `pollCsInbox` 를 **1분 시간 기반** 트리거로 추가
- [ ] (선택) `debugPeekLatest` 를 에디터에서 1회 실행 → 파싱 결과 로그 확인

## 클코에게 회신해야 넘어가는 확인 사항 (Code.gs 상단 ⚠️)
- [ ] **FB_BASE**: HK `Code.gs` 상단의 Firebase RTDB URL 을 그대로 복사해 전달
      (현재 `paradise-walk-residence-default-rtdb.firebaseio.com` 로 추정만 해둠)
- [ ] **HK fb 헬퍼 시그니처**: HK 의 fbGet/fbSet/fbUpdate/fbDelete 원본 붙여주면 100% 일치화
- [ ] **부킹 알림메일 실제 샘플 1건** (개인정보 마스킹 가능): 파싱 정규식 확정용

## M1 검증 (완료 조건 §6)
- [ ] ① 실제 부킹 알림메일 1건이 `cs/inbox/{msgId}` 에 정확 파싱 적재되는지
- [ ] ② 그 메일에 Gmail 회신 → 게스트 도달 1회 확인 (익스트라넷에서)
- [ ] ③ 알림메일에 호스트(익스트라넷) 답변이 포함되는지 → 결과를 클코에 회신 (M2 "이미 처리" 설계 반영)
