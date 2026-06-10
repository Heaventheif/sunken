const axios  = require("axios");
const fs     = require("fs-extra");
const path   = require("path");

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
].filter(k => k && k.length > 10);

const GROQ_API_KEY = process.env.GROQ_API_KEY;
let keyIndex = 0;
const nextKey = () => {
  if (!GEMINI_KEYS.length) return null;
  const k = GEMINI_KEYS[keyIndex];
  keyIndex = (keyIndex + 1) % GEMINI_KEYS.length;
  return k;
};

const sessionsDir = path.join(__dirname, "..", "cache", "ai_sessions");
fs.ensureDirSync(sessionsDir);

const getSessionPath = (tid) => path.join(sessionsDir, `thread_${tid}.json`);
async function loadSession(tid) {
  try { if (await fs.pathExists(getSessionPath(tid))) return await fs.readJson(getSessionPath(tid)); } catch (_) {}
  return [];
}
async function saveSession(tid, ctx) {
  await fs.writeJson(getSessionPath(tid), ctx.slice(-10), { spaces: 0 }).catch(() => {});
}

const SYSTEM = `أنت بوت مساعد ذكي على فيسبوك ماسنجر اسمك "Sunken".
- أجب بإيجاز باللغة العربية (أقل من 200 كلمة).
- إذا أُرسلت لك صورة حللها وصفها بدقة.
- كن ودوداً ومهذباً ومفيداً.`;

// ─── بناء parts — يستخدم URL مباشرة بدون base64 ─────────────
async function buildParts(text, attachments) {
  const parts = [];
  if (text?.trim()) parts.push({ text: text.trim() });

  for (const att of attachments) {
    const type = (att.type || "").toLowerCase();
    // استخدم أعلى جودة متاحة
    const imgUrl = att.largePreviewUrl || att.url || att.previewUrl;

    if ((type === "photo" || type === "image" || att.name?.includes("image")) && imgUrl) {
      // Gemini يقبل URL مباشرة عبر fileData
      parts.push({
        fileData: {
          mimeType:  "image/jpeg",
          fileUri:   imgUrl,
        }
      });
    } else if (type === "audio" && att.url) {
      // للصوت نحتاج base64 لأن Facebook لا يسمح بـ direct fetch
      try {
        const res = await axios.get(att.url, { responseType: "arraybuffer", timeout: 20000,
          headers: { "User-Agent": "Mozilla/5.0" } });
        parts.push({ inline_data: {
          mime_type: "audio/mp3",
          data: Buffer.from(res.data).toString("base64"),
        }});
      } catch (_) {
        parts.push({ text: "[ملف صوتي — فشل التحميل]" });
      }
    } else if (type === "video" && att.url) {
      parts.push({ text: `[فيديو مرفق]` });
    } else if (att.url) {
      parts.push({ text: `[مرفق: ${type || "ملف"}]` });
    }
  }

  return parts.length > 0 ? parts : [{ text: "." }];
}

// ─── Gemini مع retry تلقائي عند 429 ─────────────────────────
async function callGemini(contents, apiKey) {
  const { data } = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    },
    { timeout: 25000, headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey } }
  );
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function callGeminiWithRetry(contents) {
  // جرب كل المفاتيح واحداً تلو الآخر
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = nextKey();
    if (!key) break;
    try {
      const reply = await callGemini(contents, key);
      if (reply) return reply;
    } catch (e) {
      if (e.response?.status === 429) {
        console.warn(`[GEMINI] مفتاح ${i+1} تجاوز الحد — جرب التالي`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error("جميع مفاتيح Gemini تجاوزت الحد");
}

async function callGroq(contents) {
  if (!GROQ_API_KEY) throw new Error("No Groq Key");
  const messages = [
    { role: "system", content: SYSTEM },
    ...contents.map(c => ({
      role:    c.role === "model" ? "assistant" : "user",
      content: c.parts.map(p => p.text || "[مرفق]").filter(Boolean).join(" ") || "[مرفق]",
    })),
  ];
  const { data } = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama-3.3-70b-versatile", messages, temperature: 0.7, max_tokens: 2048 },
    { timeout: 15000, headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` } }
  );
  return data.choices?.[0]?.message?.content || null;
}

async function handleMessage(api, event, promptText, attachments) {
  const { threadID, messageID, senderID } = event;

  if (promptText.toLowerCase() === "clear" || promptText === "مسح") {
    try { await fs.unlink(getSessionPath(threadID)); } catch (_) {}
    return api.sendMessage("🧹 تم مسح ذاكرة المجموعة.", threadID, null, messageID);
  }

  if (!promptText.trim() && !attachments.length) {
    return api.sendMessage(
      "🤖 Sunken AI\n\n📝 أرسل سؤالك أو صورة مع الأمر\n💡 مثال: .gemini ما هذه الصورة؟",
      threadID, null, messageID
    );
  }

  const context  = await loadSession(threadID);
  const newParts = await buildParts(promptText, attachments);
  const contents = [...context, { role: "user", parts: newParts }];

  let reply = null;
  try {
    reply = await callGeminiWithRetry(contents);
  } catch (err) {
    console.warn("[GEMINI] كل المفاتيح فشلت:", err.message?.substring(0, 80));
    if (GROQ_API_KEY) {
      try { reply = await callGroq(contents); }
      catch { return api.sendMessage("❌ تعذر الاتصال بالخوادم — حاول لاحقاً.", threadID, null, messageID); }
    } else {
      return api.sendMessage("❌ تم تجاوز الحد — أضف مفاتيح Gemini إضافية.", threadID, null, messageID);
    }
  }

  if (!reply) return api.sendMessage("❌ استجابة فارغة.", threadID, null, messageID);

  api.sendMessage(reply, threadID, (err, info) => {
    if (err) return;
    try {
      global.GoatBot?.onReply?.set(info.messageID, {
        commandName: "gemini",
        messageID:   info.messageID,
        author:      senderID,
        threadID,
      });
    } catch (_) {}
  }, messageID);

  await saveSession(threadID, [
    ...context,
    { role: "user",  parts: [{ text: promptText || "[مرفق]" }] },
    { role: "model", parts: [{ text: reply }] },
  ]);
}

module.exports = {
  config: {
    name: "gemini",
    aliases: ["بوت", "ai", "gm"],
    version: "3.2.0",
    author: "Sunken",
    countDown: 5,
    role: 0,
    shortDescription: { ar: "محادثة ذكية — يرى الصور ويفهم الصوت" },
    category: "ذكاء اصطناعي",
    guide: {
      ar:
        "{pn}gemini [سؤال]\n" +
        "{pn}gemini [+ صورة] ← يحلل الصورة\n" +
        "{pn}gemini clear ← مسح ذاكرة المجموعة"
    }
  },

  onStart: async ({ api, event, args }) => {
    const text       = args.join(" ").trim();
    const atts       = event.attachments || [];
    const replyAtts  = event.messageReply?.attachments || [];
    const promptText = text || event.messageReply?.body || "";
    await handleMessage(api, event, promptText, [...atts, ...replyAtts]);
  },

  onReply: async ({ api, event }) => {
    const text = event.body?.trim() || "";
    const atts = event.attachments || [];
    await handleMessage(api, event, text, atts);
  },
};
