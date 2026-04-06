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
    express.json({ limit: "20mb" })(req, res, next);
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

// ── Quick pattern planner (no AI needed) ────────────────────────
function quickPlan(instruction, elements) {
  const q = instruction.toLowerCase().trim();

  // "search [query]" or "search for [query]"
  const searchMatch = q.match(/^search(?:\s+for)?\s+(.+)/);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    const box = elements?.find(e =>
      (e.tag === "input" || e.tag === "textarea") &&
      (e.placeholder?.toLowerCase().includes("search") ||
       e.label?.toLowerCase().includes("search") ||
       e.type === "search")
    ) || elements?.find(e => e.tag === "input");
    if (box) return [
      { type: "click", index: box.index, description: `Click search box` },
      { type: "type",  index: box.index, text: query, description: `Type "${query}"` },
      { type: "key",   index: box.index, key: "Enter", description: "Press Enter to search" }
    ];
  }

  // "click [label]"
  const clickMatch = q.match(/^click\s+(?:on\s+)?(.+)/);
  if (clickMatch) {
    const label = clickMatch[1].trim();
    const el = elements?.find(e =>
      e.text?.toLowerCase().includes(label) || e.label?.toLowerCase().includes(label)
    );
    if (el) return [{ type: "click", index: el.index, description: `Click "${el.text || label}"` }];
  }

  // "type [text] in [field]" or "fill [field] with [text]"
  const typeMatch = q.match(/^type\s+(.+?)\s+in\s+(.+)/) || q.match(/^fill\s+(.+?)\s+with\s+(.+)/);
  if (typeMatch) {
    const [, a, b] = typeMatch;
    const [text, field] = q.startsWith("fill") ? [b, a] : [a, b];
    const el = elements?.find(e =>
      e.text?.toLowerCase().includes(field) || e.placeholder?.toLowerCase().includes(field) || e.label?.toLowerCase().includes(field)
    ) || elements?.find(e => e.tag === "input");
    if (el) return [
      { type: "click", index: el.index, description: `Click "${field}" field` },
      { type: "type",  index: el.index, text: text.trim(), description: `Type "${text.trim()}"` }
    ];
  }

  // "go to [url]" / "open [url]" / "navigate to [url]"
  const navMatch = q.match(/^(?:go to|open|navigate to|visit)\s+(.+)/);
  if (navMatch) {
    let url = navMatch[1].trim();
    if (!url.startsWith("http")) url = "https://" + url;
    return [{ type: "navigate", url, description: `Go to ${url}` }];
  }

  return null; // no pattern matched, fall back to AI
}

// ── Agent endpoint (vision + action planning) ────────────────────
app.post("/api/agent/plan", async (req, res) => {
  try {
    const { instruction, screenshot, elements, title } = req.body;
    if (!instruction) return res.status(400).json({ error: "instruction required" });

    console.log(`Plan request: "${instruction}" | elements: ${elements?.length ?? 0} | screenshot: ${!!screenshot}`);
    if (elements?.length) console.log("First 3 elements:", JSON.stringify(elements.slice(0, 3)));

    // Try pattern matching first — instant, no AI needed
    const quick = quickPlan(instruction, elements);
    if (quick) {
      console.log("Quick plan matched:", quick.map(s => s.description).join(", "));
      return res.json({ steps: quick, screenDescription: "" });
    }
    console.log("No quick plan match, falling back to AI");

    // Step 1: Use moondream to describe what's on screen
    let screenDescription = "";
    if (screenshot) {
      try {
        const visionRes = await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "moondream",
            prompt: "Describe the key UI elements visible on this screen. Focus on buttons, text fields, menus, and interactive elements. Be concise.",
            images: [screenshot.replace(/^data:image\/\w+;base64,/, "")],
            stream: false
          })
        });
        const vd = await visionRes.json();
        screenDescription = vd.response || "";
      } catch (e) {
        console.warn("Vision model error:", e.message);
      }
    }

    // Step 2: Use deepseek to plan the steps
    const elementList = elements?.map(e =>
      `[${e.index}] ${e.tag} "${e.text || e.placeholder || e.label || ""}" at (${e.x},${e.y})`
    ).join("\n") || "No elements provided";

    // Limit element list to 60 most relevant to keep prompt short and model fast
    const planPrompt = `Browser agent. Output ONLY a JSON array, no explanation.
Page: ${title}
${screenDescription ? `Screen: ${screenDescription}` : ""}
Task: "${instruction}"

Clickable elements (use index to target them):
${elementList.split("\n").slice(0, 60).join("\n")}

Step types:
- {"type":"click","index":3,"description":"..."} — click an element by index
- {"type":"click_at","x":500,"y":300,"description":"..."} — click at screen coordinates (use when no element matches)
- {"type":"type","index":5,"text":"...","description":"..."}
- {"type":"scroll","direction":"down","amount":300,"description":"..."}
- {"type":"wait","ms":800,"description":"..."}

Only output the JSON array. Max 5 steps.`;

    const planRes = await openaiLocal.chat.completions.create({
      model: "deepseek-r1:1.5b",
      messages: [{ role: "user", content: planPrompt }],
      stream: false,
      max_tokens: 250
    });

    let raw = planRes.choices[0]?.message?.content || "[]";
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // Strip ```json ... ``` code fences
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    console.log("Raw plan response:", raw.slice(0, 400));

    // Try to extract and parse JSON array
    let steps = [];
    try {
      // Extract the JSON array portion
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        // Strip JS-style // comments (invalid JSON)
        const cleaned = match[0].replace(/\/\/[^\n]*/g, "");
        steps = JSON.parse(cleaned);
      }
    } catch (parseErr) {
      console.warn("JSON parse failed:", parseErr.message);
      steps = [];
    }

    // Only allow valid step types; normalize aliases; description is optional
    const VALID_TYPES = new Set(["click", "click_at", "type", "key", "scroll", "wait", "navigate"]);
    steps = steps
      .filter(s => s && s.type)
      .map(s => ({
        ...s,
        type: s.type === "button" ? "click" : s.type,
        description: s.description || s.type
      }))
      .filter(s => VALID_TYPES.has(s.type))
      .slice(0, 5);

    console.log("Parsed steps:", steps.length, steps.map(s => s.type + ": " + s.description).join(", "));
    res.json({ steps, screenDescription });

  } catch (err) {
    console.error("Agent plan error:", err.message);
    res.status(500).json({ error: err.message, steps: [] });
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
