import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/index.ts";

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cpa-extension-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await fn(cwd);
  } finally {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

test("extension registers provider with refreshModels capability", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-cpa-extension-lifecycle-home-"));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;

  try {
    process.env.HOME = home;
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), "http://localhost:8317/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "fresh-model" }] }), { status: 200 });
    }) as typeof fetch;

    await withTempCwd(async () => {
      const providers: Array<{ name: string; config: any }> = [];
      await extension({
        registerCommand: () => {},
        registerProvider: (name: string, config: any) => providers.push({ name, config }),
        on: () => {},
      } as any);

      assert.equal(providers[0].config.models[0].id, "login-required");
      assert.equal(typeof providers[0].config.refreshModels, "function");

      const refreshed = await providers[0].config.refreshModels({
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async () => true,
      });
      assert.equal(refreshed[0].id, "fresh-model");
      assert.equal(refreshed[0].compat?.supportsStrictMode, false);
      assert.equal(providers.length, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("extension applies the full GPT-5.6 context window from settings.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-cpa-extension-settings-home-"));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;

  try {
    process.env.HOME = home;
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      "pi-cliproxyapi-provider": { gpt56ContextWindow: "full" },
    }));
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "gpt-5.6-sol", owned_by: "openai" }],
    }), { status: 200 })) as typeof fetch;

    await withTempCwd(async () => {
      const providers: Array<{ name: string; config: any }> = [];
      await extension({
        registerCommand: () => {},
        registerProvider: (name: string, config: any) => providers.push({ name, config }),
        on: () => {},
      } as any);

      const refreshed = await providers[0].config.refreshModels({
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async () => true,
      });
      const model = refreshed.find((entry: any) => entry.id === "gpt-5.6-sol");
      assert.equal(model?.contextWindow, 1050000);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("manual refresh uses the active model registry credential", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-cpa-extension-refresh-home-"));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;

  try {
    process.env.HOME = home;
    await withTempCwd(async (cwd) => {
      let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      let receivedAuthorization: string | null = null;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        receivedAuthorization = headers.get("Authorization");
        if (receivedAuthorization !== "Bearer runtime-key") {
          return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
        }
        return new Response(JSON.stringify({ data: [{ id: "fresh-model" }] }), { status: 200 });
      }) as typeof fetch;

      await extension({
        registerCommand: (name: string, options: any) => { if (name === "cliproxyapi") commandHandler = options.handler; },
        registerProvider: () => {},
        on: () => {},
      } as any);

      const notifications: Array<{ message: string; level: string }> = [];
      await commandHandler?.("refresh models", {
        cwd,
        modelRegistry: {
          getApiKeyForProvider: async (providerName: string) => {
            assert.equal(providerName, "cpa");
            return "runtime-key";
          },
        },
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
        },
      });

      assert.equal(receivedAuthorization, "Bearer runtime-key");
      assert.equal(notifications.at(-1)?.level, "info");
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /401 Unauthorized/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Fast mode selects priority or ultrafast without changing reasoning or adding agent workflows", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-cpa-modes-home-"));
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = home;
    await withTempCwd(async (cwd) => {
      await mkdir(join(cwd, ".pi"));
      await writeFile(join(cwd, ".pi", "settings.json"), "{}");
      const commands = new Map<string, any>();
      const hooks = new Map<string, any>();
      const notices: string[] = [];
      let thinking = "high";
      await extension({
        registerCommand: (name: string, options: any) => commands.set(name, options.handler),
        registerProvider: () => {},
        on: (name: string, handler: any) => hooks.set(name, handler),
        getThinkingLevel: () => thinking,
        setThinkingLevel: (level: string) => { thinking = level; },
      } as any);
      const ctx = {
        cwd, hasUI: true,
        model: { provider: "cpa", id: "gpt-6-astra", api: "openai-responses", reasoning: true },
        ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
      };
      assert.ok(commands.has("fast"), "Fast command must be registered");
      assert.equal(commands.has("ultra"), false);
      await hooks.get("session_start")({}, ctx);
      const request = { payload: { model: ctx.model.id, reasoning: { effort: "high" } } };
      assert.equal(hooks.get("before_provider_request")(request, ctx), undefined);
      assert.equal(hooks.has("before_agent_start"), false);

      await commands.get("fast")("fast", ctx);
      assert.equal(hooks.get("before_provider_request")(request, ctx).service_tier, "priority");
      assert.equal(thinking, "high");
      assert.deepEqual(hooks.get("before_provider_request")(request, ctx).reasoning, { effort: "high" });
      assert.deepEqual(request.payload, { model: ctx.model.id, reasoning: { effort: "high" } });
      await commands.get("fast")("status", ctx);
      assert.match(notices.at(-1)!, /fast/);
      await commands.get("fast")("ultrafast", ctx);
      assert.deepEqual(hooks.get("before_provider_request")(request, ctx), {
        ...request.payload, service_tier: "ultrafast",
      });
      await commands.get("fast")("status", ctx);
      assert.match(notices.at(-1)!, /ultrafast/);
      await commands.get("fast")("invalid", ctx);
      assert.equal(hooks.get("before_provider_request")(request, ctx).service_tier, "ultrafast");
      await commands.get("fast")("", ctx);
      assert.equal(hooks.get("before_provider_request")(request, ctx), undefined);
      await commands.get("fast")("", ctx);
      assert.equal(hooks.get("before_provider_request")(request, ctx).service_tier, "priority");
      await commands.get("fast")("off", ctx);
      assert.equal(hooks.get("before_provider_request")(request, ctx), undefined);
      assert.equal(thinking, "high");
      await commands.get("fast")("invalid", ctx);
      assert.match(notices.at(-1)!, /Usage/);
      await commands.get("fast")("ultrafast", ctx);
      const other = { ...ctx, model: { ...ctx.model, provider: "openai" } };
      assert.equal(hooks.get("before_provider_request")(request, other), undefined);
      const completions = { ...ctx, model: { ...ctx.model, api: "openai-completions" } };
      assert.equal(hooks.get("before_provider_request")(request, completions), undefined);
      assert.equal(hooks.get("before_provider_request")({ payload: null }, ctx), undefined);
      assert.equal(thinking, "high");
      const settings = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));
      assert.equal(settings["pi-cliproxyapi-provider"].fastMode, "ultrafast");
      await extension({
        registerCommand: () => {},
        registerProvider: () => {},
        on: (name: string, handler: any) => hooks.set(name, handler),
      } as any);
      assert.equal(hooks.get("before_provider_request")(request, ctx).service_tier, "ultrafast");
      assert.deepEqual(request.payload, { model: ctx.model.id, reasoning: { effort: "high" } });
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("extension registers placeholder provider when global config is invalid", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-cpa-extension-home-"));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = home;
    await withTempCwd(async () => {
      const configDir = join(home, ".pi", "agent", "pi-cliproxyapi-provider");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), JSON.stringify({ headers: null }));

      const providers: Array<{ name: string; config: any }> = [];
      await extension({
        registerCommand: () => {},
        registerProvider: (name: string, config: any) => providers.push({ name, config }),
        on: () => {},
      } as any);

      assert.equal(providers.length, 1);
      assert.equal(providers[0].name, "cpa");
      assert.equal(providers[0].config.models[0].id, "login-required");
      assert.equal(providers[0].config.models[0].compat.supportsStrictMode, false);
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});
