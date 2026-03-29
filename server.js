import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
});

app.post("/api/jarvis", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }

    const messages = [
      {
        role: "system",
        content:
          "You are BLOSSOM-AI, a personal assistant inside Blossom dashboard. Keep all replies short and direct — 1 to 3 sentences max. No bullet points, no lists, no long explanations unless the user specifically asks for detail.",
      },
      ...history.map((item) => ({
        role: item.role,
        content: item.content,
      })),
      {
        role: "user",
        content: message,
      },
    ];

    const stream = await client.chat.completions.create({
      model: "deepseek-r1:7b",
      messages,
      stream: true,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let buf = "";
    let inThink = false;

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
          if (start !== -1) {
            out += buf.slice(0, start);
            buf = buf.slice(start + 7);
            inThink = true;
          } else {
            if (buf.length > 7) { out += buf.slice(0, buf.length - 7); buf = buf.slice(buf.length - 7); }
            break;
          }
        }
      }

      if (out) res.write(`data: ${JSON.stringify({ content: out })}\n\n`);
    }

    if (!inThink && buf) res.write(`data: ${JSON.stringify({ content: buf })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("BLOSSOM-AI error:", error);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jarvis server running on http://localhost:${PORT}`);
});
