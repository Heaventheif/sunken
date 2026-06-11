/**
 * sqlite3 mock - يمنع خطأ "Could not locate bindings file"
 * يُحمَّل في بداية index.js قبل fca-unofficial
 */
"use strict";

const Module = require("module");
const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  if (request === "sqlite3") {
    // إرجاع mock بسيط يحاكي واجهة sqlite3
    return {
      Database: class Database {
        constructor(path, cb) { if (cb) cb(null); }
        run(sql, params, cb) { if (typeof params === "function") params(null); else if (cb) cb(null); }
        get(sql, params, cb) { if (typeof params === "function") params(null, null); else if (cb) cb(null, null); }
        all(sql, params, cb) { if (typeof params === "function") params(null, []); else if (cb) cb(null, []); }
        close(cb) { if (cb) cb(null); }
        serialize(cb) { if (cb) cb(); }
        prepare(sql) { return { run: () => {}, get: () => {}, all: () => [], finalize: () => {} }; }
      },
      OPEN_READWRITE: 2,
      OPEN_CREATE: 4,
      OPEN_FULLMUTEX: 65536,
      verbose: () => this,
    };
  }
  return originalLoad.apply(this, arguments);
};
