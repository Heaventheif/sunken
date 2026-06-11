"use strict";

const { spawn } = require("child_process");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || "10000";

console.log(`[Launcher] ROOT = ${ROOT}`);
console.log(`[Launcher] PORT = ${PORT}`);
console.log(`[Launcher] NODE = ${process.version}`);

process.env.PORT     = PORT;
process.env.BOT_ROOT = ROOT;
process.env.NODE_ENV = process.env.NODE_ENV || "production";

// ─── Keep-Alive (Render Free Tier) ──────────────────────────
const keepAlive = () => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    require("https").get(url, r => {
      console.log(`[KEEP-ALIVE] 📡 ${r.statusCode}`);
    }).on("error", err => {
      require("http").get(url, r => {
        console.log(`[KEEP-ALIVE] 📡 ${r.statusCode} (http)`);
      }).on("error", () => {});
    });
  }, 14 * 60 * 1000);
};

// ─── Bot child process ───────────────────────────────────────
let botProcess = null;
function startBot() {
  console.log("[Launcher] 🤖 بدء تشغيل البوت...");
  botProcess = spawn("node", ["--no-warnings", "index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: undefined, NODE_OPTIONS: "--max-old-space-size=450" },
    stdio: "inherit",
  });
  botProcess.on("error", err => console.error("[Bot] 💥 فشل التشغيل:", err.message));
  botProcess.on("exit", code => {
    console.log(`[Bot] ⏹️ انتهى بكود: ${code}`);
    botProcess.removeAllListeners(); // ← منع memory leak
    botProcess = null;
    console.log("[Bot] 🔄 إعادة التشغيل خلال 5 ثواني...");
    setTimeout(startBot, 5000);
  });
}

process.on("SIGTERM", () => { console.log("[Launcher] 🛑 SIGTERM"); process.exit(0); });
process.on("SIGINT",  () => { console.log("[Launcher] 🛑 SIGINT");  process.exit(0); });

// ─── تشغيل البوت ────────────────────────────────────────────
startBot();

// ─── تشغيل الداشبورد (نفس العملية — CommonJS) ───────────────
console.log("[Launcher] 🌐 بدء تشغيل الداشبورد على البورت", PORT);
require("./dashboard/server.js");

// ─── Keep-Alive بعد بدء الداشبورد ───────────────────────────
setTimeout(keepAlive, 5000);
