import { Router } from 'express';
import { q } from './db.js';
import { authenticate, requireRole } from './auth.js';

export const tickets = Router();
tickets.use(authenticate);

const isStaff = (u) => u.role !== 'requester';
const NEXT = { open: ['in_progress'], in_progress: ['resolved', 'open'], resolved: ['closed', 'in_progress'], closed: [] };

const SELECT = `
  SELECT t.*, c.name AS category, r.name AS requester_name, a.name AS assignee_name,
         GREATEST(0, EXTRACT(EPOCH FROM (t.due_at - now())))::int AS seconds_left,
         (COALESCE(t.resolved_at, now()) > t.due_at) AS sla_breached
  FROM tickets t
  JOIN categories c ON c.id = t.category_id
  JOIN users r ON r.id = t.requester_id
  LEFT JOIN users a ON a.id = t.assignee_id
  JOIN priorities p ON p.name = t.priority`;

// Returns the ticket, or null if it does not exist or the requester does not own it.
async function load(id, user) {
  const { rows } = await q(`${SELECT} WHERE t.id = $1`, [id]);
  const t = rows[0];
  return !t || (!isStaff(user) && t.requester_id !== user.id) ? null : t;
}
const note = (ticketId, body, authorId = null) =>
  q('INSERT INTO comments(ticket_id, author_id, body, is_system) VALUES($1, $2, $3, $4)', [ticketId, authorId, body, authorId === null]);
const notFound = (res) => res.status(404).json({ error: 'Ticket not found' });

// Create a ticket, then assign it to the agent who was assigned least recently (round-robin).
tickets.post('/', async (req, res) => {
  const { title, description, category_id, priority = 'medium' } = req.body || {};
  if (!title?.trim() || !description?.trim() || !category_id)
    return res.status(400).json({ error: 'Title, description and category are required' });
  const p = await q('SELECT sla_minutes FROM priorities WHERE name = $1', [priority]);
  if (!p.rows[0]) return res.status(400).json({ error: 'Priority must be critical, high, medium or low' });

  const ag = await q(
    `UPDATE users SET last_assigned_at = now()
     WHERE id = (SELECT id FROM users WHERE role = 'agent' ORDER BY last_assigned_at NULLS FIRST, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, name`
  );
  const agent = ag.rows[0];
  const { rows } = await q(
    `INSERT INTO tickets(title, description, category_id, priority, requester_id, assignee_id, due_at)
     VALUES($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7)) RETURNING id`,
    [title.trim(), description.trim(), category_id, priority, req.user.id, agent?.id ?? null, p.rows[0].sla_minutes]
  );
  await note(rows[0].id, agent ? `Ticket created and assigned to ${agent.name} (round-robin).` : 'Ticket created. No agent is available yet.');
  res.status(201).json(await load(rows[0].id, req.user));
});

// Queue: open tickets first, then by priority rank, then by SLA deadline.
// Filters: ?status=&priority=&assignee=me|none&breached=true
tickets.get('/', async (req, res) => {
  const w = [], v = [];
  const add = (cond, val) => { v.push(val); w.push(cond.replace('?', `$${v.length}`)); };
  if (!isStaff(req.user)) add('t.requester_id = ?', req.user.id);
  const { status, priority, assignee, breached } = req.query;
  if (status) add('t.status = ?', status);
  if (priority) add('t.priority = ?', priority);
  if (assignee === 'me') add('t.assignee_id = ?', req.user.id);
  if (assignee === 'none') w.push('t.assignee_id IS NULL');
  if (breached === 'true') w.push('(COALESCE(t.resolved_at, now()) > t.due_at)');
  const { rows } = await q(
    `${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
     ORDER BY (t.status IN ('open', 'in_progress')) DESC, p.rank, t.due_at`, v);
  res.json(rows);
});

tickets.get('/stats/summary', requireRole('agent', 'admin'), async (_req, res) => {
  const { rows } = await q(
    `SELECT count(*) FILTER (WHERE status = 'open') AS open,
            count(*) FILTER (WHERE status = 'in_progress') AS in_progress,
            count(*) FILTER (WHERE status IN ('open', 'in_progress') AND now() > due_at) AS breached,
            count(*) FILTER (WHERE status IN ('open', 'in_progress') AND assignee_id IS NULL) AS unassigned
     FROM tickets`);
  res.json(rows[0]);
});

tickets.get('/:id', async (req, res) => {
  const t = await load(+req.params.id, req.user);
  if (!t) return notFound(res);
  const c = await q(
    `SELECT c.id, c.body, c.is_system, c.created_at, u.name AS author, u.role AS author_role
     FROM comments c LEFT JOIN users u ON u.id = c.author_id
     WHERE c.ticket_id = $1 ORDER BY c.created_at, c.id`, [t.id]);
  res.json({ ...t, comments: c.rows });
});

// Status workflow: open -> in_progress -> resolved -> closed. Requesters may only close or reopen a resolved ticket.
tickets.patch('/:id/status', async (req, res) => {
  const t = await load(+req.params.id, req.user);
  if (!t) return notFound(res);
  const to = req.body?.status;
  if (!NEXT[t.status].includes(to))
    return res.status(409).json({ error: `Cannot move a ${t.status} ticket to ${to}`, allowed: NEXT[t.status] });
  if (!isStaff(req.user) && t.status !== 'resolved')
    return res.status(403).json({ error: 'Requesters can only close or reopen a resolved ticket' });
  await q(
    `UPDATE tickets SET status = $2::ticket_status, updated_at = now(),
       resolved_at = CASE WHEN $2::ticket_status = 'resolved' THEN now()
                          WHEN $2::ticket_status = 'in_progress' AND status = 'resolved' THEN NULL
                          ELSE resolved_at END
     WHERE id = $1`, [t.id, to]);
  await note(t.id, `${req.user.name} moved the ticket from ${t.status} to ${to}.`);
  res.json(await load(t.id, req.user));
});

// Admins can assign any agent (or clear the assignee). Agents can only take a ticket for themselves.
tickets.patch('/:id/assignee', requireRole('agent', 'admin'), async (req, res) => {
  const t = await load(+req.params.id, req.user);
  if (!t) return notFound(res);
  const to = req.user.role === 'agent' ? req.user.id : (req.body?.assignee_id ?? null);
  let name = null;
  if (to !== null) {
    const a = await q(`SELECT name FROM users WHERE id = $1 AND role = 'agent'`, [to]);
    if (!a.rows[0]) return res.status(400).json({ error: 'The assignee must be an agent' });
    name = a.rows[0].name;
  }
  await q('UPDATE tickets SET assignee_id = $2, updated_at = now() WHERE id = $1', [t.id, to]);
  await note(t.id, name ? `${req.user.name} assigned the ticket to ${name}.` : `${req.user.name} unassigned the ticket.`);
  res.json(await load(t.id, req.user));
});

// Escalation: raise priority one level and recalculate the SLA deadline from creation time.
tickets.post('/:id/escalate', requireRole('agent', 'admin'), async (req, res) => {
  const t = await load(+req.params.id, req.user);
  if (!t) return notFound(res);
  if (!['open', 'in_progress'].includes(t.status)) return res.status(409).json({ error: 'Only open tickets can be escalated' });
  const up = await q('SELECT name, sla_minutes FROM priorities WHERE rank = (SELECT rank - 1 FROM priorities WHERE name = $1)', [t.priority]);
  if (!up.rows[0]) return res.status(409).json({ error: 'This ticket is already at the highest priority' });
  await q(
    `UPDATE tickets SET priority = $2, due_at = created_at + make_interval(mins => $3),
       breached_at = NULL, escalated_count = escalated_count + 1, updated_at = now() WHERE id = $1`,
    [t.id, up.rows[0].name, up.rows[0].sla_minutes]);
  await note(t.id, `${req.user.name} escalated priority from ${t.priority} to ${up.rows[0].name}.`);
  res.json(await load(t.id, req.user));
});

tickets.post('/:id/comments', async (req, res) => {
  const t = await load(+req.params.id, req.user);
  if (!t) return notFound(res);
  const body = req.body?.body?.trim();
  if (!body) return res.status(400).json({ error: 'Write a comment first' });
  if (t.status === 'closed') return res.status(409).json({ error: 'Closed tickets cannot receive comments' });
  await note(t.id, body, req.user.id);
  res.status(201).json({ ok: true });
});
