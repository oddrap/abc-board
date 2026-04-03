# ABC Pulse — Telegram Mini App Design Spec

## Overview

A Telegram Mini App for a 5-person remote family office team. The app serves as a portfolio management hub where team members can track portfolio status, log updates with file attachments, and stay aligned on portfolio health.

## Problem

- Shared information goes unread in chat
- No unified view of portfolio health across the team
- Low communication frequency in remote setup
- No systematic way to classify which portfolios are actively managed vs. neglected

## Solution

A single-purpose Mini App focused on **portfolio visibility and update tracking**. Not a chat replacement — the Telegram group already handles deal discussions (blurbs, IR decks). This app answers: "Which portfolios are healthy? Which ones are we losing track of?"

---

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Cloudflare Workers (Hono) |
| Database | Cloudflare D1 (SQLite) |
| File Storage | Google Drive API |
| Bot | Telegram Bot API |
| Frontend | Vanilla HTML/CSS/JS (served from Workers) |

### System Diagram

```
Telegram Group Chat
    │
    ├── Mini App (WebView)
    │     ├── Portfolio List (main screen)
    │     ├── Portfolio Detail (update history)
    │     └── Update Form (with file upload)
    │
    ├── Bot
    │     ├── New update notifications → group
    │     └── Stale portfolio reminders → group
    │
Cloudflare Workers (Hono)
    ├── API routes
    ├── Static assets (public/)
    ├── D1 Database
    └── Google Drive API (file upload → link)
```

---

## Data Model

### portfolios

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| name | TEXT NOT NULL | Company/fund name |
| status | TEXT NOT NULL | 'active', 'stale', 'dead', 'scraping' |
| assignee_name | TEXT | Responsible team member |
| assignee_telegram_id | TEXT | Telegram user ID (stored as string — IDs can exceed JS safe integer range) |
| logo_url | TEXT | Company logo (optional) |
| gdrive_folder_id | TEXT | Google Drive subfolder ID for this portfolio |
| created_at | TEXT | ISO datetime |
| updated_at | TEXT | ISO datetime, tracks last status change |
| last_update_at | TEXT | ISO datetime, tracks last update entry |

### updates

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| portfolio_id | INTEGER FK | References portfolios.id |
| author_name | TEXT NOT NULL | Who posted |
| author_telegram_id | TEXT NOT NULL | Telegram user ID (stored as string) |
| title | TEXT NOT NULL | Update title (e.g. "Q1 실적 리포트") |
| summary | TEXT | Brief summary of the update content |
| update_date | TEXT NOT NULL | When this update is about (not created_at) |
| created_at | TEXT | ISO datetime |

### attachments

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| update_id | INTEGER FK | References updates.id |
| file_name | TEXT NOT NULL | Original filename |
| file_type | TEXT | MIME type |
| gdrive_url | TEXT NOT NULL | Google Drive file URL |
| gdrive_file_id | TEXT NOT NULL | Google Drive file ID |
| created_at | TEXT | ISO datetime |

---

## Screens

### Screen 1: Portfolio List (Main)

The entry point. Shows all portfolios grouped by status.

**Header**: "ABC Pulse" + portfolio count

**Tab filter bar**:
- 관리중 (active) — default
- 확인필요 (stale)
- 중단 (dead)
- 스크래핑 (scraping)

Each tab shows count badge.

**Portfolio cards** (vertical list):
- Company logo (if available) + name
- Status badge (colored)
- Assignee name
- Last update date
- Warning indicator if stale (see below)

**Long-press on card** → status change popup:
- Four status options with colored indicators
- Tap to change, immediate save

**Bottom**: "+ 새 포트폴리오 등록" button

### Screen 4: Portfolio Creation Form

Opened from the "+ 새 포트폴리오 등록" button on Screen 1.

**Fields**:
- 회사/펀드명 (text input, required)
- 담당자 (select from team members, optional — defaults to creator)
- 상태 (select, defaults to '관리중')
- 로고 (file upload, optional)

**Submit** → creates portfolio in D1, returns to list

**Stale warning logic**: Portfolios with `last_update_at` older than 60 days show a ⚠️ warning badge on the card. This is a visual indicator only — does NOT auto-change status. Status changes are always a human decision via long-press. The threshold (60 days) is configurable via Workers environment variable `STALE_THRESHOLD_DAYS`.

### Screen 2: Portfolio Detail

Tapping a card opens the detail view.

**Header**: Company name + status badge + assignee

**Update history** (reverse chronological):
Each update entry shows:
- Date + title
- Summary text (collapsed by default, tap to expand)
- Attachment chips: filename with icon by type, tap to open GDrive link

**Bottom**: "+ 업데이트 추가" button

### Screen 3: Update Form

Opened from portfolio detail.

**Fields**:
- 날짜 (date picker, defaults to today)
- 제목 (text input, required)
- 요약 (textarea, optional)
- 첨부 (file upload, multiple files allowed)
  - Any file type supported
  - Upload flow: file selected → uploaded to Google Drive (team shared folder) → GDrive link stored in DB
  - Google Drive link paste also supported (manual entry)

**Submit** → saves to D1, triggers bot notification to group

---

## File Upload Flow

```
User selects file in Mini App
    → Frontend sends file via multipart POST to Workers API
    → Workers uploads to Google Drive via API
        - Target folder: shared team folder (configured per deployment)
        - File naming: {portfolio_name}/{date}_{original_filename}
    → GDrive returns file ID + URL
    → Workers saves attachment record to D1
    → Response returns to frontend with GDrive link
```

### File Upload Constraints

- **Max file size**: 25 MB per file (Workers request body limit on paid plan is 100 MB, but 25 MB is practical for IR decks and reports)
- **Frontend validation**: Check file size before upload, show error if exceeded
- **Upload method**: Workers receives multipart form data, buffers the file, then uploads to Google Drive via REST API. For files under 5 MB, use simple upload. For 5-25 MB, use resumable upload.
- **Timeout**: Workers CPU time limit is 30s (paid plan). Large file uploads may approach this — resumable upload mitigates by chunking.

### Google Drive Setup

- **Service account**: JSON key stored in Workers secret `GDRIVE_SERVICE_ACCOUNT_KEY`
- **Auth method**: Manual JWT signing → access token exchange (Google's Node.js SDK is too large for Workers; use Drive REST API directly)
- **Required scope**: `https://www.googleapis.com/auth/drive.file`
- Shared folder owned by team, service account added as editor
- **Folder structure**: Per-portfolio subfolders, auto-created on first upload. Folder ID cached in `portfolios` table (add `gdrive_folder_id TEXT` column).
- Folder naming: `ABC_Portfolio_{portfolio_name}`

---

## Telegram Bot Integration

### Notifications to Group

**On new update posted**:
```
📋 무신사 — 새 업데이트
제목: Q1 실적 리포트
작성: 김OO
📎 첨부 2건
[미니앱에서 보기]
```

**Stale portfolio reminder** (weekly, via Cloudflare Workers Cron Trigger `0 9 * * 1` — every Monday 9AM):
```
⚠️ 확인필요 포트폴리오 4건
- TrustToken (68일 미갱신)
- Lition (45일 미갱신)
- ...
[미니앱에서 확인]
```

### Bot Commands (optional, low priority)

- `/status` — quick portfolio health summary in chat
- `/stale` — list stale portfolios

---

## API Routes

```
GET    /api/portfolios              — list all, filterable by status
POST   /api/portfolios              — create new portfolio
PUT    /api/portfolios/:id          — update portfolio (status, assignee, etc.)
DELETE /api/portfolios/:id          — soft delete (sets status to 'archived')

GET    /api/portfolios/:id/updates  — list updates for a portfolio
POST   /api/portfolios/:id/updates  — create update (with file upload)
DELETE /api/portfolios/:id/updates/:updateId — delete an update

POST   /api/files/upload            — upload file to Google Drive, return link

POST   /api/telegram/webhook        — incoming bot webhook
POST   /api/telegram/notify         — send notification to group (internal)
```

Note: Portfolio "delete" is a soft delete (status → 'archived', hidden from default view). Hard delete is out of scope for v1.

---

## Authentication

Telegram Mini Apps provide `initData` with user identity (user ID, name, etc.) signed by Telegram. The backend validates this signature to authenticate requests. No separate login needed.

- All API requests include Telegram `initData` header
- Backend validates HMAC signature against bot token
- User identity extracted from validated data
- No user registration flow — Telegram identity is sufficient for 5 people

---

## Error Handling

- **File upload failure**: Show error toast in frontend, user can retry. If GDrive upload fails after D1 write, the update is saved without attachment — user can add attachment later.
- **Bot notification failure**: Non-blocking. Update is saved regardless. Failed notifications are logged but not retried (acceptable for 5-person team).
- **Network errors**: Frontend shows inline error message with retry option. No offline mode in v1.
- **Partial success**: D1 write is the source of truth. If bot notification or GDrive upload fails, the core data (update record) is preserved.

## CORS

Not required — frontend static assets and API are served from the same Workers origin. All requests are same-origin.

---

## Scope Boundaries

**In scope (v1)**:
- Portfolio CRUD with status classification
- Update history with file attachments via Google Drive
- Bot notifications (new updates, stale reminders)
- Telegram auth via initData

**Out of scope (v1)**:
- Google Sheets sync (portfolios managed directly in app)
- Deal pipeline features (handled in group chat)
- Daily standup / team status features
- Portfolio financial data (AUM, returns, etc.)
- Search functionality
- Commenting on updates

**Future considerations (v2+)**:
- Portfolio financial snapshot (AUM, cash position) from Google Sheets
- AI-powered update summarization
- Deal pipeline tracking
- File preview within the app

---

## Data Migration

- Schema created via `wrangler d1 execute` with SQL migration file
- Initial portfolio data: manually entered via the app, or optionally seeded from a script using the existing company logos in `abc-board/public/assets/logos/` as a starting list
- No automated migration from Google Sheets — portfolios are managed directly in the app going forward

## Open Questions

1. **Stale threshold**: 60 days default — is this right for a family office cadence?
2. **Existing portfolio data**: Are the logos in abc-board/public/assets/logos/ the current portfolio? Should we seed the DB from them?
