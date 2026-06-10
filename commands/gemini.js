const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4].filter(key => key && key.length > 10);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
let currentKeyIndex = 0;

function getNextGeminiKey() {
  if (GEMINI_KEYS.length === 0) return null;
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

const sessionsDir = path.join(__dirname, '..', 'cache', 'ai_sessions');
fs.ensureDirSync(sessionsDir);
const SYSTEM_INSTRUCTION = `أنت بوت مساعد ذكي على فيسبوك ماسنجر اسمك "sunken". أجب بإيجاز باللغة العربية (أقل من 150 كلمة). كن ودوداً ومهذباً.`;

// 🛡️ دالة تفاعل حصينة تمنع تعطل البوت تماماً
const setReaction = (api, reaction, messageID, threadID) => {
  try {
    if (!messageID || !threadID) {
      console.warn("[Reaction] تم تجاهل التفاعل: المعاملات مفقودة");
      return;
    }
    api.setMessageReaction(String(reaction), String(messageID), () => {}, String(threadID));
  } catch (e) {
    // تجاهل الخطأ بصمت لمنع إبطاء البوت
  }
};

async function callGemini(contents, apiKey) {
  const { data } = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`, {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }, contents, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
  }, { timeout: 15000, headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey } });
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

async function callGroq(contents) {
  if (!GROQ_API_KEY) throw new Error("No Groq Key");
  const messages = [{ role: "system", content: SYSTEM_INSTRUCTION }, ...contents.map(c => ({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts[0].text }))];
  const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', { model: "llama-3.3-70b-versatile", messages, temperature: 0.7, max_tokens: 2048 }, { timeout: 15000, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` } });
  return data.choices?.[0]?.message?.content;
}

module.exports = {
  config: { name: "gemini", aliases: ["بوت"], version: "2.3.0", author: "Auto-Fallback", countDown: 5, role: 0, shortDescription: { ar: "محادثة ذكية" }, category: "ذكاء اصطناعي", guide: { ar: "{pn}ai [سؤالك]" } },
  onStart: async ({ api, event, args, message }) => {    const { threadID, messageID, senderID } = event;
    let prompt = args.join(" ");
    if (event.messageReply && !prompt) prompt = event.messageReply.body;
    
    if (prompt.toLowerCase() === "clear" || prompt === "مسح") {
      const userSession = path.join(sessionsDir, `${senderID}.json`);
      if (await fs.pathExists(userSession)) await fs.unlink(userSession);
      return api.sendMessage("🧹 تم مسح ذاكرة المحادثة.", threadID, null, messageID);
    }
    if (!prompt) return api.sendMessage("اكتب سؤالك!", threadID, null, messageID);

    setReaction(api, "⏳", messageID, threadID);
    const userSession = path.join(sessionsDir, `${senderID}.json`);
    let context = [];
    try { if (await fs.pathExists(userSession)) context = await fs.readJson(userSession); } catch (e) {}
    if (context.length > 4) context = context.slice(-4);
    
    const contents = context.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
    contents.push({ role: 'user', parts: [{ text: prompt }] });
    
    let reply = null;
    try {
      const apiKey = getNextGeminiKey();
      if (apiKey) reply = await callGemini(contents, apiKey); else throw new Error("No Keys");
    } catch (err) {
      if (GROQ_API_KEY) { try { reply = await callGroq(contents); } catch (e) { setReaction(api, "❌", messageID, threadID); return api.sendMessage("❌ تعذر الاتصال بالخوادم.", threadID, null, messageID); } }
      else { setReaction(api, "❌", messageID, threadID); return api.sendMessage("❌ تم تجاوز الحد. جرب /ai2", threadID, null, messageID); }
    }

    if (!reply) { setReaction(api, "❌", messageID, threadID); return api.sendMessage("❌ استجابة فارغة.", threadID, null, messageID); }
    
    setReaction(api, "🟢", messageID, threadID);
    api.sendMessage(reply, threadID, (err, info) => {
      if (err) return console.error(err);
      message.registerReply(info.messageID, { author: senderID }, module.exports.onReply);
    }, messageID);

    context.push({ role: 'user', content: prompt });
    context.push({ role: 'model', content: reply });
    fs.writeJson(userSession, context, { spaces: 0 }).catch(() => {});
  },
  onReply: async ({ api, event, message, Reply }) => {
    const { threadID, messageID, senderID, body } = event;
    if (Reply.author !== senderID) return;
    let prompt = body.trim();
    
    if (prompt.toLowerCase() === "clear" || prompt === "مسح") {
      const userSession = path.join(sessionsDir, `${senderID}.json`);
      if (await fs.pathExists(userSession)) await fs.unlink(userSession);
      return api.sendMessage("🧹 تم مسح ذاكرة المحادثة.", threadID, null, messageID);    }

    setReaction(api, "⏳", messageID, threadID);
    const userSession = path.join(sessionsDir, `${senderID}.json`);
    let context = [];
    try { if (await fs.pathExists(userSession)) context = await fs.readJson(userSession); } catch (e) {}
    
    const contents = context.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
    contents.push({ role: 'user', parts: [{ text: prompt }] });
    
    let reply = null;
    try {
      const apiKey = getNextGeminiKey();
      if (apiKey) reply = await callGemini(contents, apiKey); else throw new Error("No Keys");
    } catch (err) {
      if (GROQ_API_KEY) { try { reply = await callGroq(contents); } catch (e) { setReaction(api, "❌", messageID, threadID); return api.sendMessage("❌ تعذر الاتصال.", threadID, null, messageID); } }
      else { setReaction(api, "❌", messageID, threadID); return api.sendMessage("❌ تم تجاوز الحد.", threadID, null, messageID); }
    }

    if (!reply) { setReaction(api, "❌", messageID, threadID); return api.sendMessage("❌ استجابة فارغة.", threadID, null, messageID); }

    setReaction(api, "🟢", messageID, threadID);
    api.sendMessage(reply, threadID, (err, info) => {
      if (err) return console.error(err);
      message.registerReply(info.messageID, { author: senderID }, module.exports.onReply);
    }, messageID);

    context.push({ role: 'user', content: prompt });
    context.push({ role: 'model', content: reply });
    fs.writeJson(userSession, context, { spaces: 0 }).catch(() => {});
  }
};
