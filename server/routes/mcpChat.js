// =============================================================================
// /api/mcp/chat — conversational, scoped MCP console (Server-Sent Events).
//
// One POST = one streamed chat turn. Claude orchestrates the same scoped MCP
// tools the manual console exposes; reads run freely, writes pause for the
// caller's approval (resume by re-POSTing with `decisions`). Scope and audit
// are inherited from the session exactly like /api/mcp/tools/call.
//
// Body is JSON-parsed with a larger limit than the global 64kb (see index.js)
// because the transcript carries prior tool results.
// =============================================================================

import express from 'express';
import { requireAuth, requireCsrf } from '../middleware/requireAuth.js';
import { runChatTurn, chatAvailable } from '../mcp/chatAgent.js';
import { McpError } from '../mcp/client.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth);

router.post('/', requireCsrf, async (req, res) => {
  if (!chatAvailable()) {
    return res.status(503).json({ error: 'Conversational console is not configured.' });
  }
  const { messages, decisions } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array.' });
  }

  // SSE response.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering of the stream
  res.flushHeaders?.();

  // Detect a real client disconnect via the RESPONSE stream, not the request.
  // req's 'close' fires as soon as express.json() finishes draining the body,
  // which would falsely mark the SSE stream closed and suppress every write.
  let closed = false;
  res.on('close', () => { closed = true; });

  const emit = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  // Heartbeat so proxies/load balancers don't drop a long tool run.
  const heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);

  try {
    audit({
      actorId: req.session.user.id,
      action: 'mcp.chat_turn',
      details: { resume: !!decisions },
      ip: req.ip,
    });
    await runChatTurn({
      session: req.session,
      messages,
      decisions: decisions || null,
      emit,
      isClosed: () => closed,
      onToolExecuted: ({ name, scope }) => {
        audit({
          actorId: req.session.user.id,
          action: 'mcp.chat_tool_called',
          details: { tool: name, scope },
          ip: req.ip,
        });
      },
    });
  } catch (err) {
    const message = err instanceof McpError ? err.message : 'Chat failed.';
    emit('error', { message });
  } finally {
    clearInterval(heartbeat);
    if (!closed) { emit('done', {}); res.end(); }
  }
});

export default router;
