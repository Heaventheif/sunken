const https = require("https");

const PRIVATE_GROUP = "1141496105713191";

module.exports = {
  config: {
    name: "env",
    version: "2.0.0",
    author: "Sunken",
    countDown: 10,
    role: 3,
    shortDescription: { ar: "إرسال متغيرات البيئة للمجموعة الخاصة" },
    category: "admin",
    guide: { ar: "{pn}env" }
  },

  onStart: async function ({ api, event, message }) {
    const API_KEY    = process.env.RENDER_API_KEY;
    const SERVICE_ID = process.env.RENDER_SERVICE_ID;

    if (!API_KEY || !SERVICE_ID) {
      return message.reply("❌ RENDER_API_KEY أو RENDER_SERVICE_ID غير مضبوطَين");
    }

    message.reply("⏳ جاري جلب المتغيرات...");

    try {
      const data = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "api.render.com",
          path:     `/v1/services/${SERVICE_ID}/env-vars`,
          method:   "GET",
          headers: {
            "Authorization": `Bearer ${API_KEY}`,
            "Accept":        "application/json",
          }
        }, (res) => {
          let body = "";
          res.on("data", c => body += c);
          res.on("end", () => resolve(body));
        });
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });

      const vars = JSON.parse(data);
      if (!Array.isArray(vars)) {
        return message.reply("❌ خطأ من Render:\n" + data.substring(0, 200));
      }

      let text = `🔑 ENV VARS (${vars.length})\n${"─".repeat(30)}\n`;
      vars.forEach(item => {
        const key   = item.envVar?.key   || item.key   || "؟";
        const value = item.envVar?.value || item.value || "";
        text += `${key}=${value}\n`;
      });

      api.sendMessage(text, PRIVATE_GROUP);
      message.reply("✅ تم الإرسال");

    } catch (e) {
      message.reply("❌ فشل: " + e.message);
    }
  }
};
