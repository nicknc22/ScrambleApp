import { afterEach, describe, expect, it, vi } from "vitest";
import { disablePush, enablePush, pushPermission, pushSupported, urlBase64ToUint8Array } from "@/lib/client/push";

// A real-looking (65-byte, uncompressed P-256) VAPID public key.
const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

function setup(opts: {
  permission?: NotificationPermission;
  request?: NotificationPermission;
  fetchStatus?: number;
  existing?: boolean;
  ready?: "ok" | "never";
}) {
  const subJson = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
  const sub = { endpoint: subJson.endpoint, toJSON: () => subJson, unsubscribe: vi.fn(async () => true), options: { applicationServerKey: null } };
  const pushManager = {
    getSubscription: vi.fn(async () => (opts.existing ? sub : null)),
    subscribe: vi.fn(async () => sub),
  };
  const reg = { pushManager };
  const Notification = {
    permission: opts.permission ?? "default",
    requestPermission: vi.fn(async () => opts.request ?? "granted"),
  };
  const fetchMock = vi.fn(async () => ({ ok: (opts.fetchStatus ?? 200) < 300, status: opts.fetchStatus ?? 200 }));
  vi.stubGlobal("window", { PushManager: function PushManager() {}, Notification });
  vi.stubGlobal("Notification", Notification);
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: opts.ready === "never" ? new Promise(() => {}) : Promise.resolve(reg),
      getRegistration: vi.fn(async () => reg),
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  return { pushManager, Notification, fetchMock, sub };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("push", () => {
  it("decodes URL-safe base64 VAPID keys", () => {
    const bytes = urlBase64ToUint8Array(KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });

  it("reports unsupported without service worker / PushManager", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    expect(pushSupported()).toBe(false);
    expect(pushPermission()).toBe("unsupported");
    expect((await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY })).status).toBe("unsupported");
  });

  it("no_key when the server has no VAPID key", async () => {
    setup({});
    expect((await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: null })).status).toBe("no_key");
  });

  it("denied when the user says no", async () => {
    const { pushManager } = setup({ request: "denied" });
    const r = await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY });
    expect(r.status).toBe("denied");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes and registers with the server", async () => {
    const { pushManager, fetchMock } = setup({});
    const r = await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY });
    expect(r.status).toBe("subscribed");
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/t/abc/push");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ player_id: "p1", subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } } });
  });

  it("tolerates a missing push endpoint (404) but not a server error", async () => {
    setup({ fetchStatus: 404, permission: "granted" });
    expect((await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY })).status).toBe("subscribed");
    vi.unstubAllGlobals();
    setup({ fetchStatus: 500, permission: "granted" });
    expect((await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY })).status).toBe("error");
  });

  it("reuses an existing subscription", async () => {
    const { pushManager } = setup({ existing: true, permission: "granted" });
    expect((await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY })).status).toBe("subscribed");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("gives up when the service worker never becomes ready", async () => {
    vi.useFakeTimers();
    setup({ ready: "never", permission: "granted" });
    const p = enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY });
    await vi.advanceTimersByTimeAsync(9000);
    expect((await p).status).toBe("error");
  });

  it("network failure is an error, never a throw", async () => {
    setup({ permission: "granted" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    expect((await enablePush({ code: "abc", playerId: "p1", vapidPublicKey: KEY })).status).toBe("error");
  });

  it("disablePush unsubscribes and tells the server (best effort)", async () => {
    const { sub, fetchMock } = setup({ existing: true, permission: "granted" });
    expect(await disablePush({ code: "abc", playerId: "p1" })).toBe(true);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
  });
});
