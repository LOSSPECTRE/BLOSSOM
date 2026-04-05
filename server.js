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

// ── AI endpoint ──────────────────────────────────────────────────
app.post("/api/jarvis", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Message is required." });

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

    const response = await client.chat.completions.create({ model, messages, stream: false });
    let reply = response.choices[0]?.message?.content || "";

    // Strip all <think>...</think> blocks (including malformed ones)
    reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
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
