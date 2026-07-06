# 완료 보고 — Pages 배포 Actions 소스 전환 (A안)

> 2026-07-06 / 클코 / A안 승인·토큰 workflow 스코프 부여 후 실행.
> 배경: legacy 브랜치 배포가 단일 run에서도 연속 실패(9e3d16d·8631d11: build 성공 / deploy "Deployment failed, try again later").

## before → after
| 항목 | before | after |
|---|---|---|
| Pages Source | legacy 브랜치 빌드 (main / root), 동시성 가드 없음 | **GitHub Actions** (`build_type=workflow`) |
| 배포 워크플로 | 자동 "pages build and deployment"(dynamic) | `.github/workflows/pages.yml` — `actions/upload-pages-artifact`+`deploy-pages`, **`concurrency: group pages, cancel-in-progress:false`** |
| 기능 코드 | — | **무변경** (gas/Code.gs 등 손대지 않음) |

## 검증
- 전환 커밋 `cd213c3` push → run **"Deploy Pages" 정확히 1개**(legacy dynamic run 사라짐).
- run 결과: **build success + deploy success**.
- 올바른 검증 오라클로 확인(중요): legacy `/pages/builds/latest`는 Actions 소스에서 **갱신 안 됨**(옛 SHA 8631d11로 고착) → **github-pages deployment API** 사용:
  - 최신 github-pages deployment **`sha = cd213c3 == HEAD`** ✅
  - deployment **state = success**, env_url `https://pwr-clair.github.io/cs/`
  - deploy 로그: `Created deployment for cd213c3… / Reported success!` (기존 "Deployment failed, try again later" 소멸)
- 본 보고서 커밋 = 지시문 step3 "검증 커밋 1회"를 겸함 → 후속 push에서도 파이프라인 초록·SHA 일치 재확인(아래 갱신).

## 배포
- 커밋: `cd213c3` (`ci: switch Pages deploy to Actions source with concurrency guard (A-plan)`).
- URL: https://pwr-clair.github.io/cs/ — 루트 **HTTP 404는 정상**(서빙할 `index.html` 없음, M2b 범위). 배포 자체는 성공.

## 제안
- **§8 배포 검증 절차 갱신 필요**: Actions 소스에서는 `pages_build_version`(legacy builds API) 대신 **`GET /repos/pwr-clair/cs/deployments?environment=github-pages`의 최신 deployment `sha`가 HEAD와 일치 + status state=success**로 확인해야 함. (legacy builds/latest는 이제 신뢰 불가.) 메모리에 반영해 둠.
- 이후 모든 배포는 이 경로로 검증하며, 수동 nudge/legacy 재시도는 하지 않음.
