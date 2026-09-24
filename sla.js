import { EventEmitter } from 'node:events';
import { q } from './db.js';

// Other modules (e.g. WebSocket alerts in Module 3) can listen: events.on('sla.breach', fn)
export const events = new EventEmitter();

export async function checkBreaches() {
  const { rows } = await q(
    `UPDATE tickets SET breached_at = now()
     WHERE status IN ('open', 'in_progress') AND due_at < now() AND breached_at IS NULL
     RETURNING id, title, assignee_id`
  );
  for (const t of rows) {
    await q(`INSERT INTO comments(ticket_id, body, is_system) VALUES($1, 'SLA breached: the target resolution time has passed.', true)`, [t.id]);
    events.emit('sla.breach', t);
  }
  return rows;
}

export const startSlaMonitor = (ms = 30000) => setInterval(() => checkBreaches().catch(console.error), ms);
