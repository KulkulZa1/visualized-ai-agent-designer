/**
 * credentialService.ts — VS Code SecretStorage adapter for API keys.
 *
 * Replaces the localStorage-based key storage used in the Tauri app.
 * VS Code's SecretStorage is backed by the OS keychain on each platform:
 *   Windows:  Windows Credential Manager
 *   macOS:    Keychain
 *   Linux:    libsecret / GNOME Keyring
 *
 * This is the secure credential path referenced in docs/SECURITY.md Phase 7.
 *
 * Air-gapped note: API keys are stored locally; no external calls are made here.
 */

import type * as vscode from "vscode";

export class CredentialService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(provider: "anthropic" | "openai" | "ollama"): Promise<string | undefined> {
    return this.secrets.get(`harness.${provider}.apiKey`);
  }

  async setApiKey(provider: "anthropic" | "openai" | "ollama", value: string): Promise<void> {
    await this.secrets.store(`harness.${provider}.apiKey`, value);
  }

  async deleteApiKey(provider: "anthropic" | "openai" | "ollama"): Promise<void> {
    await this.secrets.delete(`harness.${provider}.apiKey`);
  }

  /** Returns all keys as a provider-defaults-shaped object for the invoke bridge. */
  async getProviderDefaults(ollamaBaseUrl: string, ollamaModel: string): Promise<Record<string, unknown>> {
    const openaiKey    = await this.getApiKey("openai");
    const anthropicKey = await this.getApiKey("anthropic");
    const ollamaKey    = await this.getApiKey("ollama");

    return {
      llm_provider:                 "ollama",
      ollama_base_url:              ollamaBaseUrl,
      ollama_model:                 ollamaModel,
      openai_api_key_configured:    Boolean(openaiKey),
      anthropic_api_key_configured: Boolean(anthropicKey),
      ollama_api_key_configured:    Boolean(ollamaKey),
      suggested_ollama_models:      ["qwen2.5-coder:7b", "qwen2.5:14b", "gemma3:4b"],
    };
  }
}
