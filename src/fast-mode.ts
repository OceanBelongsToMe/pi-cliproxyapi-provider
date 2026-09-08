import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveProviderSettings, type FastMode } from "./settings.ts";

export function registerFastMode(pi: ExtensionAPI, providerName: string, mode: FastMode): void {
  function supportsFast(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === providerName && ctx.model.api === "openai-responses";
  }

  function status(ctx: ExtensionContext): string {
    return `CPA Fast: ${mode}${mode !== "off" && !supportsFast(ctx) ? ", inactive for this model" : ""}`;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus("cpa-fast", mode !== "off" ? status(ctx) : undefined);
  }

  pi.registerCommand("fast", {
    description: "Set CPA service tier without changing reasoning: /fast [off|fast|ultrafast|status]",
    async handler(args, ctx) {
      const option = args.trim();
      if (option === "status") {
        ctx.ui.notify(status(ctx), "info");
        return;
      }
      if (option !== "" && option !== "off" && option !== "fast" && option !== "ultrafast") {
        ctx.ui.notify("Usage: /fast [off|fast|ultrafast|status]", "warning");
        return;
      }
      const next = option || (mode === "off" ? "fast" : "off");
      try {
        saveProviderSettings(ctx.cwd, { fastMode: next });
      } catch (error) {
        ctx.ui.notify(`Could not save CPA Fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      mode = next;
      updateStatus(ctx);
      ctx.ui.notify(status(ctx), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("before_provider_request", (event, ctx) => {
    if (mode === "off" || !supportsFast(ctx)) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    return { ...payload, service_tier: mode === "fast" ? "priority" : "ultrafast" };
  });
}
