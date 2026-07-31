import express from 'express';
import basicAuth from 'express-basic-auth';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const app = express();

app.use(
  basicAuth({
    users: { [process.env.DASHBOARD_USER]: process.env.DASHBOARD_PASSWORD },
    challenge: true,
  })
);

app.get('/', async (req, res) => {
  const contacts = await pool.query('select id, name, phone_number, role, created_at from contacts order by created_at desc limit 50');
  const rows = contacts.rows
    .map((c) => `<tr><td>${c.name ?? ''}</td><td>${c.phone_number ?? ''}</td><td>${c.role}</td></tr>`)
    .join('');
  res.send(`
    <html>
      <head><title>ERA Client Dashboard</title></head>
      <body style="font-family: sans-serif; padding: 2rem;">
        <h1>Dashboard</h1>
        <p>This is the starter dashboard. Contacts (${contacts.rowCount}):</p>
        <table border="1" cellpadding="6" cellspacing="0">
          <tr><th>Name</th><th>Phone</th><th>Role</th></tr>
          ${rows}
        </table>
      </body>
    </html>
  `);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Dashboard listening on ${port}`));
