// api/signup.js
// Secure backend endpoint — deployed on Vercel.
// Saves a signup (name, email, plan) into the Postgres database that's
// connected to this Vercel project (POSTGRES_URL is auto-injected by the
// Prisma Postgres / Vercel Storage integration).

import { Client } from 'pg';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '100kb'
    }
  }
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return res.status(500).json({
      error: 'Server is not configured. Connect a Postgres database to this Vercel project.'
    });
  }

  let name = '';
  let email = '';
  let plan = 'free';

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    name = (body && body.name) ? String(body.name).trim() : '';
    email = (body && body.email) ? String(body.email).trim().toLowerCase() : '';
    plan = (body && body.plan) ? String(body.plan).trim() : 'free';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  if (!name || name.length > 200) {
    return res.status(400).json({ error: 'Please enter a valid name.' });
  }
  if (!email || !isValidEmail(email) || email.length > 200) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // If this email already signed up, just update their chosen plan
    // instead of erroring out.
    const result = await client.query(
      `INSERT INTO signups (name, email, plan)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan
       RETURNING id, name, email, plan, created_at`,
      [name, email, plan]
    );

    await client.end();

    return res.status(200).json({ success: true, signup: result.rows[0] });
  } catch (err) {
    try { await client.end(); } catch (e) {}
    return res.status(500).json({ error: 'Could not save your signup right now. Please try again.' });
  }
}
