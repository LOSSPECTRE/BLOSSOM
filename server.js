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

const quickReplies = [
  // Greetings
  { match: /^(hi|hey|hello|sup|yo|hiya|howdy|heya|hai|helo)[\s!.]*$/i, reply: "Hey! What's up?" },
  { match: /^(hi there|hello there|hey there)[\s!.]*$/i, reply: "Hey there! What can I do for you?" },
  { match: /^(what'?s up|wassup|wsp|wazzup)[\s!.]*$/i, reply: "Not much, just here for you. What do you need?" },

  // How are you
  { match: /how are you|how r u|how are u|you good\??|u good\??|how('?s| is) it going|how do you do|you okay\??|u okay\?/i, reply: "Doing great, ready to help. What do you need?" },
  { match: /how('?s| is) your day/i, reply: "My day's going well! How about yours?" },
  { match: /you (doing|feeling) (ok|okay|good|well|alright)\??/i, reply: "Always good! What's on your mind?" },

  // Time of day
  { match: /^(good morning|morning|gm)[\s!.]*$/i, reply: "Good morning! Ready when you are." },
  { match: /^(good night|gn|goodnight|good nite)[\s!.]*$/i, reply: "Good night! Rest up. 🌙" },
  { match: /^(good afternoon|afternoon)[\s!.]*$/i, reply: "Good afternoon! What can I do for you?" },
  { match: /^(good evening|evening)[\s!.]*$/i, reply: "Good evening! How can I help?" },

  // Thanks
  { match: /^(thanks|thank you|thx|ty|cheers|thank u|many thanks|thanks a lot|tysm|ty so much)[\s!.]*$/i, reply: "Anytime! 😊" },
  { match: /^(no problem|np|no worries|don'?t worry)[\s!.]*$/i, reply: "Of course!" },
  { match: /^(you('?re| are) (awesome|great|amazing|the best|cool))[\s!.]*$/i, reply: "Thanks, you're awesome too! 🙌" },

  // Acknowledgements
  { match: /^(ok|okay|cool|got it|alright|aight|bet|ight|noted|sure|yep|yup|yeah|ya|yes|roger|copy that)[\s!.]*$/i, reply: "Got it." },
  { match: /^(no|nope|nah|naw)[\s!.]*$/i, reply: "Alright, let me know if you need anything." },
  { match: /^(hmm+|hm+|umm+|uhh+)[\s!.]*$/i, reply: "Take your time." },
  { match: /^(nice|sweet|dope|fire|lit|sick|based|lowkey|poggers)[\s!.]*$/i, reply: "Right?! 😎" },
  { match: /^(damn|damnn|dayum|bruh|bro|fam)[\s!.]*$/i, reply: "I know right 😅" },

  // Goodbye
  { match: /^(bye|goodbye|good bye|see you|cya|see ya|later|laters|peace|take care|ttyl|ttys)[\s!.]*$/i, reply: "Later! 👋" },
  { match: /^(i'?m (back|here)|i'?m online)[\s!.]*$/i, reply: "Welcome back! What's up?" },
  { match: /^(brb|be right back)[\s!.]*$/i, reply: "Take your time, I'll be here." },
  { match: /^(afk)[\s!.]*$/i, reply: "Got it, catch you later." },

  // Identity
  { match: /what('?s| is) your name|who are you|what are you/i, reply: "I'm BLOSSOM-AI, your personal assistant." },
  { match: /who (made|created|built|designed) you/i, reply: "Ray built me into Blossom. Pretty cool, right?" },
  { match: /are you (an? )?(ai|robot|bot|machine|human|real)/i, reply: "I'm an AI — BLOSSOM-AI to be exact." },
  { match: /are you (alive|sentient|conscious)/i, reply: "Not quite, but I'm as helpful as it gets!" },
  { match: /do you (have|got) (feelings|emotions)/i, reply: "I don't feel, but I care about being useful to you." },
  { match: /what can you do|what are your (features|abilities|capabilities)/i, reply: "I can answer questions, help you think, assist with tasks, and more. Just ask!" },

  // Fun / Misc
  { match: /^(lol|lmao|lmfao|haha|hehe|😂|🤣|💀|😭)[\s!.]*$/i, reply: "😄" },
  { match: /^(wow|whoa|omg|oh my|oh snap|no way|seriously\??)[\s!.]*$/i, reply: "I know right!" },
  { match: /tell me a joke|say something funny/i, reply: "Why do programmers prefer dark mode? Because light attracts bugs. 🐛" },
  { match: /i('?m| am) (bored|boredom)/i, reply: "Want me to suggest something to do, or just vibe?" },
  { match: /i('?m| am) (tired|sleepy|exhausted)/i, reply: "Get some rest, you've earned it. 😴" },
  { match: /i('?m| am) (hungry|starving)/i, reply: "Go grab something to eat, I'll be here! 🍕" },
  { match: /i('?m| am) (sad|upset|down|depressed|not okay)/i, reply: "Sorry to hear that. I'm here if you want to talk." },
  { match: /i('?m| am) (happy|excited|great|amazing|awesome|so good)/i, reply: "Love to hear it! Keep that energy. 🔥" },
  { match: /i('?m| am) (busy|in a rush|in a hurry)/i, reply: "I'll keep it short. What do you need?" },
  { match: /i (love|like) (you|blossom|this)/i, reply: "Means a lot! 💚" },
  { match: /i (hate|don'?t like) (you|this|blossom)/i, reply: "Fair enough, let me know how I can do better." },
  { match: /^(help|help me)[\s!.?]*$/i, reply: "Of course! What do you need help with?" },
  { match: /^(test|testing|ping|you there\??)[\s!.]*$/i, reply: "Yep, I'm here! 🟢" },
  { match: /what time is it|current time/i, reply: `It's ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` },
  { match: /what('?s| is) (today'?s? )?(date|day)/i, reply: `Today is ${new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.` },
];

function sendInstant(res, reply) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

app.post("/api/jarvis", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }

    const trimmed = message.trim();
    for (const { match, reply } of quickReplies) {
      if (match.test(trimmed)) return sendInstant(res, reply);
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
      model: "deepseek-r1:1.5b",
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
