# Helpdesk backend (Modules 1 and 2)

1. `cp .env.example .env` and edit `DATABASE_URL` and `JWT_SECRET`
2. Create the database: `createdb helpdesk`
3. `npm install`
4. `npm run db:init` (creates tables, priorities and categories)
5. `npm run seed` (creates 1 admin and 3 agents)
6. `npm run dev` (API on http://localhost:4000)

Main endpoints: POST /auth/register, POST /auth/login, POST /auth/users (admin),
GET|POST /tickets, GET /tickets/:id, PATCH /tickets/:id/status, PATCH /tickets/:id/assignee,
POST /tickets/:id/escalate, POST /tickets/:id/comments, GET /tickets/stats/summary.
