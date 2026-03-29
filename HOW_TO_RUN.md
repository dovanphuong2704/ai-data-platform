# How to Run — AI Data Intelligence Platform

## Prerequisites

- **Node.js 18+** (check: `node -v`)
- **npm** (check: `npm -v`)
- **PostgreSQL 13+** (running and accessible)
- **AI API Key** (OpenAI / Grok / Gemini / Claude — tối thiểu 1 cái)

---

## Quick Start (5 phút)

### 1. Database Setup

```bash
cd ai-data-platform

# Option A: Dùng Docker (nhanh nhất)
docker-compose up -d

# Option B: Dùng PostgreSQL có sẵn
# Tạo database:
# psql -U postgres -c "CREATE DATABASE ai_dataplatform;"
```

### 2. Backend Setup

```bash
cd ai-data-platform/server

# Cài dependencies
npm install

# Tạo file .env (đã có mẫu)
cp .env.example .env
# Edit .env → thay DATABASE_URL bằng connection string của bạn
# VD: postgresql://postgres:password@localhost:5432/ai_dataplatform

# Khởi tạo database tables
npm run init-db
# Output: "Database initialized successfully"

# Chạy server
npm run dev
# Output: "🚀 Server running on http://localhost:3001"
```

### 3. Frontend Setup (terminal mới)

```bash
cd ai-data-platform/client

# Cài dependencies
npm install

# Chạy dev server
npm run dev
# Output: "▲ Ready — http://localhost:3000"
```

### 4. Mở trình duyệt

```
http://localhost:3000
```

---

## First-time Setup (sau khi đăng ký)

1. **Đăng ký** → tạo tài khoản
2. **Settings → Database** → Thêm kết nối PostgreSQL của bạn
3. **Settings → API Keys** → Thêm API Key (OpenAI / Grok / Gemini / Claude)
4. Vào **Chat** → hỏi câu đầu tiên!

---

## Troubleshooting

### Lỗi "Cannot connect to database"
```bash
# Kiểm tra PostgreSQL đang chạy
docker ps  # (nếu dùng Docker)
pg_isready -h localhost -p 5432  # (nếu dùng PostgreSQL trực tiếp)

# Kiểm tra DATABASE_URL trong server/.env
# Đúng format: postgresql://user:password@host:port/dbname
```

### Lỗi "Invalid API Key"
- Kiểm tra API Key đúng provider
- Với Grok: dùng `https://api.x.ai/v1` base URL
- Với Gemini: dùng Google AI Studio key
- Với Claude: dùng Anthropic API key

### Lỗi "Module not found"
```bash
# Xóa node_modules và cài lại
rm -rf node_modules package-lock.json
npm install
```

### Lỗi TypeScript errors
```bash
cd server && npm run build
cd ../client && npm run build
```
Nếu vẫn lỗi → xóa `dist/` và `.next/`, chạy lại.

---

## Environment Variables

### Server (`server/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3001 | Server port |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `JWT_SECRET` | No | dev-secret | JWT signing secret (đổi trong production!) |

### Client (`client/.env.local`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | No | http://localhost:3001 | Backend URL |

---

## API Endpoints Reference

```
Auth:
  POST   /api/auth/register
  POST   /api/auth/login
  POST   /api/auth/logout
  GET    /api/auth/me

Connections:
  GET    /api/connections
  POST   /api/connections
  PUT    /api/connections/:id
  DELETE /api/connections/:id
  POST   /api/connections/:id/test

API Keys:
  GET    /api/keys
  POST   /api/keys
  DELETE /api/keys/:id

Query:
  POST   /api/query          { connectionId, sql }
  GET    /api/query/schema   { connectionId }

Chat:
  POST   /api/chat           { message, connectionId?, aiProvider?, history? }

Dashboard:
  GET    /api/dashboard
  POST   /api/dashboard
  DELETE /api/dashboard/:id
```
