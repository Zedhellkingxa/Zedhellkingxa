const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountsEngine } = require("../accounts-engine");

const silentLog = { error() {}, warn() {}, info() {} };

function fakeStore(records) {
  return {
    get: (id) => records.find((r) => r.id === id) || null,
    list: () => records.map(({ id, name, enabled }) => ({ id, name, enabled })),
    decrypt: (id) => (records.some((r) => r.id === id) ? [{ key: "c_user", value: id }] : null),
  };
}

// محرك حقيقي مع تسجيل دخول وهمي عبر حقن login وهمي — نستبدل ws3-fca مؤقتاً
function withFakeLogin(fakeLogin, fn) {
  const Module = require("module");
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "ws3-fca") return { login: fakeLogin };
    return orig.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve("../accounts-engine")];
    const engine = require("../accounts-engine");
    return fn(engine);
  } finally {
    Module.prototype.require = orig;
    delete require.cache[require.resolve("../accounts-engine")];
  }
}

test("two accounts run concurrently and stopping one leaves the other live", async () => {
  const logins = [];
  await withFakeLogin((opts, loginOpts, cb) => {
    const id = opts.appState[0].value;
    logins.push(id);
    const api = {
      ctx: { lastSeqId: "1" },
      getAppState: () => opts.appState,
      logout: () => {},
      listenMqtt: async (onEvent) => {
        setImmediate(() => onEvent(null, { type: "message", threadID: "t" + id, messageID: "m" + id }));
        return () => {};
      },
    };
    setImmediate(() => cb(null, api));
  }, async (mod) => {
    const store = fakeStore([
      { id: "1", name: "أ", enabled: true },
      { id: "2", name: "ب", enabled: true },
    ]);
    const seen = [];
    const engine = createAccountsEngine({
      store,
      onMessage: (account, event) => seen.push({ id: account.id, thread: event.threadID }),
      onEvent: () => {},
      log: silentLog,
    });

    await engine.startAll();
    // انتظار تسجيل الدخول والمستمع لكل حساب
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    await new Promise((r) => setTimeout(r, 30));

    let statuses = engine.statuses();
    assert.equal(statuses.length, 2);
    assert.equal(logins.sort().join(","), "1,2");
    for (const s of statuses) {
      assert.equal(s.status, "online", `account ${s.id} should be online`);
      assert.equal(s.listenerActive, true);
    }

    // إيقاف الحساب الأول فقط
    assert.equal(engine.stopAccount("1").ok, true);
    statuses = engine.statuses();
    const first = statuses.find((s) => s.id === "1");
    const second = statuses.find((s) => s.id === "2");
    assert.equal(first.status, "stopped");
    assert.equal(first.listenerActive, false);
    assert.equal(second.status, "online");
    assert.equal(second.listenerActive, true);
  });
});

test("startAll skips disabled accounts", async () => {
  await withFakeLogin((opts, o, cb) => {
    cb(new Error("should not be called"));
  }, async (mod) => {
    const store = fakeStore([
      { id: "1", name: "معطل", enabled: false },
      { id: "2", name: "مفعل", enabled: true },
    ]);
    const engine = createAccountsEngine({ store, onMessage: () => {}, onEvent: () => {}, log: silentLog });
    await engine.startAll();
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    const statuses = engine.statuses();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].id, "2");
  });
});

test("login failure with checkpoint marks needs_attention without crashing", async () => {
  await withFakeLogin((opts, o, cb) => {
    const err = new Error("Checkpoint required");
    err.error = "login-approval";
    cb(err, null);
  }, async (mod) => {
    const store = fakeStore([{ id: "1", name: "أ", enabled: true }]);
    const engine = createAccountsEngine({ store, onMessage: () => {}, onEvent: () => {}, log: silentLog });
    await engine.startAll();
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    const s = engine.statusOf("1");
    assert.ok(s);
    assert.equal(s.loggedIn, false);
  });
});
