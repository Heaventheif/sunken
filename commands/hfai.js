/**
 * hfai.js — ذكاء اصطناعي مجاني عبر Hugging Face Space
 * يرسل الطلب لـ HF Space ويعيد الرد مباشرة في المحادثة
 */
"use strict";

const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const HF_URL    = process.env.HF_PROXY_URL;   // مثال: https://user-sunken-ai.hf.space
const HF_SECRET = process.env.HF_SECRET_KEY || "sunken";
const sessionsDir = path.join(__dirname, "..", "cache", "hfai_sessions");
fs.ensureDirSync(sessionsDir);

// ─── Session helpers ──────────────────────────────────────────────────────────
const sessionPath = id => path.join(sessionsDir, `${id}.json`);

async function loadSession(id) {
  try {
    if (await fs.pathExists(sessionPath(id))) {
      const data = await fs.readJson(sessionPath(id));
      return Array.isArray(data) ? data.slice(-12) : [];
    }
  } catch (_) {}
  return [];
}

async function saveSession(id, ctx) {
  await fs.writeJson(sessionPath(id), ctx.slice(-12), { spaces: 0 }).catch(() => {});
}

async function clearSession(id) {
  const p = sessionPath(id);
  if (await fs.pathExists(p)) await fs.unlink(p);
}

// ─── Reaction helper ──────────────────────────────────────────────────────────
const react = (api, emoji, msgID, tidID) => {
  try {
    if (!emoji || !msgID || !tidID) return;
    if (String(msgID) === "undefined" || String(tidID) === "undefined") return;
    api.setMessageReaction({ reaction: String(emoji), messageID: String(msgID), threadID: String(tidID) }, () => {});
  } catch (_) {}
};

// ─── Call HF Space ────────────────────────────────────────────────────────────
async function callHF(prompt, context = [], model = "qwen") {
  if (!HF_URL) throw new Error("HF_PROXY_URL غير موجود في متغيرات البيئة");

  const { data } = await axios.post(
    `${HF_URL.replace(/\/$/, "")}/chat`,
    { prompt, context, model, secret: HF_SECRET },
    {
      headers: { "Content-Type": "application/json", "x-secret-key": HF_SECRET },
      timeout: 35_000,
    }
  );

  if (!data?.ok) {
    if (data?.retry) throw Object.assign(new Error(data.error), { retry: true, wait: data.wait || 20 });
    throw new Error(data?.error || "استجابة غير متوقعة");
  }
  return data.reply;
}

// ─── Core handler ─────────────────────────────────────────────────────────────
async function handle(api, event, prompt, useThreadSession = false) {
  const { threadID, messageID, senderID } = event;
  const sessionId = useThreadSession ? threadID : senderID;

  // أوامر خاصة
  if (["مسح", "clear", "reset"].includes(prompt.toLowerCase())) {
    await clearSession(sessionId);
    return api.sendMessage("🧹 تم مسح ذاكرة المحادثة.", threadID, null, messageID);
  }

  if (!prompt.trim()) {
    return api.sendMessage(
      "🤖 *Sunken HF AI*\n\n" +
      "📝 اكتب سؤالك بعد الأمر\n" +
      "💡 مثال: .hfai ما هو الذكاء الاصطناعي؟\n\n" +
      "🔄 النماذج المتاحة:\n" +
      "• qwen — الأفضل للعربية (افتراضي)\n" +
      "• llama — سريع\n" +
      "• mistral — بديل\n\n" +
      "💬 .hfai مسح — لمسح الذاكرة",
      threadID, null, messageID
    );
  }

  react(api, "⏳", messageID, threadID);

  const context = await loadSession(sessionId);

  try {
    const reply = await callHF(prompt, context);
    react(api, "✅", messageID, threadID);

    api.sendMessage(reply, threadID, async (err, info) => {
      if (err) return;
      // سجّل الرد للـ reply chain
      global.Kagenou.replies[info.messageID] = {
        callback: async (ctx) => {
          const replyPrompt = ctx.event?.body?.trim();
          if (replyPrompt) await handle(ctx.api, ctx.event, replyPrompt, useThreadSession);
        },
        author:    senderID,
        timestamp: Date.now(),
      };
    }, messageID);

    // احفظ السياق
    const updated = [
      ...context,
      { role: "user",      content: prompt },
      { role: "assistant", content: reply  },
    ];
    await saveSession(sessionId, updated);

  } catch (err) {
    react(api, "❌", messageID, threadID);

    let msg = "❌ خطأ: ";
    if (err.retry)                msg += `⏳ النموذج يُحمَّل، انتظر ${err.wait || 20} ثانية وأعد المحاولة`;
    else if (err.code === "ECONNABORTED" || err.message.includes("timeout"))
                                  msg += "⏱️ انتهت مهلة الاتصال مع HF Space";
    else if (err.message.includes("HF_PROXY_URL"))
                                  msg += "⚙️ HF_PROXY_URL غير مضبوط في Render";
    else                          msg += err.message?.substring(0, 120) || "فشل الاتصال";

    api.sendMessage(msg, threadID, null, messageID);
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name:             "hfai",
    aliases:          ["hf", "hugging", "qwen"],
    version:          "1.0.0",
    author:           "Sunken",
    countDown:        5,
    role:             0,
    shortDescription: { ar: "ذكاء اصطناعي مجاني عبر Hugging Face" },
    category:         "ذكاء اصطناعي",
    guide: {
      ar:
        "{pn}hfai [سؤالك]\n" +
        "{pn}hfai مسح — مسح ذاكرة المحادثة\n\n" +
        "📌 النماذج المتاحة: qwen / llama / mistral",
    },
  },

  onStart: async ({ api, event, args }) => {
    let prompt = args.join(" ").trim();
    if (!prompt && event.messageReply?.body) prompt = event.messageReply.body.trim();
    await handle(api, event, prompt);
  },
};
