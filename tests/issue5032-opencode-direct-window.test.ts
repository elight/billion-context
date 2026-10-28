// #5032: without a live proxy the opencode V1 lane sent the raw history
// straight to the provider — the shared oversize arm in directSendOrRefuse
// needed a window to measure against, and both its sources were empty on
// exactly that path: the x-bili-plugin-context-window header is stamped only
// AFTER `if (base === undefined) return;` in the chat.headers hook, and the
// lane never armed declaredWindowForDirect (#4894 armed dsh; PR #5027 armed
// pi). These cases pin the opencode half: the window is recorded BEFORE the
// readiness return, an unknown model / unknown limit clears it (fail open —
// never a guessed window), opencode-native arms the reader, and the armed
// pair refuses locally instead of egressing. Hermetic like
// issue5025-pi-direct-window.test.ts: XDG_STATE_HOME redirected so no event
// reaches a real log file, proxy env cleared so no probe targets a live
// proxy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createV1ServerHooks, opencodeDeclaredWindowForDirect, _resetOpencodeDeclaredWindowForTest, _declaredWindowHookForTest, type V1Config } from "../src/agent/opencode-native.ts";

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5032-state-"));
const PREV_ENV: Record<string, string | undefined> = {};
for (const key of ["XDG_STATE_HOME", "BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_ATTACH", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_OPENCODE"]) {
    PREV_ENV[key] = process.env[key];
}
delete process.env.BILLION_CONTEXT_PROXY;
delete process.env.BILLION_CONTEXT_ATTACH;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    for (const [key, value] of Object.entries(PREV_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const UPSTREAM = "http://127.0.0.1:8201/v1/chat/completions";

// Minimal structural stand-in for the host's zod module — same shape as
// opencode-native-v1.test.ts; only needs to exist so the plugin-mode branch
// registers chat.headers.
const fakeZ = {
    any: () => ({ __fake: "any" }),
    string: () => ({ __fake: "string", describe: (d: string) => ({ __fake: "string", desc: d }) }),
    number: () => ({ __fake: "number" }),
    boolean: () => ({ __fake: "boolean" }),
    array: (item: unknown) => ({ __fake: "array", item }),
    enum: (values: [string, ...string[]]) => ({ __fake: "enum", values }),
} as unknown as typeof import("zod");

/** Config declaring the model's window through the ONLY V1 window source
 *  (provider.<pid>.models.<mid>.limit.context, cf. extractV1Windows). */
const CFG: V1Config = {
    provider: {
        openai: { models: { "gpt-test": { limit: { context: 500_000 } } } },
    },
};

/** Hooks bound to a DEAD proxy origin — the reported degraded state. */
function deadProxyHooks(): { headers: (input: { sessionID: string; model?: { providerID?: unknown; id?: unknown } }, output: { headers: Record<string, string> }) => Promise<void>; config: ((cfg: V1Config) => Promise<void>) | undefined } {
    const hooks = createV1ServerHooks(() => undefined, {}, { z: fakeZ });
    const h = hooks["chat.headers"];
    assert.ok(h, "chat.headers registered in plugin mode");
    return { headers: h, config: hooks.config };
}

function chatBody(textChars: number): string {
    return JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "x".repeat(textChars) }] });
}

beforeEach(() => {
    _resetOpencodeDeclaredWindowForTest();
});

test("#5032 opencode records the window even when no proxy base resolves (the direct-send path)", async () => {
    const { headers, config } = deadProxyHooks();
    await config?.(CFG);
    const out: { headers: Record<string, string> } = { headers: {} };
    await headers({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt-test" } }, out);
    assert.equal(opencodeDeclaredWindowForDirect(), 500_000, "recorded before the proxy-readiness return");
    // The premise of the bug: in this state the header is never stamped, which
    // is why the shared guard had nothing to measure against.
    assert.equal(out.headers["x-bili-plugin-context-window"], undefined, "no proxy base → no stamped window");
    assert.equal(out.headers["x-bili-plugin"], undefined, "no proxy base → no ownership marker either");
});

test("#5032 unknown model clears the record — the arm fails open instead of guessing", async () => {
    const { headers, config } = deadProxyHooks();
    await config?.(CFG);
    await headers({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt-test" } }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), 500_000);
    await headers({ sessionID: "ses_5032", model: { providerID: "openai", id: "not-in-config" } }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), undefined, "a model absent from the config table must not inherit the previous window");
    await headers({ sessionID: "ses_5032" }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), undefined, "a request without model info records undefined too");
});

test("#5032 model present but no context limit in config → undefined (partial table stays fail-open)", async () => {
    const { headers, config } = deadProxyHooks();
    await config?.({ provider: { openai: { models: { "gpt-test": { limit: { output: 8_192 } } } } } });
    await headers({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt-test" } }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), undefined, "an output-only limit declares no window");
});

test("#5032 opencode-native arms the shared guard with the opencode window reader", async () => {
    const hook = _declaredWindowHookForTest();
    assert.equal(typeof hook, "function", "declaredWindowForDirect armed on the opencode NativeInterceptState");
    const { headers, config } = deadProxyHooks();
    await config?.(CFG);
    await headers({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt-test" } }, { headers: {} });
    assert.equal(hook?.(), 500_000, "the armed reader answers the recorded window");
});

test("#5032 armed opencode reader + not-ready intercept: oversized body refused locally, nothing egresses", async () => {
    const saved = globalThis.fetch;
    const mod = await import("../src/agent/native-intercept.ts");
    const sink: string[] = [];
    mod._resetForTest();
    globalThis.fetch = (async (input: string | URL | Request) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = {
            origin: undefined,
            ready: Promise.resolve(undefined),
            respawn: async () => undefined,
            declaredWindowForDirect: opencodeDeclaredWindowForDirect,
        };
        assert.equal(mod.installNativeFetchIntercept(state), true);
        const { headers, config } = deadProxyHooks();
        await config?.(CFG);
        await headers({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt-test" } }, { headers: {} });
        // >4MB core text: provably over the #4079-floored bar (max(500k, 1M)).
        const res = await globalThis.fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 422);
        assert.equal(res.headers.get("x-bili-gate"), "oversize-refusal-fallback");
        assert.equal((body.error as { code: string }).code, "bili_gate_oversize_refusal_fallback");
        assert.deepEqual(sink, [], "no upstream egress");
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
});

test("#5032 armed opencode reader + body that fits: direct send unchanged (no false refusal)", async () => {
    const saved = globalThis.fetch;
    const mod = await import("../src/agent/native-intercept.ts");
    const sink: string[] = [];
    mod._resetForTest();
    globalThis.fetch = (async (input: string | URL | Request) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = {
            origin: undefined,
            ready: Promise.resolve(undefined),
            respawn: async () => undefined,
            declaredWindowForDirect: opencodeDeclaredWindowForDirect,
        };
        assert.equal(mod.installNativeFetchIntercept(state), true);
        const { headers, config } = deadProxyHooks();
        await config?.(CFG);
        await headers({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt-test" } }, { headers: {} });
        const res = await globalThis.fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(10_000) });
        assert.equal(res.status, 200, "direct send proceeds");
        assert.deepEqual(sink, [UPSTREAM]);
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
});
