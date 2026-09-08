import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveProviderSettings } from "./settings.ts";

export function registerFastMode(pi: ExtensionAPI, providerName: string, enabled: boolean): void {
  function supportsFast(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === providerName && ctx.model.api === "openai-responses";
  }

  function status(ctx: ExtensionContext): string {
    return `CPA Fast: ${enabled ? (supportsFast(ctx) ? "on (priority)" : "on, inactive for this model") : "off"}`;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus("cpa-fast", enabled ? status(ctx) : undefined);
  }

  pi.registerCommand("fast", {
    description: "Toggle CPA Fast service tier without changing reasoning: /fast [on|off|status]",
    async handler(args, ctx) {
      const option = args.trim();
      if (option === "status") {
        ctx.ui.notify(status(ctx), "info");
        return;
      }
      if (option && option !== "on" && option !== "off") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }
      const next = option ? option === "on" : !enabled;
      try {
        saveProviderSettings(ctx.cwd, { fastMode: next });
      } catch (error) {
        ctx.ui.notify(`Could not save CPA Fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      enabled = next;
      updateStatus(ctx);
      ctx.ui.notify(status(ctx), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !supportsFast(ctx)) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    return { ...payload, service_tier: "priority" };
  });
}
