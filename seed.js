import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

const hash = await bcrypt.hash(process.env.SEED_PASSWORD || 'ChangeMe123!', 10);
const users = [['Admin', 'admin@example.com', 'admin'], ['Arun', 'arun@example.com', 'agent'],
               ['Meena', 'meena@example.com', 'agent'], ['Karthik', 'karthik@example.com', 'agent']];
for (const [name, email, role] of users)
  await pool.query('INSERT INTO users(name, email, password_hash, role) VALUES($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING', [name, email, hash, role]);
await pool.end();
console.log('Seeded 1 admin and 3 agents');
