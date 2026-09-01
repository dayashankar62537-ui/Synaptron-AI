// api/signup.js
// Secure backend endpoint — deployed on Vercel.
// Saves a signup into Postgres and sends a verification email via Resend.
// RESEND_API_KEY and POSTGRES_URL are server-side environment variables —
// never sent to the browser.

import { Client } from 'pg';
import crypto from 'crypto';

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

async function sendVerificationEmail({ apiKey, siteUrl, name, email, token }) {
  const verifyUrl = `${siteUrl}/api/verify?token=${encodeURIComponent(token)}`;
  const html = `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
      <h2>Verify your email — Synaptron AI</h2>
      <p>Hi ${name || 'there'},</p>
      <p>Thanks for signing up for Synaptron AI. Please confirm your email address by clicking the button below:</p>
      <p style="margin:24px 0;">
        <a href="${verifyUrl}" style="background:#2563eb; color:#fff; padding:12px 20px; border-radius:8px; text-decoration:none; font-weight:bold;">Verify my email</a>
      </p>
      <p>Or copy this link into your browser:<br>${verifyUrl}</p>
      <p style="color:#888; font-size:12px;">If you didn't sign up for Synaptron AI, you can ignore this email.</p>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      // onboarding@resend.dev works without verifying a custom domain.
      // Once you verify your own domain on resend.com, change this to
      // something like "Synaptron AI <hello@synaptronai.com>".
      from: 'Synaptron AI <onboarding@resend.dev>',
      to: [email],
      subject: 'Verify your email — Synaptron AI',
      html
    })
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error((errData && errData.message) || 'Failed to send verification email');
  }
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

  const token = crypto.randomBytes(24).toString('hex');
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  let signupRow = null;

  try {
    await client.connect();

    const result = await client.query(
      `INSERT INTO signups (name, email, plan, verify_token, verified)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, plan = EXCLUDED.plan
       RETURNING id, name, email, plan, verified, verify_token, created_at`,
      [name, email, plan, token]
    );

    signupRow = result.rows[0];
    await client.end();
  } catch (err) {
    try { await client.end(); } catch (e) {}
    return res.status(500).json({ error: 'Could not save your signup right now. Please try again.' });
  }

  // Try to send the verification email — but don't fail the whole signup
  // if email sending has a problem (e.g. Resend not configured yet).
  const resendKey = process.env.RESEND_API_KEY;
  let emailSent = false;
  let emailError = null;

  if (resendKey && !signupRow.verified) {
    try {
      const siteUrl = `https://${req.headers.host}`;
      await sendVerificationEmail({
        apiKey: resendKey,
        siteUrl,
        name: signupRow.name,
        email: signupRow.email,
        token: signupRow.verify_token
      });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
    }
  }

  return res.status(200).json({
    success: true,
    signup: {
      id: signupRow.id,
      name: signupRow.name,
      email: signupRow.email,
      plan: signupRow.plan,
      verified: signupRow.verified
    },
    emailSent,
    emailError
  });
}
