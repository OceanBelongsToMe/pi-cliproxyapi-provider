import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type InputModality = "text" | "image";

/**
 * Boolean compatibility flags accepted in `modelOverrides[].compat`.
 * Mirrors the boolean fields of pi's OpenAI completions compat settings.
 * `supportsStrictMode` stays provider-owned and is intentionally excluded.
 */
export const COMPAT_OVERRIDE_FIELDS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "supportsThinkingTokenBudget",
  "supportsOpenAIGrammarTools",
  "supportsLongCacheRetention",
  "sendSessionAffinityHeaders",
  "zaiToolStream",
] as const;

export type CompatOverrideField = (typeof COMPAT_OVERRIDE_FIELDS)[number];

export type CompatOverride = Partial<Record<CompatOverrideField, boolean>>;

/** Layer variant where `null` clears a field (project scope). */
export type CompatOverrideLayer = Partial<Record<CompatOverrideField, boolean | null>>;

export interface ProviderModelOverride {
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  compat?: CompatOverride;
}

export interface ProviderModelOverrideLayer {
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  /** `null` clears the whole compat override (project scope). */
  compat?: CompatOverrideLayer | null;
}

export type ProviderModelOverrides = Record<string, ProviderModelOverride>;
export type ProviderModelOverrideLayers = Record<string, ProviderModelOverrideLayer>;

export interface CpaProviderConfig {
  providerName: string;
  baseUrl: string;
  authRequired: boolean;
  authHeader: boolean;
  headers: Record<string, string>;
  modelsDevEnabled: boolean;
  metadataFallbackProvider: string | null;
  modelAliases: Record<string, string>;
  modelOverrides: ProviderModelOverrides;
}

export interface ModelsDevMetadata {
  id: string;
  /** models.dev provider key retained for owner-hint matching. */
  sourceProvider?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{
    type?: string;
    values?: string[];
  }>;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: Array<{
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
      tier?: {
        type?: string;
        size?: number;
      };
    }>;
  };
}

export type ModelsDevCatalog = Record<string, ModelsDevMetadata>;

export interface ProviderModelConfigLike {
  id: string;
  name: string;
  reasoning: boolean;
  api?: ProviderModelConfig["api"];
  compat?: ProviderModelConfig["compat"];
  thinkingLevelMap?: ThinkingLevelMap;
  input: InputModality[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
  contextWindow: number;
  maxTokens: number;
}
