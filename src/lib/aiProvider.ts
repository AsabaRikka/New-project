import type { AiProviderConfig } from "./types";

export type AiCapability = "responses" | "chatCompletions" | "images";

export interface AiProviderDescriptor {
  id: AiProviderConfig["provider"];
  label: string;
  baseUrl: string;
  capabilities: AiCapability[];
  models: {
    text: string;
    vision: string;
    image: string;
  };
  timeoutSeconds: number;
  maxRetries: number;
}

export function createOpenAiCompatibleProvider(config: AiProviderConfig): AiProviderDescriptor {
  return {
    id: config.provider,
    label: "OpenAI Compatible",
    baseUrl: config.base_url.replace(/\/+$/, ""),
    capabilities: ["responses", "chatCompletions", "images"],
    models: {
      text: config.text_model,
      vision: config.vision_model,
      image: config.image_model,
    },
    timeoutSeconds: config.timeout_seconds,
    maxRetries: config.max_retries,
  };
}

export function getProviderEndpoint(provider: AiProviderDescriptor, capability: AiCapability) {
  switch (capability) {
    case "responses":
      return `${provider.baseUrl}/responses`;
    case "chatCompletions":
      return `${provider.baseUrl}/chat/completions`;
    case "images":
      return `${provider.baseUrl}/images/generations`;
  }
}
