// api/me.js
// Looks up a signup's current status by email — used by the frontend to
// refresh the profile pill (name, plan, verified) on page load.
// GET /api/me?email=someone@example.com

import { Client } from 'pg';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  const email = req.query && req.query.email ? String(req.query.email).trim().toLowerCase() : '';
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const result = await client.query(
      `SELECT name, email, plan, verified FROM signups WHERE email = $1`,
      [email]
    );
    await client.end();

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(200).json({ user: result.rows[0] });
  } catch (err) {
    try { await client.end(); } catch (e) {}
    return res.status(500).json({ error: 'Could not fetch profile.' });
  }
}
