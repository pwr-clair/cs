# 이어받기 온보딩 — CS + Guide 바로 작업 재개용 (2026-07-08)

새 세션이 이 파일 하나로 **가이드/승인앱/GAS를 바로 편집·배포**할 수 있게 정리. 규칙은 `CLAUDE.md` 먼저 읽을 것.

---

## 0. 레포 지도 (어느 레포에 뭐가 있나 — 자주 헷갈림)
| 대상 | 레포 | 경로 | 라이브 |
|---|---|---|---|
| **게스트 가이드** | **`pwr-clair/guide`** | 루트 `index.html`, `assets/images/`, `CNAME`, `.github/workflows/pages.yml` | **https://pwr-guide.online** |
| 관리자 승인앱(CS DESK) | `pwr-clair/cs` | 루트 `index.html` | `pwr-clair.github.io/cs/` |
| CS 엔진(GAS) | `pwr-clair/cs` | `gas/Code.gs` (Pages 미배포, Clara가 GAS에 붙여넣음) | PWR-CS-Engine |
| 로고 등 브랜드 자산 | `pwr-clair/housekeeping` | `logos/` | — |

> ⚠️ **가이드 본문은 `cs` 레포에 없다.** `cs/guide/index.html`은 pwr-guide.online 리다이렉트 셔틀일 뿐. 가이드 편집은 반드시 **`pwr-clair/guide`** 레포에서.

로컬 작업 디렉터리: `/Users/ClairCho/Documents/Csteam` (= `pwr-clair/cs` 클론). 인증은 **keychain**(gh 불필요), 토큰 스코프 `repo, workflow`.

---

## 1. 가이드(pwr-clair/guide) 편집·배포 절차 — 복붙용
```sh
SP=/private/tmp/.../scratchpad   # 아무 임시 폴더
git clone https://github.com/pwr-clair/guide.git "$SP/guide-repo"
# ... $SP/guide-repo/index.html 편집 ...
git -C "$SP/guide-repo" add -A
git -C "$SP/guide-repo" -c user.name="Clair Cho" -c user.email="joi.hurricane@gmail.com" \
  commit -m "메시지"
git -C "$SP/guide-repo" push origin main
# → GitHub Actions가 자동 배포(~1–2분). 검증:
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | sed -n 's/^password=//p')
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/pwr-clair/guide/actions/runs?per_page=1"   # completed/success 확인
curl -s -o /dev/null -w "%{http_code}\n" "https://pwr-guide.online/?cb=$RANDOM"  # 200
```
로컬 미리보기: `python3 -m http.server 8892 --directory <guide-repo>` 후 브라우저.

## 2. 가이드 index.html 구조 (편집 지점)
단일 HTML. **4개 언어**(EN=DOM 원문, KO/JA/ZH=하단 `<script>`의 `I18N` 사전). 텍스트에 `data-i18n="키"`가 붙어 있고, JS `apply(lang)`가 사전값으로 innerHTML 스왑.
- **텍스트 바꾸기**: HTML의 EN 원문 + `I18N.ko/ja/zh`의 같은 키를 **함께** 수정(안 그러면 그 언어만 영어로 폴백). 키 커버리지: HTML의 data-i18n 집합 == 각 사전 키 집합이어야 함.
- **레이아웃 순서**: 히어로(`.hero`) → 스티키 네비(`.topbar`) → 셔틀(`#shuttle`, 경로 카드 + `.tt` 시간표) → 택시(`.addr`) → 건물(`#building`) → 숙박(`#stay`) → Notice → 주변(`#around`, 14곳 정보카드·링크없음) → Support&Contact(`#contact`).
- **히어로**: `.langs`(국기 원형 스위처, absolute 우상단) + `.brandmark`(텍스트 "Paradise Walk Residence") + `h1`(data-i18n="hero.h1") + `.sub`.
- **버스 시간표**: 셔틀 섹션의 `.tt` 블록 — 헤더 `.tt-h`(현재 `🕘 Bus No.04 — from "Int'l Business Center" stop`, data-i18n="tt.head") + `<table>`(시=행/분=숫자) + `.tt-note`(data-i18n="tt.note").
- 도구: 컬러/폰트 CSS 변수는 상단 `:root`. 커밋 후 라이브 grep으로 검증.

---

## 3. 지금 요청받은 가이드 작업 2건 — 실행 방법

### (a) 히어로 좌상단 'PWR' 로고 삽입
- **로고 파일**: `pwr-clair/housekeeping/logos/PWR-logo-black.png` (검정 PWR 모노그램·**투명배경**·320×230·5.5KB) ← "검정 배경없는 버전"이 이것. (white 버전도 같은 폴더에 있음.)
- **가져오기**: raw 다운로드 후 guide 레포 `assets/images/`에 커밋.
  ```sh
  TOKEN=... ; curl -sL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/pwr-clair/housekeeping/contents/logos/PWR-logo-black.png?ref=main" \
    -o "<guide-repo>/assets/images/PWR-logo-black.png"
  ```
- **삽입 지점**: `.hero` 안, `.brandmark`("Paradise Walk Residence") 위 또는 왼쪽에 `<img src="assets/images/PWR-logo-black.png" alt="PWR" class="logo">`. CSS 예: `.hero .logo{height:30px;width:auto;display:block;margin-bottom:10px;}` (좌상단 정렬). 언어중립이라 data-i18n 불필요.
- 주의: 히어로 우상단엔 이미 국기 스위처(`.langs`)가 absolute로 있음 → 로고는 좌측/상단에 두어 겹침 없게. 히어로 `padding-top`(현재 48px)이 스위처와 겹치지 않는지 프리뷰 확인.

### (b) 버스 시간표 위 'Timetable' 타이틀
- **위치**: `.tt` 블록 바로 위(map-to-airport 사진과 `.tt` 사이) 또는 `.tt` 안 최상단.
- 다국어 유지 권장: 새 키 `tt.title` 추가 — 예: `<h3 data-i18n="tt.title">Timetable</h3>` + 사전 `ko:"시간표" / ja:"時刻表" / zh:"时刻表"`. (단순 "Timetable" 한 단어만 원하면 data-i18n 없이 고정도 가능하나, 다른 텍스트가 다 번역되므로 키 추가 권장.)
- 키 추가 시 **ko/ja/zh 3곳 모두** 넣어야 커버리지 유지.

---

## 4. CS DESK / GAS 현황 (상세: `2026-07-08-handoff.md`, `2026-07-08-quota-and-knowledge.md`)
- 승인앱: dismiss(단건+일괄)·수신시각 정렬·urlfetch **FETCH n** 표기 = 라이브(`cs@8183dde`).
- GAS `gas/Code.gs`: A쿨다운·B컷오프·C가이드팩트·D시트적재·E계기판 반영 **완료(커밋)**, 단 **Clara가 PWR-CS-Engine에 재붙여넣기해야 적용**.
- **Clara 대기 액션**(신규 세션이 물어볼 것): ①Code.gs 재붙여넣기 ②(선택)`CS_CUTOFF` 날짜 속성 ③`exportBacklogQuestionsToSheet()`→시트 C열 답변→`importCorpusFromSheet()` ④가이드 다국어 검수.
- 테스트: `sh tests/run.sh` (cs 레포, 현재 65 PASS, node 없이 JavaScriptCore로 동작).

## 5. 작업 규칙 (재확인)
- 커밋은 push 후 배포 초록 + deployment sha==HEAD 확인. gas/docs/tests 변경은 Pages 미트리거(정상).
- KO/JA/ZH 번역은 클로드 초안 → 클라라/네이티브 검수 대상. 팩트 창작 금지, 설계 변경은 Fable 회송.
- "정리/요약" 요청 = `docs/reports/`에 파일 커밋까지 한 세트.
