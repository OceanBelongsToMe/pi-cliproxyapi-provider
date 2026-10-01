import test from "node:test";
import assert from "node:assert/strict";
import { cliproxyapiArgumentCompletions, registerCliproxyapiCommand } from "../src/commands.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ProviderCatalog } from "../src/catalog.ts";
import { ProviderRuntime } from "../src/runtime.ts";
import { DEFAULT_CONFIG, globalConfigPath, writeConfigFile } from "../src/config.ts";
import { writeCache } from "../src/cache.ts";
import { cpaModelsCachePath } from "../src/discovery.ts";

async function refreshFixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pi-cpa-publication-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });
  const config = { ...DEFAULT_CONFIG, authRequired: false, authHeader: false, modelsDevEnabled: false };
  writeConfigFile(globalConfigPath(), config);
  await writeFile(join(home, "metadata.json"), "{}");
  await writeCache(cpaModelsCachePath(config), [{ id: "A" }]);
  const catalog = new ProviderCatalog({
    config, gpt56ContextWindow: "canonical", bundledModelsDevPath: join(home, "metadata.json"),
    getApiKey: async () => "fixture-key",
  });
  const modelsStore = new InMemoryModelsStore();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore,
    modelsPath: null, refreshOnCreate: false,
  });
  const registry = new ModelRegistry(modelRuntime);
  let handler: any;
  const pi = {
    registerProvider: registry.registerProvider.bind(registry),
    registerCommand: (_name: string, definition: any) => { handler = definition.handler; },
  };
  const runtime = new ProviderRuntime({ pi: pi as any, config, catalog });
  registerCliproxyapiCommand(pi as any, runtime, catalog);
  await runtime.start();
  await registry.refresh({ providers: [config.providerName], allowNetwork: false });
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd: home, modelRegistry: registry,
    ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
  };
  return { config, catalog, runtime, registry, modelRuntime, modelsStore, pi, ctx, notices, run: (args: string) => handler(args, ctx) };
}

test("manual refresh restores startup A after native B and repeated unchanged refreshes", async (t) => {
  const f = await refreshFixture(t);
  let id = "B";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests.push(String(url));
    return Response.json({ data: [{ id }] });
  });
  assert.ok(f.registry.find("cpa", "A"));
  const native = await f.registry.refresh({ providers: ["cpa"], allowNetwork: true, force: true });
  assert.equal(native.errors.size, 0);
  assert.ok(f.registry.find("cpa", "B"));

  id = "A";
  const restore = t.mock.method(f.registry, "refresh");
  await f.run("refresh models");
  assert.deepEqual(f.registry.getAll().filter(m => m.provider === "cpa").map(m => m.id), ["A"]);
  await f.run("refresh models");
  assert.deepEqual(f.registry.getAll().filter(m => m.provider === "cpa").map(m => m.id), ["A"]);
  assert.equal(restore.mock.callCount(), 2, "successful unchanged sources still require restoration");
  for (const call of restore.mock.calls) {
    assert.deepEqual(call.arguments, [{ providers: ["cpa"], allowNetwork: false }]);
  }
  assert.equal(requests.length, 3, "restoration must not initiate another network refresh");
  assert.match(f.notices.at(-1)!.message, /CPA models: unchanged/);
});

test("refresh reports restore errors and observed registry counts rather than catalog acceptance", async (t) => {
  const f = await refreshFixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "C" }, { id: "D" }] }));
  t.mock.method(f.modelsStore, "read", async () => { throw new Error("fixture store unavailable"); });

  await f.run("refresh models");

  assert.deepEqual(f.registry.getAll().filter(m => m.provider === "cpa").map(m => m.id), ["A"]);
  const notice = f.notices.at(-1)!;
  assert.equal(notice.level, "warning");
  assert.match(notice.message, /CPA models: updated/);
  assert.match(notice.message, /registry restore failed.*fixture store unavailable/i);
  assert.match(notice.message, /Catalog: 2 models/);
  assert.match(notice.message, /Pi registry now: 1 models/);
  assert.doesNotMatch(notice.message, /Registered:|previous registry retained|refresh complete/i);
});

test("refresh reports aborted and thrown restoration failures", async (t) => {
  const f = await refreshFixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "A" }] }));
  const restore = t.mock.method(f.registry, "refresh", async () => ({ aborted: true, errors: new Map() }));
  await f.run("refresh models");
  assert.equal(f.notices.at(-1)!.level, "warning");
  assert.match(f.notices.at(-1)!.message, /registry restore aborted/i);

  restore.mock.mockImplementation(async () => { throw new Error("fixture restore threw"); });
  await f.run("refresh models");
  assert.equal(f.notices.at(-1)!.level, "warning");
  assert.match(f.notices.at(-1)!.message, /registry restore failed.*fixture restore threw/i);
  assert.match(f.notices.at(-1)!.message, /Pi registry now: 1 models/);
});

test("manual refresh reselects the same current model through Pi without changing startup defaults", async (t) => {
  const f = await refreshFixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "A" }] }));
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "other", defaultModel: "default", defaultThinkingLevel: "high" });
  const thinkingChanges: string[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: f.ctx.cwd, agentDir: join(f.ctx.cwd, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      registerCliproxyapiCommand(pi, f.runtime, f.catalog);
      pi.on("thinking_level_select", event => { thinkingChanges.push(event.level); });
    }],
  });
  await resourceLoader.reload();
  const original = { ...f.registry.find("cpa", "A")!, reasoning: true, contextWindow: 999999 };
  const { session } = await createAgentSession({
    cwd: f.ctx.cwd, agentDir: join(f.ctx.cwd, "agent"), modelRuntime: f.modelRuntime,
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(f.ctx.cwd),
    model: original, thinkingLevel: "high", noTools: "all",
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ uiContext: f.ctx.ui as any });
  await session.prompt("/cliproxyapi refresh models");

  assert.deepEqual(session.model, f.registry.find("cpa", "A"));
  assert.notEqual(session.model, original);
  assert.equal(session.thinkingLevel, "off", "Pi clamps thinking to refreshed capabilities");
  assert.deepEqual(thinkingChanges, ["off"]);
  assert.equal(settingsManager.getDefaultProvider(), "other");
  assert.equal(settingsManager.getDefaultModel(), "default");
  assert.equal(settingsManager.getDefaultThinkingLevel(), "high");
});

test("refresh warns about missing or rejected current selection and never selects a different model", async (t) => {
  const f = await refreshFixture(t);
  let ids = ["B"];
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: ids.map(id => ({ id })) }));
  const original = f.registry.find("cpa", "A")!;
  Object.assign(f.ctx, { model: original });
  let selections = 0;
  Object.assign(f.pi, { setModel: async () => { selections++; return false; } });
  await f.run("refresh models");
  assert.equal(selections, 0);
  assert.equal(f.notices.at(-1)!.level, "warning");
  assert.match(f.notices.at(-1)!.message, /Selected model cpa\/A is missing.*stale/);

  ids = ["A"];
  await f.run("refresh models");
  assert.equal(f.notices.at(-1)!.level, "warning");
  assert.match(f.notices.at(-1)!.message, /selection refresh failed.*authentication.*stale/i);
  Object.assign(f.pi, { setModel: async () => { throw new Error("fixture selection threw"); } });
  await f.run("refresh models");
  assert.match(f.notices.at(-1)!.message, /selection refresh failed.*fixture selection threw.*stale/i);

  const restore = f.registry.refresh.bind(f.registry);
  t.mock.method(f.registry, "refresh", async options => {
    const result = await restore(options);
    Object.assign(f.ctx, { model: { ...original, provider: "peer" } });
    return result;
  });
  Object.assign(f.pi, { setModel: async () => assert.fail("must not reselect CPA after the current provider changes") });
  await f.run("refresh models");
  assert.equal(f.notices.at(-1)!.level, "info");
});

test("CPA native publication and manual restore preserve an in-flight peer native refresh", async (t) => {
  const f = await refreshFixture(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let peerSignal: AbortSignal | undefined;
  const peerModel = { ...f.registry.find("cpa", "A")!, provider: "peer", id: "peer-fresh" };
  f.registry.registerProvider(createProvider({
    id: "peer", models: [], api: openAICompletionsApi,
    auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }) } },
    fetchModels: async ({ allowNetwork, signal }) => {
      if (!allowNetwork) return [];
      peerSignal = signal;
      started.resolve();
      await release.promise;
      return [peerModel];
    },
  }));
  await f.registry.refresh({ allowNetwork: false });
  const peerRefresh = f.registry.refresh({ providers: ["peer"], allowNetwork: true, force: true });
  t.after(() => release.resolve());
  await started.promise;
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "B" }] }));
  await f.registry.refresh({ providers: ["cpa"], allowNetwork: true, force: true });
  await f.run("refresh models");
  assert.equal(peerSignal!.aborted, false);
  release.resolve();
  const result = await peerRefresh;
  assert.equal(result.aborted, false);
  assert.equal(result.errors.size, 0);
  assert.ok(f.registry.find("peer", "peer-fresh"));
  assert.ok(f.registry.find("cpa", "B"));
});

test("models, metadata, and all refresh only requested sources and restore their catalog", async (t) => {
  const f = await refreshFixture(t);
  f.config.modelsDevEnabled = true;
  writeConfigFile(globalConfigPath(), f.config);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests.push(String(url));
    return String(url) === "https://models.dev/api.json"
      ? Response.json({ openai: { models: { A: { id: "A", name: "Enriched A", limit: { context: 512000, output: 32768 } } } } })
      : Response.json({ data: [{ id: "A", owned_by: "openai" }] });
  });
  await f.run("refresh models");
  assert.deepEqual(requests.splice(0), ["http://localhost:8317/v1/models"]);
  assert.match(f.notices.at(-1)!.message, /models.dev metadata: not requested/);
  await f.run("refresh metadata");
  assert.deepEqual(requests.splice(0), ["https://models.dev/api.json"]);
  assert.match(f.notices.at(-1)!.message, /CPA models: not requested/);
  assert.equal(f.registry.find("cpa", "A")!.contextWindow, 512000);
  await f.run("refresh");
  assert.deepEqual(requests, ["http://localhost:8317/v1/models", "https://models.dev/api.json"]);
  assert.match(f.notices.at(-1)!.message, /CPA models: unchanged/);
  assert.match(f.notices.at(-1)!.message, /models.dev metadata: unchanged/);
});

test("failed sources do not restore Pi, while partial success still restores", async (t) => {
  const f = await refreshFixture(t);
  let failModels = true;
  f.config.modelsDevEnabled = true;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url) === "https://models.dev/api.json" || failModels) return new Response("fixture failure", { status: 503 });
    return Response.json({ data: [] });
  });
  const restore = t.mock.method(f.registry, "refresh");
  await f.run("refresh all");
  assert.equal(restore.mock.callCount(), 0);
  assert.match(f.notices.at(-1)!.message, /CPA models: failed/);
  assert.equal(f.notices.at(-1)!.level, "warning");
  failModels = false;
  await f.run("refresh all");
  assert.equal(restore.mock.callCount(), 1);
  assert.deepEqual(f.registry.getAll().filter(m => m.provider === "cpa").map(m => m.id), ["login-required"]);
  assert.match(f.notices.at(-1)!.message, /Catalog: 0 models/);
  assert.match(f.notices.at(-1)!.message, /Pi registry now: 1 models/);
  assert.equal(f.notices.at(-1)!.level, "warning");
});

test("slash command argument completions include labels for pi autocomplete", () => {
  const completions = cliproxyapiArgumentCompletions("sta");

  assert.deepEqual(completions, [{ value: "status", label: "status" }]);
});

test("help documents every advertised command without requiring an available provider", async () => {
  let command: any;
  registerCliproxyapiCommand({
    registerCommand: (_name: string, definition: any) => { command = definition; },
  } as any);
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as any;

  await command.handler("help", ctx);

  assert.equal(notifications[0].level, "info");
  for (const value of ["status", "refresh", "refresh models", "refresh metadata", "aliases", "models", "config", "config connection", "help"]) {
    assert.match(notifications[0].message, new RegExp(`/cliproxyapi ${value.replace(" ", "\\s+")}`));
  }
});

test("models and connection configuration are advertised for slash-command autocomplete", () => {
  assert.deepEqual(cliproxyapiArgumentCompletions("mod"), [{ value: "models", label: "models" }]);
  assert.deepEqual(cliproxyapiArgumentCompletions("config c"), [{ value: "config connection", label: "config connection" }]);
});

test("models reports its TUI requirement instead of being treated as an unknown command", async () => {
  let command: any;
  registerCliproxyapiCommand({
    registerCommand: (_name: string, definition: any) => { command = definition; },
  } as any, {} as any, {
    current: () => undefined,
    load: async () => ({ built: { models: [], stats: {} } }),
  } as any);
  const notifications: Array<{ message: string; level: string }> = [];

  await command.handler("models", {
    cwd: process.cwd(),
    hasUI: false,
    mode: "json",
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  } as any);

  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /requires interactive TUI mode/);
});

test("models rejects RPC mode even when UI notifications are available", async () => {
  let command: any;
  registerCliproxyapiCommand({
    registerCommand: (_name: string, definition: any) => { command = definition; },
  } as any, {} as any, {
    current: () => { throw new Error("catalog should not load outside TUI mode"); },
  } as any);
  const notifications: Array<{ message: string; level: string }> = [];

  await command.handler("models", {
    cwd: process.cwd(),
    hasUI: true,
    mode: "rpc",
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  } as any);

  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /requires interactive TUI mode/);
});

test("config rejects RPC mode even when UI notifications are available", async () => {
  let command: any;
  registerCliproxyapiCommand({
    registerCommand: (_name: string, definition: any) => { command = definition; },
  } as any);
  const notifications: Array<{ message: string; level: string }> = [];

  await command.handler("config", {
    cwd: process.cwd(),
    hasUI: true,
    mode: "rpc",
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  } as any);

  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /requires interactive TUI mode/);
});

test("an empty command shows help", async () => {
  let command: any;
  registerCliproxyapiCommand({
    registerCommand: (_name: string, definition: any) => { command = definition; },
  } as any);
  const notifications: string[] = [];

  await command.handler("", {
    ui: { notify: (message: string) => notifications.push(message) },
  } as any);

  assert.match(notifications[0], /CLIProxyAPI provider commands:/);
});

test("an unknown command shows full usage and identifies the command", async () => {
  let command: any;
  registerCliproxyapiCommand({
    registerCommand: (_name: string, definition: any) => { command = definition; },
  } as any);
  const notifications: Array<{ message: string; level: string }> = [];

  await command.handler("wut", {
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as any);

  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /CLIProxyAPI provider commands:/);
  assert.match(notifications[0].message, /Unknown command: wut/);
});
