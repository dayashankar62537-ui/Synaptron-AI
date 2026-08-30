# Synaptron AI — Deploy Guide (10 minute setup)

Ye project 2 hisso mein hai:
- `index.html` — full website (frontend)
- `api/chat.js` — secure backend jo Gemini API call karta hai

**Zaroori: aap ne pehle jo API key chat mein paste ki thi, wo ab compromised hai.**
Deploy karne se pehle:
1. https://aistudio.google.com/app/apikey pe jao
2. Purani key **delete** karo
3. **Naya key generate** karo — isi naye key ko neeche steps mein use karna hai (kisi ko bhi mat dena — mujhe bhi nahi)

---

## Step-by-step: Vercel pe deploy karna (free)

1. **Vercel account banao** — https://vercel.com (GitHub se sign up kar sakte ho)

2. **Ye project GitHub pe upload karo:**
   - GitHub pe ek naya repository banao (e.g. `synaptron-ai`)
   - Is folder (`index.html`, `api/chat.js`, `package.json`) ko us repo mein upload/push karo

3. **Vercel mein "Add New Project" karo:**
   - Apna GitHub repo select karo
   - Framework: "Other" ya "No Framework" select karo (kuch configure karne ki zarurat nahi)

4. **Environment Variable add karo (SABSE IMPORTANT STEP):**
   - Project settings mein "Environment Variables" section mein jao
   - Key: `GEMINI_API_KEY`
   - Value: apni **nayi** Gemini API key paste karo
   - Save karo

5. **Deploy** button dabao. 1-2 minute mein live ho jayega.

6. Aapko ek URL milega jaisa `https://synaptron-ai.vercel.app` — yehi aapki live website hai.

---

## Ye kaise kaam karta hai (security)

- Aapki API key sirf Vercel ke server pe, environment variable ke andar rehti hai
- Website (jo browser mein chalti hai) us key ko **kabhi nahi dekhti**
- Jab user chatbox mein type karta hai, browser `/api/chat` ko call karta hai
- `/api/chat` (jo server pe chalta hai) key use karke Gemini ko call karta hai, aur jawab wapas bhej deta hai
- Isliye "View Page Source" karne se bhi koi key nahi dikhegi

## Important — abhi bhi kya real nahi hai

- **Chat/Q&A ab real hai** — Gemini se actual jawab aayega
- **Image, video, website, app "generation"** abhi bhi real nahi hai — Gemini ka text API sirf text jawab de sakta hai, real image/video/app files nahi banata. Agar user "image bana do" bole, AI text mein jawab dega ki abhi wo capability connect ho rahi hai
- Real image generation ke liye alag se Google Imagen API chahiye hogi, real video ke liye Veo API — dono ki alag setup aur billing hoti hai

## Local testing (optional, agar Node.js installed hai)

```
npm install -g vercel
vercel dev
```
Fir browser mein `http://localhost:3000` khol ke test kar sakte ho (isse pehle `.env` file mein `GEMINI_API_KEY=your_new_key` daalna hoga, ya terminal mein export karna hoga).
