const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const sessionsDir = path.join(__dirname, '..', 'cache', 'ai2_sessions');
fs.ensureDirSync(sessionsDir);
const MODEL = "llama-3.3-70b-versatile";

const SYSTEM_INSTRUCTION = `أنت بوت مساعد ذكي على فيسبوك ماسنجر اسمك "Sunken". أجب دائماً باللغة العربية الفصحى البسيطة، اجعل ردودك مختصرة (أقل من 200 كلمة)، لا تذكر أنك نموذج ذكاء اصطناعي، كن ودوداً ومهذباً.`;

const groqClient = axios.create({
  baseURL: 'https://api.groq.com/openai/v1',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` }
});

// 🛡️ دالة تفاعل حصينة
const setReaction = (api, reaction, messageID, threadID) => {
  try {
    if (!messageID || !threadID) return;
    api.setMessageReaction(String(reaction), String(messageID), () => {}, String(threadID));
  } catch (e) {}
};

module.exports = {
  config: { name: "groq", aliases: ["llma32", "ai2"], version: "3.1.0", author: "Aljur Pogoy", countDown: 3, role: 0, shortDescription: { ar: "محادثة مع الذكاء الاصطناعي Llama" }, category: "ذكاء اصطناعي", guide: { ar: "{pn}ai2 [سؤالك]\n{pn}ai2 مسح - لمسح الذاكرة" } },
  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID, senderID } = event;
    let prompt = args.join(" ");
    if (event.messageReply && !prompt) prompt = event.messageReply.body;

    if (prompt.toLowerCase() === "clear" || prompt === "مسح") {
      const userSession = path.join(sessionsDir, `${senderID}.json`);
      if (await fs.pathExists(userSession)) await fs.unlink(userSession);
      return api.sendMessage("🧹 تم مسح ذاكرة المحادثة.", threadID, null, messageID);
    }
    if (!prompt) return api.sendMessage("❓ اكتب سؤالك أو رد على رسالة!", threadID, null, messageID);
    if (!GROQ_API_KEY) return api.sendMessage("❌ مفتاح GROQ_API_KEY غير موجود في .env", threadID, null, messageID);

    setReaction(api, "⏳", messageID, threadID);
    const userSession = path.join(sessionsDir, `${senderID}.json`);
    let context = [];
    try { if (await fs.pathExists(userSession)) context = await fs.readJson(userSession); } catch (e) { context = []; }
    if (context.length > 10) context = context.slice(-10);

    const messages = [{ role: "system", content: SYSTEM_INSTRUCTION }, ...context.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })), { role: 'user', content: prompt }];

    try {      const { data } = await groqClient.post('/chat/completions', { model: MODEL, messages, temperature: 0.7, max_tokens: 2048, top_p: 0.9, stream: false });
      const reply = data.choices?.[0]?.message?.content;
      if (!reply) throw new Error("استجابة فارغة من الخادم");

      setReaction(api, "🟢", messageID, threadID);
      api.sendMessage(reply, threadID, async (err, info) => {
        if (err) return console.error("[AI2]", err.message);
        message.registerReply(info.messageID, { author: senderID }, module.exports.onReply);
      }, messageID);

      context.push({ role: 'user', content: prompt });
      context.push({ role: 'model', content: reply });
      fs.writeJson(userSession, context, { spaces: 0 }).catch(() => {});
    } catch (e) {
      setReaction(api, "❌", messageID, threadID);
      let errMsg = "❌ حدث خطأ: ";
      if (e.code === 'ECONNABORTED') errMsg += "⏱️ انتهت مهلة الاتصال";
      else if (e.response?.status === 429) errMsg += "⏳ تم تجاوز الحد، انتظر قليلاً";
      else if (e.response?.status === 401) errMsg += "🔑 مفتاح API غير صالح";
      else errMsg += (e.message || "اتصال فاشل");
      api.sendMessage(errMsg, threadID, null, messageID);
    }
  },
  onReply: async ({ api, event, message, Reply }) => {
    const { threadID, messageID, senderID, body } = event;
    if (Reply.author !== senderID) return;
    let prompt = body.trim();
    
    if (prompt.toLowerCase() === "clear" || prompt === "مسح") {
      const userSession = path.join(sessionsDir, `${senderID}.json`);
      if (await fs.pathExists(userSession)) await fs.unlink(userSession);
      return api.sendMessage("🧹 تم مسح ذاكرة المحادثة.", threadID, null, messageID);
    }
    if (!GROQ_API_KEY) return api.sendMessage("❌ مفتاح GROQ_API_KEY غير موجود", threadID, null, messageID);

    setReaction(api, "⏳", messageID, threadID);
    const userSession = path.join(sessionsDir, `${senderID}.json`);
    let context = [];
    try { if (await fs.pathExists(userSession)) context = await fs.readJson(userSession); } catch (e) { context = []; }

    const messages = [{ role: "system", content: SYSTEM_INSTRUCTION }, ...context.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })), { role: 'user', content: prompt }];

    try {
      const { data } = await groqClient.post('/chat/completions', { model: MODEL, messages, temperature: 0.7, max_tokens: 2048, top_p: 0.9, stream: false });
      const reply = data.choices?.[0]?.message?.content;
      if (!reply) throw new Error("استجابة فارغة");

      setReaction(api, "🟢", messageID, threadID);
      api.sendMessage(reply, threadID, async (err, info) => {
        if (err) return console.error("[AI2]", err.message);        message.registerReply(info.messageID, { author: senderID }, module.exports.onReply);
      }, messageID);

      context.push({ role: 'user', content: prompt });
      context.push({ role: 'model', content: reply });
      fs.writeJson(userSession, context, { spaces: 0 }).catch(() => {});
    } catch (e) {
      setReaction(api, "❌", messageID, threadID);
      let errMsg = "❌ حدث خطأ: ";
      if (e.response?.status === 429) errMsg += "⏳ تم تجاوز الحد";
      else errMsg += (e.message || "اتصال فاشل");
      api.sendMessage(errMsg, threadID, null, messageID);
    }
  }
};
