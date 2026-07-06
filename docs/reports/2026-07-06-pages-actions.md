# 완료 보고 — Pages 배포 Actions 소스 전환 (A안)

> 2026-07-06 / 클코 / A안 승인·토큰 workflow 스코프 부여 후 실행.
> 배경: legacy 브랜치 배포가 단일 run에서도 연속 실패(9e3d16d·8631d11: build 성공 / deploy "Deployment failed, try again later").

## before → after
| 항목 | before | after |
|---|---|---|
| Pages Source | legacy 브랜치 (main / root), 동시성 가드 없음 | **GitHub Actions** (`build_type=workflow`) |
| 배포 워크플로 | 자동 "pages build and deployment"(dynamic) | `.github/workflows/pages.yml` — `upload-pages-artifact`+`deploy-pages`, **`concurrency: group pages, cancel-in-progress:false`** |
| 기능 코드 | — | **무변경** (gas/Code.gs 등 손대지 않음) |

## 검증 (정직한 결과 — 부분 성공 + 잔여 이슈)
- ✅ 전환 커밋 `cd213c3` → run "Deploy Pages" **1개**(legacy dynamic run 사라짐) → **build+deploy success**, github-pages deployment **sha=cd213c3==HEAD, state=success**, 로그 `Reported success!`. → **전환 자체는 동작 확인.**
- ❌ 검증 커밋 `fc3252b`(step3) → 같은 워크플로인데 **deploy 실패**: `Getting Pages deployment status... ##[error]Deployment failed, try again later.` (deployment state: waiting→queued→in_progress→**failure**). **rerun-failed-jobs 재시도도 failure.**
- 검증 오라클: legacy `/pages/builds/latest`는 Actions 소스에서 갱신 안 됨 → github-pages **deployments API의 `sha`+status `state`**로 판정(정정).

## 근본원인 재평가 (내 이전 진단 정정)
연속 배포 실패의 원인을 좁혀본 결과, **아래 어느 것도 아님**:
- 동시성/nudge twin ❌ (단일 run·nudge 없이도 실패) — 이전 진단은 부분적.
- 소스 타입 ❌ (legacy·Actions 둘 다 실패; Actions에서도 cd213c3 성공/fc3252b 실패).
- Pages 시간당 배포 rate limit ❌ (실측 최대 3/시간, 문제 시간대 2/시간 — 한계 무관). ← 이전 rate-limit 가설 **철회**.
- GitHub 인시던트 ❌ (githubstatus: All Operational, Pages/Actions operational, 미해결 인시던트 0).
- **결론: 특정 시점에 GitHub Pages 백엔드가 배포를 간헐/지속 거부("try again later"). 우리 설정으로 제어 불가한 GitHub 측 현상.** build/artifact는 매번 정상.

## 배포
- 전환 커밋 `cd213c3`: **배포 성공**(state=success). URL https://pwr-clair.github.io/cs/ (루트 404는 정상 — index.html 없음, M2b).
- 검증 커밋 `fc3252b`: **배포 실패**(위 로그). 현재 최신 성공 배포는 cd213c3.

## 제안 / 결정 요청
1. **전환은 유지** — legacy보다 개선(동시성 가드 확보, cd213c3로 정상 배포 입증). 되돌리지 않기를 제안.
2. **잔여 백엔드 flakiness는 우리 코드로 못 고침.** Pages는 M2b 전까지 서빙 콘텐츠가 없어 **M2a·기능에 영향 없음.**
3. 향후 배포 실패 시: (a) 잠시 후 rerun, (b) 지속되면 GitHub Support에 repo Pages 백엔드 이슈 문의. **더 이상 무의미한 재푸시/재시도는 안 함**(실패 메일 방지).
4. **Fable 결정 요청**: M2b 착수 시 Pages 배포가 계속 flaky하면 → ⓐ retry 감수하고 진행 / ⓑ 대체 호스팅(예: 별도 정적 호스트) 검토 / ⓒ GitHub Support 선처리. 무엇으로 갈지.

> 주: 이 보고서 커밋도 배포를 재트리거하며, GitHub 백엔드 상태에 따라 성공/실패가 갈릴 수 있음(코드와 무관).
