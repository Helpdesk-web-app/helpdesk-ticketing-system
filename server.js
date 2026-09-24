import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { q } from './db.js';
import { auth } from './auth.js';
import { tickets } from './tickets.js';
import { startSlaMonitor, events } from './sla.js';

const app = express();
app.use(cors(), express.json());

app.get('/health', async (_req, res) => { await q('SELECT 1'); res.json({ ok: true }); });
app.get('/categories', async (_req, res) => res.json((await q('SELECT id, name FROM categories ORDER BY name')).rows));
app.use('/auth', auth);
app.use('/tickets', tickets);

app.use((err, _req, res, _next) => {
  if (['22P02', '23503'].includes(err.code)) return res.status(400).json({ error: 'Invalid input' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

events.on('sla.breach', (t) => console.log(`SLA breach on ticket #${t.id}: ${t.title}`));
startSlaMonitor();
app.listen(process.env.PORT || 4000, () => console.log('Helpdesk API is running'));
