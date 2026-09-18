export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { name, email } = req.body || {};

  // Direct success response (No error, no image required)
  return res.status(200).json({
    success: true,
    message: "Signup successful! Welcome to Aviqo AI.",
    user: { name, email }
  });
}
