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
| assignee_telegram_id | INTEGER | Telegram user ID |
| logo_url | TEXT | Company logo (optional) |
| created_at | TEXT | ISO datetime |
| updated_at | TEXT | ISO datetime, tracks last status change |
| last_update_at | TEXT | ISO datetime, tracks last update entry |

### updates

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| portfolio_id | INTEGER FK | References portfolios.id |
| author_name | TEXT NOT NULL | Who posted |
| author_telegram_id | INTEGER NOT NULL | Telegram user ID |
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
- Warning indicator if no updates for 30+ days (configurable)

**Long-press on card** → status change popup:
- Four status options with colored indicators
- Tap to change, immediate save

**Bottom**: "+ 새 포트폴리오 등록" button

**Auto-stale logic**: Portfolios with no updates for N days (default: 60) show a warning badge. Does NOT auto-change status — that's a human decision via long-press.

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

### Google Drive Setup

- Service account with Drive API access
- Shared folder owned by team, service account added as editor
- Credentials stored in Workers secrets (not D1)

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

**Stale portfolio reminder** (weekly, configurable):
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
GET  /api/portfolios              — list all, filterable by status
POST /api/portfolios              — create new portfolio
PUT  /api/portfolios/:id          — update portfolio (status, assignee, etc.)

GET  /api/portfolios/:id/updates  — list updates for a portfolio
POST /api/portfolios/:id/updates  — create update (with file upload)

POST /api/files/upload            — upload file to Google Drive, return link

POST /api/telegram/webhook        — incoming bot webhook
POST /api/telegram/notify         — send notification to group (internal)
```

---

## Authentication

Telegram Mini Apps provide `initData` with user identity (user ID, name, etc.) signed by Telegram. The backend validates this signature to authenticate requests. No separate login needed.

- All API requests include Telegram `initData` header
- Backend validates HMAC signature against bot token
- User identity extracted from validated data
- No user registration flow — Telegram identity is sufficient for 5 people

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

## Open Questions

1. **Google Drive folder structure**: One shared folder flat, or per-portfolio subfolders?
   - Recommendation: per-portfolio subfolders for organization
2. **Stale threshold**: 60 days default — is this right for a family office cadence?
3. **Existing portfolio data**: Are the logos in abc-board/public/assets/logos/ the current portfolio? Should we seed the DB from them?
