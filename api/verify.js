// api/verify.js
// Handles the verification link clicked from the email.
// GET /api/verify?token=xxxx

import { Client } from 'pg';

function htmlPage(title, message, ok) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body{font-family:sans-serif; background:#f6f8fc; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
  .card{background:#fff; padding:40px; border-radius:16px; text-align:center; max-width:400px; box-shadow:0 20px 50px rgba(0,0,0,0.08);}
  .icon{width:56px; height:56px; border-radius:50%; margin:0 auto 18px; display:flex; align-items:center; justify-content:center; color:#fff; font-size:26px; font-weight:bold; background:${ok ? '#16a34a' : '#dc2626'};}
  h2{margin:0 0 10px;}
  p{color:#666;}
  a{color:#2563eb; text-decoration:none; font-weight:600;}
</style></head>
<body>
  <div class="card">
    <div class="icon">${ok ? '✓' : '✕'}</div>
    <h2>${title}</h2>
    <p>${message}</p>
    <p><a href="/">Return to Synaptron AI</a></p>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(htmlPage('Server error', 'Database is not configured.', false));
  }

  const token = req.query && req.query.token ? String(req.query.token) : '';
  if (!token) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(htmlPage('Invalid link', 'This verification link is missing a token.', false));
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const result = await client.query(
      `UPDATE signups SET verified = true, verify_token = NULL
       WHERE verify_token = $1
       RETURNING email`,
      [token]
    );
    await client.end();

    res.setHeader('Content-Type', 'text/html');
    if (result.rows.length === 0) {
      return res.status(400).send(htmlPage('Link already used', 'This verification link is invalid or has already been used.', false));
    }
    return res.status(200).send(htmlPage('Email verified!', `${result.rows[0].email} has been verified. You're all set.`, true));
  } catch (err) {
    try { await client.end(); } catch (e) {}
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(htmlPage('Something went wrong', 'Please try again later.', false));
  }
}
