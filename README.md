# Aviqo AI — Project Guide

Aviqo AI ki full website + backend. Isme ye sab real hai: AI chat, real image
generation, real video generation, email signup with verification, aur
Postgres database.

## Files

- `index.html` — poori website (frontend)
- `api/chat.js` — AI chat + photo understanding (Groq)
- `api/generate-image.js` — real image generation (OpenAI)
- `api/video-start.js` + `api/video-status.js` — real video generation (Pixazo, free tier)
- `api/signup.js` — signup save + verification email bhejta hai (Postgres + Resend)
- `api/verify.js` — verification link click handle karta hai
- `api/me.js` — profile status check karta hai (verified ya nahi)
- `package.json` — dependencies (`pg` — Postgres ke liye)

---

## Environment Variables (Vercel Settings → Environment Variables)

In sabko exactly inhi naamo se add karna hai:

| Key | Kis liye | Kaha se milegi |
|---|---|---|
| `GROQ_API_KEY` | AI chat | console.groq.com |
| `OPENAI_API_KEY` | Image generation | platform.openai.com |
| `PIXAZO_API_KEY` | Video generation | pixazo.ai |
| `RESEND_API_KEY` | Verification email | resend.com |
| `POSTGRES_URL` ya `DATABASE_URL` | Signup database | Vercel Storage se auto-add hoti hai jab Postgres connect karte ho |

⚠️ **Koi bhi API key chat mein kabhi paste mat karna** — sirf Vercel ke
Environment Variables mein daalni hai. Agar galti se paste ho jaye, turant
us provider ki site pe jaake key delete/regenerate kar dena.

---

## Database Setup (ek baar karna hai)

Vercel dashboard → project → **Storage** tab → Postgres database create karo
(free tier). Connect hone ke baad, **Query** tab mein ye run karo:

```sql
CREATE TABLE signups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  plan TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE signups ADD COLUMN verified BOOLEAN DEFAULT false;
ALTER TABLE signups ADD COLUMN verify_token TEXT;
```

---

## Deploy karne ke steps

1. **GitHub** pe ek repository banao, ye saari files upload karo
2. **Vercel** pe jao → "Add New Project" → apna GitHub repo import karo
3. Upar diye saare **Environment Variables** add karo
4. **Deploy** dabao
5. Har baar jab bhi files update karo (GitHub pe), Vercel → Deployments →
   latest deployment → `...` → **Redeploy** karna mat bhoolna

---

## Ye kaise kaam karta hai (security)

- Saari API keys sirf Vercel ke server pe rehti hain, environment variables
  ke andar — browser/website inhe kabhi nahi dekhti
- Jab user chatbox use karta hai, browser `/api/chat`, `/api/generate-image`,
  ya `/api/video-start` ko call karta hai — wahi (server pe) asli key use
  hoti hai
- Isliye "View Page Source" karne se bhi koi key kahin nahi dikhegi

---

## Abhi kya real hai, kya nahi

✅ **Real hai:**
- AI Chat (Groq) — koi bhi sawaal poocho, asli jawab milega
- Photo samajhna (attach karke poochne pe)
- Image generation (OpenAI)
- Video generation (Pixazo free model — 30-90 second lagte hain)
- Signup + email verification (real email jaata hai)

❌ **Abhi real nahi hai (website/pricing mein clearly likha hai):**
- Website building
- App building
- Study tools
- Personal assistant

❌ **Payment automatic nahi hai:**
- Razorpay Payment Links se payment le sakte ho, lekin payment hone ke baad
  user ka plan **database mein manually update** karna padta hai abhi —
  automatic nahi hai (uske liye Razorpay Webhook integrate karna padega,
  jo ek future step hai)

---

## Local testing (optional, agar Node.js installed hai)

```
npm install -g vercel
vercel dev
```
Fir `http://localhost:3000` khol ke test kar sakte ho — isse pehle `.env`
file mein saari upar wali keys daalni hongi.
