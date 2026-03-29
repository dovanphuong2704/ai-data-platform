# AI Data Intelligence Platform — SPEC.md

## 1. Project Overview

**Type:** Full-stack AI-powered analytics web application
**Frontend:** Next.js 14 (React 18) + TypeScript + TailwindCSS
**Backend:** ExpressJS + TypeScript
**Database:** PostgreSQL (app metadata + user target DB)
**AI Providers:** OpenAI, Grok (xAI), Google Gemini, Anthropic Claude
**Charts:** Recharts (React)

## 2. Tech Stack

### Frontend
- Next.js 14 App Router
- TypeScript
- TailwindCSS v3
- Axios (HTTP client)
- Recharts (charts)
- Lucide React (icons)
- date-fns (date formatting)

### Backend
- ExpressJS 5
- TypeScript
- PostgreSQL + pg
- JWT (jsonwebtoken)
- bcryptjs (password hashing)
- zod (validation)
- Node.js built-in crypto (AES-256-GCM for API key encryption)

## 3. Project Structure

```
ai-data-platform/
├── client/                    # Next.js 14 frontend
│   ├── src/
│   │   ├── app/             # Next.js App Router pages
│   │   │   ├── (auth)/      # Auth group (login, register)
│   │   │   ├── (app)/       # Main app group (authenticated)
│   │   │   │   ├── chat/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── saved-queries/   # Saved queries list
│   │   │   │   ├── alerts/          # Alert management
│   │   │   │   ├── scheduled-queries/ # Query scheduling
│   │   │   │   └── explorer/
│   │   │   └── layout.tsx
│   │   ├── components/       # Reusable UI components
│   │   ├── hooks/           # Custom React hooks
│   │   ├── lib/             # Utilities, API client
│   │   ├── types/           # TypeScript types
│   │   └── styles/          # Global styles
│   └── package.json
│
├── server/                   # ExpressJS backend
│   ├── src/
│   │   ├── routes/          # Express routers
│   │   ├── services/         # Business logic
│   │   ├── middleware/       # Express middleware
│   │   ├── types/           # TypeScript types
│   │   └── utils/           # Utilities
│   └── package.json
│
├── SPEC.md
├── README.md
└── docker-compose.yml
```

## 4. API Endpoints

### Auth
- POST /api/auth/register - Register new user
- POST /api/auth/login - Login
- POST /api/auth/logout - Logout
- GET /api/auth/me - Get current user

### Database Connections
- GET /api/connections - List user's DB connections
- POST /api/connections - Create new connection
- PUT /api/connections/:id - Update connection
- DELETE /api/connections/:id - Delete connection

### API Keys
- GET /api/keys - List user's API keys
- POST /api/keys - Create new API key
- DELETE /api/keys/:id - Delete API key

### Query
- POST /api/query - Execute SQL query (safe SELECT only)
- POST /api/query/cancel - Cancel a running query
- GET /api/query/active - List active queries for current user

### Chat
- POST /api/chat - Send chat message (AI generates SQL, executes, responds)
- GET /api/chat/stream - SSE streaming chat

### Dashboard
- GET /api/dashboard - Get user's pinned items
- POST /api/dashboard - Add item to dashboard
- DELETE /api/dashboard/:id - Remove item
- POST /api/dashboard/:id/share - Share item with another user (username/email + permission)

### Query History
- GET /api/history - List user's query history (paginated)
- DELETE /api/history/:id - Delete a history entry
- DELETE /api/history - Clear all history

### Saved Queries
- GET /api/saved-queries - List saved queries
- GET /api/saved-queries/:id - Get a saved query with full SQL
- POST /api/saved-queries - Create a saved query
- PUT /api/saved-queries/:id - Update a saved query
- DELETE /api/saved-queries/:id - Delete a saved query

### Scheduled Queries
- GET /api/scheduled-queries - List scheduled queries
- GET /api/scheduled-queries/:id - Get a scheduled query
- POST /api/scheduled-queries - Create a scheduled query
- PUT /api/scheduled-queries/:id - Update a scheduled query
- DELETE /api/scheduled-queries/:id - Delete a scheduled query
- POST /api/scheduled-queries/:id/run - Manually trigger a scheduled query

### Alerts
- GET /api/alerts - List alerts
- GET /api/alerts/:id - Get an alert
- POST /api/alerts - Create an alert
- PUT /api/alerts/:id - Update an alert
- DELETE /api/alerts/:id - Delete an alert

### Alert Webhooks
- GET /api/alerts/:id/webhooks - List webhooks for an alert
- POST /api/alerts/:id/webhooks - Add a webhook URL
- PUT /api/alerts/:alertId/webhooks/:webhookId - Update webhook (enable/disable)
- DELETE /api/alerts/:alertId/webhooks/:webhookId - Delete a webhook
- POST /api/alerts/:alertId/webhooks/:webhookId/test - Send a test payload

### Connection Test
- POST /api/connections/test - Test database connection credentials (3s timeout)

## 5. Database Schema

### users
- id: SERIAL PRIMARY KEY
- username: VARCHAR(50) UNIQUE NOT NULL
- email: VARCHAR(100) UNIQUE NOT NULL
- password_hash: VARCHAR(255) NOT NULL
- created_at: TIMESTAMP DEFAULT NOW()

### db_connections
- id: SERIAL PRIMARY KEY
- user_id: INTEGER REFERENCES users(id)
- profile_name: TEXT
- db_host: TEXT NOT NULL
- db_port: TEXT NOT NULL
- db_name: TEXT NOT NULL
- db_user: TEXT NOT NULL
- db_password: TEXT NOT NULL
- is_default: BOOLEAN DEFAULT FALSE
- created_at: TIMESTAMP DEFAULT NOW()

### api_keys
- id: SERIAL PRIMARY KEY
- user_id: INTEGER REFERENCES users(id)
- profile_name: TEXT
- provider: TEXT NOT NULL
- api_key: TEXT NOT NULL
- is_default: BOOLEAN DEFAULT FALSE
- created_at: TIMESTAMP DEFAULT NOW()

### user_dashboards
- id: SERIAL PRIMARY KEY
- user_id: INTEGER REFERENCES users(id)
- data: JSONB NOT NULL
- created_at: TIMESTAMP DEFAULT NOW()

### sql_query_history
- id: SERIAL PRIMARY KEY
- user_id: INTEGER REFERENCES users(id) ON DELETE CASCADE
- connection_id: INTEGER REFERENCES db_connections(id) ON DELETE SET NULL
- sql: TEXT NOT NULL
- status: TEXT NOT NULL (success|error|cancelled)
- duration_ms: INTEGER
- rows_returned: INTEGER
- error_message: TEXT
- created_at: TIMESTAMP DEFAULT NOW()

### user_quotas
- id: SERIAL PRIMARY KEY
- user_id: INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE
- query_count: INTEGER NOT NULL DEFAULT 0
- query_limit: INTEGER NOT NULL DEFAULT 100
- chat_count: INTEGER NOT NULL DEFAULT 0
- chat_limit: INTEGER NOT NULL DEFAULT 50
- window_start: TIMESTAMP NOT NULL DEFAULT NOW()
- created_at: TIMESTAMP DEFAULT NOW()

### saved_queries
- id: SERIAL PRIMARY KEY
- user_id: INTEGER REFERENCES users(id) ON DELETE CASCADE
- name: TEXT NOT NULL
- sql: TEXT NOT NULL
- description: TEXT
- connection_id: INTEGER REFERENCES db_connections(id) ON DELETE SET NULL
- created_at: TIMESTAMP DEFAULT NOW()
- updated_at: TIMESTAMP DEFAULT NOW()

### scheduled_queries
- id: SERIAL PRIMARY KEY
- user_id: INTEGER REFERENCES users(id) ON DELETE CASCADE
- name: TEXT NOT NULL
- sql: TEXT NOT NULL
- schedule_cron: TEXT NOT NULL (node-cron format, e.g. '0 * * * *')
- connection_id: INTEGER REFERENCES db_connections(id) ON DELETE SET NULL
- is_active: BOOLEAN DEFAULT TRUE
- last_run_at: TIMESTAMP
- last_run_status: TEXT (success|error)
- last_run_result: JSONB
- created_at: TIMESTAMP DEFAULT NOW()

### alerts
- id: SERIAL PRIMARY KEY
- user_id: INTEGER REFERENCES users(id) ON DELETE CASCADE
- name: TEXT NOT NULL
- query_sql: TEXT NOT NULL
- threshold_value: DOUBLE PRECISION NOT NULL
- condition: TEXT NOT NULL (gt|lt|gte|lte|eq|ne)
- connection_id: INTEGER REFERENCES db_connections(id) ON DELETE SET NULL
- is_active: BOOLEAN DEFAULT TRUE
- last_checked_at: TIMESTAMP
- last_triggered_at: TIMESTAMP
- notify_email: BOOLEAN DEFAULT FALSE
- created_at: TIMESTAMP DEFAULT NOW()

### shared_dashboards
- id: SERIAL PRIMARY KEY
- owner_id: INTEGER REFERENCES users(id) ON DELETE CASCADE
- shared_with_user_id: INTEGER REFERENCES users(id) ON DELETE CASCADE
- dashboard_item_id: INTEGER REFERENCES user_dashboards(id) ON DELETE CASCADE
- permission: TEXT NOT NULL DEFAULT 'view' (view|edit)
- created_at: TIMESTAMP DEFAULT NOW()

### alert_webhooks
- id: SERIAL PRIMARY KEY
- alert_id: INTEGER REFERENCES alerts(id) ON DELETE CASCADE
- webhook_url: TEXT NOT NULL
- is_enabled: BOOLEAN DEFAULT TRUE
- created_at: TIMESTAMP DEFAULT NOW()

## 6. Design System

### Color Palette (Dark AI-first)
- Background: #0d1117
- Surface: #161b22
- Surface 2: #21262d
- Border: #30363d
- Text Primary: #e6edf3
- Text Secondary: #8b949e
- Accent: #58a6ff
- Accent 2: #1f6feb
- Success: #3fb950
- Error: #f85149
- Warning: #d29922
- User Bubble: #1c3a5e
- Gradient: linear-gradient(135deg, #667eea, #764ba2)

### Typography
- Font: Inter
- Headings: Semibold (600)
- Body: Regular (400)

### Spacing
- Base unit: 4px
- Component padding: 16px
- Section gap: 24px

## 7. Features

### Auth
- Register with username/email/password
- Login with JWT tokens (stored in httpOnly cookies)
- Logout (clear cookie)

### Onboarding
- First-time user wizard: connect DB + add API key
- Skip option available
- Stored in user session

### Chat
- Natural language queries in Vietnamese/English
- AI generates SQL, executes, returns results
- Table results displayed inline
- Chart generation (Recharts)
- SQL code shown in message
- Suggestion chips
- Memory/context system
- Pin results to dashboard
- **AI Provider Toggle**: switch between OpenAI, Grok, Gemini, Claude (persisted in localStorage)
- **Query History Panel**: collapsible sidebar listing past queries with status, duration, re-run
- **Query Cancel Button**: cancel long-running queries with 30s auto-timeout
- **Save Query**: bookmark button on SQL results → modal to name + save
- **Quota Badge**: color-coded remaining query quota in chat header
- **Streaming Mode**: SSE-based real-time token-by-token AI response with stop/retry

### Dashboard
- Grid of pinned tables/charts
- Remove items
- Export (CSV, JSON)
- Share dashboard items with other users (view/edit permission)

### Explorer
- Browse database schema (tables → columns)
- Preview table data
- "Ask AI about this table" → sends to chat

### Settings
- Manage DB connections (add/edit/delete/connect)
- Manage API keys (add/delete)
- Change password
- Test database connection before saving (inline success/error feedback)

### SQL History
- Every executed query is logged with status, duration, row count
- View past queries with pagination
- Delete individual entries or clear all
- **Re-run** past queries directly from the panel

### Saved Queries
- Save frequently-used SQL with name and description
- Run saved queries directly from the saved list
- Associate with a specific DB connection
- Search by name or SQL text
- Dedicated `/saved-queries` page

### Query Scheduling
- Schedule SQL queries to run on a cron expression (node-cron format)
- Manual trigger available at any time
- Last run status and result stored per schedule
- Toggle active/inactive
- Dedicated `/scheduled-queries` page with create/edit/delete

### Alerting
- Define threshold-based alerts on query results
- Supported conditions: greater than, less than, equal, etc.
- Alert runner checks every 5 minutes
- Email notification opt-in per alert (existing)
- **Webhook alerting**: HTTP POST to configured webhook URLs on trigger
  - Payload: alert_name, triggered_at, condition, threshold, current_value, sql, dashboard_url
  - 5s timeout per request, 1 retry on failure
  - Per-webhook enable/disable toggle
  - Test button to verify webhook delivery
- Active/triggered/inactive status with color-coded badges
- Dedicated `/alerts` page with create/edit/delete/toggle

### Multi-user Sharing
- Share dashboard items with other users by username/email
- Permission levels: view or edit
- Shared items display owner's attribution

### SSE Streaming
- Real-time streaming responses via Server-Sent Events
- Events emitted in order:
  - `status` — schema fetch progress
  - `thinking` — AI is generating SQL
  - `sql` — generated SQL statement
  - `result` — query result (columns, rows, rowCount, duration_ms)
  - `analysis` — AI analysis text with typing effect
  - `done` — stream complete
  - `error` — error message
- Max 50 concurrent streams per server
- Auto-reconnect on disconnect (up to 3 retries)
- Stop button to abort mid-stream

### SSE Streaming
- Real-time streaming responses via Server-Sent Events
- Events: start, sql_generated, result, error, done
- Max 50 concurrent streams per server
- Auto-reconnect support on client side

### API Key Security
- API keys encrypted at rest using AES-256-GCM
- Key derived from ENCRYPTION_KEY env var
- Decrypted only when needed (chat, key listing)

## 8. Security

### SQL Safety
- Blocklist: INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, etc.
- Single statement only (no semicolons)
- Must start with SELECT or WITH
- Auto LIMIT injection (default 1000)
- Statement timeout (5 seconds)

### Auth Security
- Passwords hashed with bcrypt (10 rounds)
- JWT tokens (httpOnly cookies, 7-day expiry)
- Password validation (min 6 chars)

### Input Validation
- All inputs validated with zod

### Rate Limiting
- Per-user rolling window quotas (1 hour)
- Default: 100 queries/hour, 50 chat messages/hour
- Returns HTTP 429 with remaining count and reset time

### API Key Encryption
- AES-256-GCM encryption for API keys at rest
- ENCRYPTION_KEY env var required (32-byte derived via SHA-256)
- Graceful error if key not configured
