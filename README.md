# ABC Pulse — 포트폴리오 관리 텔레그램 미니앱

ABC Partners 패밀리 오피스의 5인 재택 팀을 위한 포트폴리오 관리 도구.
텔레그램 미니앱으로 동작하며, 포트폴리오 현황 파악과 업데이트 추적을 한 화면에서 해결합니다.

## 핵심 기능

- **포트폴리오 리스트** — 상태별 분류 (Active / Stale / Closed), 담당자 배정
- **업데이트 히스토리** — 날짜별 업데이트 기록, 요약, 첨부파일
- **파일 관리** — Google Drive 자동 업로드 + 링크 삽입
- **텔레그램 봇** — 새 업데이트 알림, `/stale` 명령어, 주간 리마인더
- **롱프레스 상태 변경** — 카드를 길게 눌러 포트폴리오 상태 즉시 변경

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| Backend | Cloudflare Workers + Hono |
| Database | Cloudflare D1 (SQLite) |
| File Storage | Google Drive API |
| Bot | Telegram Bot API |
| Frontend | Vanilla HTML/CSS/JS |

## 배포

### 자동 배포 (CI/CD)
`main` 브랜치에 push하면 GitHub Actions가 자동으로 Cloudflare Workers에 배포합니다.

GitHub Secrets 필요:
- `CLOUDFLARE_API_TOKEN` — Cloudflare API 토큰
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare Account ID

### 수동 배포
```bash
npm run db:pulse:remote   # DB 스키마 초기화 (최초 1회)
npm run db:seed:remote    # 포트폴리오 시드 데이터 (최초 1회)
npm run deploy            # Cloudflare Workers 배포
```

## 환경변수 (Workers Secrets)

| Key | 설명 |
|-----|------|
| `BOT_TOKEN` | Telegram Bot Token |
| `GROUP_CHAT_ID` | 텔레그램 그룹 채팅 ID |
| `GDRIVE_SERVICE_ACCOUNT_KEY` | Google Drive 서비스 계정 JSON |
| `GDRIVE_ROOT_FOLDER_ID` | Google Drive 루트 폴더 ID |
| `MINI_APP_URL` | 배포된 미니앱 URL |

## 버전 관리 규칙

[Semantic Versioning](https://semver.org/) 사용:

- **MAJOR (1.0.0)** — 구조 변경, 기존 데이터 호환 불가
- **MINOR (0.x.0)** — 새 기능 추가 (새 화면, 새 API 등)
- **PATCH (0.0.x)** — 버그 수정, UI 미세 조정, 텍스트 변경

버전은 `package.json`의 `version` 필드가 기준.
프론트엔드 헤더에 자동 표시.

### 변경 이력

| 버전 | 날짜 | 내용 |
|------|------|------|
| 0.5.0 | 2026-04-06 | 코드 리뷰 리팩토링, XSS 방어, 디버그 엔드포인트 제거, CI/CD 설정 |
| 0.4.1 | 2026-04-05 | GDrive 공유 드라이브 지원, Gemini 3.1 AI 요약, 요약 포맷 구조화 |
| 0.4.0 | 2026-04-05 | AI 자동 요약 (Gemini), 탭 카운트, 검색바 |
| 0.3.0 | 2026-04-05 | HMAC 인증, 5인 화이트리스트, 상태 변경 UI |
| 0.2.0 | 2026-04-05 | CI 컬러 적용, Dieter Rams 디자인, Scraping 상태 제거 |
| 0.1.0 | 2026-04-05 | 초기 구현 — 포트폴리오 CRUD, 업데이트, GDrive, 봇 연동 |

## 라이브 URL

https://abc-board.oddrecord7079.workers.dev
