export default async function handler(req, res) {
  // Only allow POST request
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { name, email } = req.body || {};

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' });
    }

    // Console log for incoming signups
    console.log("New Signup Received:", { name, email });

    // Success response
    return res.status(200).json({
      success: true,
      message: "Signup successful! We will notify you when your plan is ready.",
      user: { name, email }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Server error. Please try again." });
  }
}
