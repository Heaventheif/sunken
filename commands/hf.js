"use strict";
const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");

// ─── إعدادات الاتصال بـ HF Space ─────────────────────────────
const HF_PROXY_URL    = process.env.HF_PROXY_URL;    // https://YOUR-USERNAME-sunken-ai-proxy.hf.space
const PROXY_SECRET    = process.env.PROXY_SECRET;    // نفس الـ secret في HF Space
const SESSION_DIR     = path.join(__dirname, "..", "cache", "hf_sessions");
const MAX_CTX         = 10;   // آخر 10 رسائل في الذاكرة
const TIMEOUT         = 65000; // 65 ثانية (HF أبطأ من Groq)

fs.ensureDirSync(SESSION_DIR);

// ─── session helpers ──────────────────────────────────────────
const sessionPath  = (tid) => path.join(SESSION_DIR, `${tid}.json`);
async function loadSession(tid) {
  try {
    if (await fs.pathExists(sessionPath(tid)))
      return await fs.readJson(sessionPath(tid));
  } catch (_) {}
  return [];
}
async function saveSession(tid, ctx) {
  await fs.writeJson(sessionPath(tid), ctx.slice(-MAX_CTX), { spaces: 0 }).catch(() => {});
}
async function clearSession(tid) {
  await fs.remove(sessionPath(tid)).catch(() => {});
}

// ─── الاتصال بـ HF Proxy ──────────────────────────────────────
async function callHF(messages, model = "default") {
  if (!HF_PROXY_URL) throw new Error("HF_PROXY_URL غير موجود في متغيرات Render");

  const url = `${HF_PROXY_URL.replace(/\/+$/, "")}/chat`;
  console.log(`[HF] POST → ${url}`); // debug مؤقت

  const { data } = await axios.post(
    url,
    { messages, model, max_tokens: 512, temperature: 0.7 },
    {
      timeout: TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": PROXY_SECRET || "",
      },
    }
  );
  return data.reply || null;
}

// ─── reaction helper ──────────────────────────────────────────
const react = (api, emoji, mid, tid) => {
  try {
    if (!emoji || !mid || !tid) return;
    if (String(mid) === "undefined" || String(tid) === "undefined") return;
    api.setMessageReaction({ reaction: String(emoji), messageID: String(mid), threadID: String(tid) }, () => {});
  } catch (_) {}
};

// ─── handler مشترك ───────────────────────────────────────────
async function handle(api, event, args, model) {
  const { threadID, messageID, senderID } = event;

  let prompt = args.join(" ").trim();
  if (!prompt && event.messageReply?.body) prompt = event.messageReply.body.trim();

  // مسح الذاكرة
  if (prompt === "مسح" || prompt.toLowerCase() === "clear") {
    await clearSession(threadID);
    return api.sendMessage("🧹 تم مسح ذاكرة المحادثة.", threadID, null, messageID);
  }

  if (!prompt) {
    return api.sendMessage(
      "🤖 HF AI\n\n📝 اكتب سؤالك بعد الأمر\n💡 مثال: .hf ما هو الذكاء الاصطناعي؟\n🔄 .hf مسح — لمسح الذاكرة",
      threadID, null, messageID
    );
  }

  if (!HF_PROXY_URL) {
    return api.sendMessage("❌ HF_PROXY_URL غير مضبوط في متغيرات Render", threadID, null, messageID);
  }

  react(api, "⏳", messageID, threadID);

  // تحميل السياق
  const history = await loadSession(threadID);
  const messages = [
    ...history,
    { role: "user", content: prompt },
  ];

  try {
    const reply = await callHF(messages, model);
    if (!reply) throw new Error("رد فارغ من الخادم");

    react(api, "✅", messageID, threadID);

    api.sendMessage(reply, threadID, (err, info) => {
      if (err) return;
      // تسجيل للرد التسلسلي
      global.Kagenou.replies[info.messageID] = {
        callback: async ({ api, event }) => {
          await handle(api, event, [event.body], model);
        },
        author:    senderID,
        timestamp: Date.now(),
      };
    }, messageID);

    // حفظ السياق
    await saveSession(threadID, [
      ...history,
      { role: "user",      content: prompt },
      { role: "assistant", content: reply  },
    ]);

  } catch (err) {
    react(api, "❌", messageID, threadID);
    let msg = "❌ خطأ: ";
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT")
      msg += "⏱️ انتهت المهلة — النموذج قد يكون نائماً، حاول مجدداً";
    else if (err.response?.status === 401)
      msg += "🔑 PROXY_SECRET خاطئ";
    else if (err.response?.status === 404)
      msg += `🔍 404 — URL خاطئ\nالمستخدم: ${HF_PROXY_URL || "غير موجود"}\nتحقق من HF_PROXY_URL في Render`;
    else if (err.response?.status === 503)
      msg += "😴 النموذج نائم على HF — أعد المحاولة بعد 30 ثانية";
    else
      msg += (err.message || "اتصال فاشل").substring(0, 120);
    api.sendMessage(msg, threadID, null, messageID);
  }
}

// ─── تصدير الأمر ─────────────────────────────────────────────
module.exports = {
  config: {
    name:             "hf",
    aliases:          ["huggingface", "hfai", "phi"],
    version:          "1.0.0",
    author:           "Sunken",
    countDown:        5,
    role:             0,
    shortDescription: { ar: "ذكاء اصطناعي مجاني عبر HuggingFace" },
    category:         "ذكاء اصطناعي",
    guide: {
      ar:
        "{pn}hf [سؤالك] — نموذج افتراضي (Mistral 7B)\n" +
        "{pn}hf مسح — مسح ذاكرة المجموعة\n\n" +
        "النماذج المتاحة: default | arabic | smart | fast",
    },
  },

  onStart: async ({ api, event, args }) => {
    // تحديد النموذج من أول arg إذا كان اسم نموذج
    const modelNames = ["default", "arabic", "smart", "fast"];
    let model = "default";
    let finalArgs = args;
    if (args[0] && modelNames.includes(args[0].toLowerCase())) {
      model     = args[0].toLowerCase();
      finalArgs = args.slice(1);
    }
    await handle(api, event, finalArgs, model);
  },
};
