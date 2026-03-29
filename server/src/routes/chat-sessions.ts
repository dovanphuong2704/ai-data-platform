import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const chatSessionsRouter = Router();

chatSessionsRouter.use(authMiddleware);

// ─── GET /api/chat-sessions ──────────────────────────────────────────────────
// List all sessions for the current user (most recent first)
chatSessionsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      `SELECT id, title, created_at, updated_at
       FROM chat_sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ─── POST /api/chat-sessions ────────────────────────────────────────────────
// Create a new session (optionally with a title)
const createSessionSchema = z.object({
  title: z.string().optional(),
});

chatSessionsRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const { title } = createSessionSchema.parse(req.body);
    const result = await appPool.query(
      `INSERT INTO chat_sessions (user_id, title)
       VALUES ($1, $2)
       RETURNING id, title, created_at, updated_at`,
      [req.userId, title ?? 'New conversation']
    );
    res.status(201).json({ session: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  }
});

// ─── GET /api/chat-sessions/:id/messages ────────────────────────────────────
// Load all messages for a specific session
chatSessionsRouter.get('/:id/messages', async (req: AuthRequest, res) => {
  try {
    const sessionId = Number(req.params.id);
    // Verify session belongs to user
    const sessionResult = await appPool.query(
      'SELECT id, title FROM chat_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, req.userId]
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messagesResult = await appPool.query(
      `SELECT id, role, content, sql, sql_result, error, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );

    res.json({
      session: sessionResult.rows[0],
      messages: messagesResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ─── PATCH /api/chat-sessions/:id ──────────────────────────────────────────
// Update session title
const patchSessionSchema = z.object({
  title: z.string().min(1).max(255),
});

chatSessionsRouter.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { title } = patchSessionSchema.parse(req.body);
    const result = await appPool.query(
      `UPDATE chat_sessions
       SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, title, created_at, updated_at`,
      [title, req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ session: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to update session' });
    }
  }
});

// ─── DELETE /api/chat-sessions/:id ──────────────────────────────────────────
chatSessionsRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ message: 'Session deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});
