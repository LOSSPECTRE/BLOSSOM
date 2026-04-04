import express from "express";
import cors from "cors";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import { createHmac } from "crypto";
import admin from "firebase-admin";

dotenv.config();

// ── Firebase Admin ──────────────────────────────────────────────
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log("Firebase Admin ready");
} catch {
  console.warn("Firebase Admin not configured — auth/plan checks disabled");
}

// ── OpenAI (cloud) & Ollama (local) ────────────────────────────
const openaiCloud = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openaiLocal = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });

const MODEL = {
  free: { client: openaiLocal, model: "deepseek-r1:1.5b" },
  pro:  { client: openaiCloud, model: "gpt-4o-mini" },
  max:  { client: openaiCloud, model: "gpt-4o" },
};

// ── Helpers ─────────────────────────────────────────────────────
async function getUserPlan(authHeader) {
  if (!db || !authHeader?.startsWith("Bearer ")) return "free";
  try {
    const token = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(token);
    const doc = await db.collection("users").doc(decoded.uid).get();
    return doc.exists ? (doc.data().plan || "free") : "free";
  } catch {
    return "free";
  }
}

function sendInstant(res, reply) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── App ─────────────────────────────────────────────────────────
const app = express();
app.use(cors());

// raw body needed for Lemon Squeezy webhook signature check
app.use((req, res, next) => {
  if (req.path === "/api/webhook/lemonsqueezy") {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => { req.rawBody = raw; next(); });
  } else {
    express.json()(req, res, next);
  }
});

// ── Quick replies ────────────────────────────────────────────────
const quickReplies = [
  { match: /^(hi|hey|hello|sup|yo|hiya|howdy|heya|hai|helo)[\s!.]*$/i, reply: "Hey! What's up?" },
  { match: /^(hi there|hello there|hey there)[\s!.]*$/i, reply: "Hey there! What can I do for you?" },
  { match: /^(what'?s up|wassup|wsp|wazzup)[\s!.]*$/i, reply: "Not much, just here for you. What do you need?" },
  { match: /how are you|how r u|how are u|you good\??|u good\??|how('?s| is) it going|how do you do|you okay\??|u okay\?/i, reply: "Doing great, ready to help. What do you need?" },
  { match: /how('?s| is) your day/i, reply: "My day's going well! How about yours?" },
  { match: /^(good morning|morning|gm)[\s!.]*$/i, reply: "Good morning! Ready when you are." },
  { match: /^(good night|gn|goodnight|good nite)[\s!.]*$/i, reply: "Good night! Rest up." },
  { match: /^(good afternoon|afternoon)[\s!.]*$/i, reply: "Good afternoon! What can I do for you?" },
  { match: /^(good evening|evening)[\s!.]*$/i, reply: "Good evening! How can I help?" },
  { match: /^(thanks|thank you|thx|ty|cheers|thank u|many thanks|thanks a lot|tysm|ty so much)[\s!.]*$/i, reply: "Anytime! 😊" },
  { match: /^(ok|okay|cool|got it|alright|aight|bet|ight|noted|sure|yep|yup|yeah|ya|yes|roger|copy that)[\s!.]*$/i, reply: "Got it." },
  { match: /^(no|nope|nah|naw)[\s!.]*$/i, reply: "Alright, let me know if you need anything." },
  { match: /^(bye|goodbye|good bye|see you|cya|see ya|later|laters|peace|take care|ttyl|ttys)[\s!.]*$/i, reply: "Later! 👋" },
  { match: /^(i'?m (back|here)|i'?m online)[\s!.]*$/i, reply: "Welcome back! What's up?" },
  { match: /what('?s| is) your name|who are you|what are you/i, reply: "I'm BLOSCOM-AI, your personal assistant." },
  { match: /who (made|created|built|designed) you/i, reply: "Ray built me into Bloscom. Pretty cool, right?" },
  { match: /are you (an? )?(ai|robot|bot|machine|human|real)/i, reply: "I'm an AI — BLOSCOM-AI to be exact." },
  { match: /^(lol|lmao|lmfao|haha|hehe|😂|🤣|💀|😭)[\s!.]*$/i, reply: "😄" },
  { match: /tell me a joke|say something funny/i, reply: "Why do programmers prefer dark mode? Because light attracts bugs. 🐛" },
  { match: /i('?m| am) (sad|upset|down|depressed|not okay)/i, reply: "Sorry to hear that. I'm here if you want to talk." },
  { match: /^(help|help me)[\s!.?]*$/i, reply: "Of course! What do you need help with?" },
  { match: /^(test|testing|ping|you there\??)[\s!.]*$/i, reply: "Yep, I'm here! 🟢" },
  { match: /what time is it|current time/i, reply: `It's ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` },
  { match: /what('?s| is) (today'?s? )?(date|day)/i, reply: `Today is ${new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.` },
];

// ── AI endpoint ──────────────────────────────────────────────────
app.post("/api/jarvis", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Message is required." });

    const trimmed = message.trim();
    for (const { match, reply } of quickReplies) {
      if (match.test(trimmed)) return sendInstant(res, reply);
    }

    const plan = await getUserPlan(req.headers.authorization);
    const { client, model } = MODEL[plan] || MODEL.free;

    const messages = [
      {
        role: "system",
        content: "You are BLOSCOM-AI, a personal assistant inside Bloscom dashboard. Keep all replies short and direct — 1 to 3 sentences max. No bullet points, no lists, no long explanations unless the user specifically asks for detail.",
      },
      ...history.map(item => ({ role: item.role, content: item.content })),
      { role: "user", content: message },
    ];

    const stream = await client.chat.completions.create({ model, messages, stream: true });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let buf = "", inThink = false;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (!content) continue;
      buf += content;
      let out = "";
      while (buf.length > 0) {
        if (inThink) {
          const end = buf.indexOf("</think>");
          if (end !== -1) { buf = buf.slice(end + 8); inThink = false; }
          else { if (buf.length > 8) buf = buf.slice(buf.length - 8); break; }
        } else {
          const start = buf.indexOf("<think>");
          if (start !== -1) { out += buf.slice(0, start); buf = buf.slice(start + 7); inThink = true; }
          else { if (buf.length > 7) { out += buf.slice(0, buf.length - 7); buf = buf.slice(buf.length - 7); } break; }
        }
      }
      if (out) res.write(`data: ${JSON.stringify({ content: out })}\n\n`);
    }
    if (!inThink && buf) res.write(`data: ${JSON.stringify({ content: buf })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();

  } catch (error) {
    console.error("BLOSCOM-AI error:", error);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong." });
  }
});

// ── Lemon Squeezy webhook ────────────────────────────────────────
app.post("/api/webhook/lemonsqueezy", async (req, res) => {
  try {
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers["x-signature"];
      const expected = createHmac("sha256", secret).update(req.rawBody).digest("hex");
      if (sig !== expected) return res.status(401).json({ error: "Invalid signature" });
    }

    const body = JSON.parse(req.rawBody);
    const event = req.headers["x-event-name"];
    const attrs = body.data?.attributes;
    const userEmail = attrs?.user_email;
    const variantId = String(attrs?.variant_id || "");

    // Map your Lemon Squeezy variant IDs to plans — fill these in later
    const VARIANT_PLAN = {
      [process.env.LS_PRO_VARIANT_ID  || "PRO_VARIANT_ID"]:  "pro",
      [process.env.LS_MAX_VARIANT_ID  || "MAX_VARIANT_ID"]:  "max",
    };

    if (!db || !userEmail) return res.json({ ok: true });

    const plan = VARIANT_PLAN[variantId] || "free";
    const isActive = ["subscription_created", "subscription_updated", "order_created"].includes(event);
    const finalPlan = isActive ? plan : "free";

    // Find user by email and update their plan
    const users = await admin.auth().getUserByEmail(userEmail);
    await db.collection("users").doc(users.uid).set({ plan: finalPlan }, { merge: true });
    console.log(`Updated ${userEmail} → ${finalPlan}`);

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bloscom server running on http://localhost:${PORT}`));
