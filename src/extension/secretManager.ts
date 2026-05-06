import * as vscode from 'vscode';

export type AIProvider = 'copilot' | 'openai' | 'grok' | 'claude' | 'gemini' | 'ollama';

const KEY_PREFIX = 'automatedqa.apikey.';

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  apiKey?: string; // optional Bearer token — only needed for cloud/protected endpoints
}

export class SecretManager {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async setKey(provider: AIProvider, key: string): Promise<void> {
    await this.context.secrets.store(`${KEY_PREFIX}${provider}`, key);
  }

  async getKey(provider: AIProvider): Promise<string | undefined> {
    return this.context.secrets.get(`${KEY_PREFIX}${provider}`);
  }

  async deleteKey(provider: AIProvider): Promise<void> {
    await this.context.secrets.delete(`${KEY_PREFIX}${provider}`);
  }

  async hasKey(provider: AIProvider): Promise<boolean> {
    const key = await this.getKey(provider);
    return !!key && key.length > 0;
  }

  getActiveProvider(): AIProvider {
    return (
      vscode.workspace.getConfiguration('automatedqa').get<AIProvider>('aiProvider') || 'copilot'
    );
  }

  // Ollama non-sensitive config is stored in VS Code settings
  getOllamaConfig(): OllamaConfig {
    const cfg = vscode.workspace.getConfiguration('automatedqa');
    return {
      baseUrl: cfg.get<string>('ollamaBaseUrl') || 'http://localhost:11434',
      model: cfg.get<string>('ollamaModel') || 'llama3',
      // apiKey is loaded separately (async) — callers use getOllamaConfigWithKey()
    };
  }

  async getOllamaConfigWithKey(): Promise<OllamaConfig> {
    const base = this.getOllamaConfig();
    const apiKey = await this.context.secrets.get('automatedqa.ollama.apikey');
    return { ...base, apiKey: apiKey || undefined };
  }

  async setOllamaApiKey(key: string): Promise<void> {
    await this.context.secrets.store('automatedqa.ollama.apikey', key);
  }

  async deleteOllamaApiKey(): Promise<void> {
    await this.context.secrets.delete('automatedqa.ollama.apikey');
  }

  async hasOllamaApiKey(): Promise<boolean> {
    const k = await this.context.secrets.get('automatedqa.ollama.apikey');
    return !!k && k.length > 0;
  }

  async setOllamaConfig(baseUrl: string, model: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('automatedqa');
    await cfg.update('ollamaBaseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await cfg.update('ollamaModel', model, vscode.ConfigurationTarget.Global);
  }

  /**
   * Returns the active provider and API key (if applicable).
   * DOES NOT silently fall back to Copilot. Throws a descriptive error if the
   * selected provider has no key configured so callers can surface it in the UI.
   */
  async getActiveKeyIfNeeded(): Promise<{ provider: AIProvider; apiKey?: string }> {
    const provider = this.getActiveProvider();

    if (provider === 'copilot') {
      return { provider };
    }

    if (provider === 'ollama') {
      // Ollama doesn't require a key, but may have an optional one for cloud endpoints
      const cfg = await this.getOllamaConfigWithKey();
      return { provider, apiKey: cfg.apiKey };
    }

    const apiKey = await this.getKey(provider);
    if (!apiKey) {
      throw new Error(
        `No API key configured for "${provider}". ` +
        `Open the Settings tab → select "${provider}" → save your key, then try again.`
      );
    }
    return { provider, apiKey };
  }
}
