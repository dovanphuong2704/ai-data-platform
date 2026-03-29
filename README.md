# AI Data Intelligence Platform

AI-powered natural language SQL query platform. Ask questions in Vietnamese (or English), get SQL results and charts.

## Tech Stack

- **Frontend:** Next.js 14, React 18, TypeScript, TailwindCSS, Recharts
- **Backend:** ExpressJS, TypeScript, PostgreSQL, LangChain
- **AI:** LangChain (OpenAI, Grok (xAI), Google Gemini, Anthropic Claude)

## Features

- Natural language → SQL query
- Multi-database support (PostgreSQL)
- Multi-AI provider (OpenAI, Grok, Gemini, Claude)
- Interactive charts (Recharts)
- Dashboard with pinned results
- Database schema explorer
- First-time onboarding wizard
- Dark AI-first design

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 13+
- Docker (optional, for PostgreSQL)

### Backend Setup

```bash
cd server
cp .env.example .env
# Edit .env with your DATABASE_URL and secrets
npm install
npm run init-db   # Tạo database tables
npm run dev
# Server: http://localhost:3001
```

### Frontend Setup

```bash
cd client
npm install
npm run dev
# Client: http://localhost:3000
```

### Database Setup

```bash
# Option A: Docker (recommended)
docker-compose up -d

# Option B: Existing PostgreSQL
# Create database: CREATE DATABASE ai_dataplatform;
```

### First-time Setup (after registering)

1. Go to **Settings → Database** → Add your PostgreSQL connection
2. Go to **Settings → API Keys** → Add your OpenAI/Grok/Gemini/Claude key
3. Start chatting in **Chat**!

## Environment Variables

### Server (.env)
- `PORT` - Server port (default: 3001)
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - JWT signing secret (change in production!)

### Client (.env.local)
- `NEXT_PUBLIC_API_URL` - Backend URL (default: http://localhost:3001)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Register |
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Logout |
| GET | /api/connections | List DB connections |
| POST | /api/connections | Add DB connection |
| DELETE | /api/connections/:id | Delete connection |
| GET | /api/keys | List API keys |
| POST | /api/keys | Add API key |
| DELETE | /api/keys/:id | Delete key |
| POST | /api/query | Execute SQL |
| POST | /api/chat | Chat message |
| GET | /api/dashboard | Get dashboard |
| POST | /api/dashboard | Add to dashboard |

## License

MIT
