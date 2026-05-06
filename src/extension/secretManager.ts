import * as vscode from 'vscode';

export type AIProvider = 'copilot' | 'openai' | 'grok' | 'claude' | 'gemini';

const KEY_PREFIX = 'automatedqa.apikey.';

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
    return vscode.workspace.getConfiguration('automatedqa').get<AIProvider>('aiProvider') || 'copilot';
  }

  async getActiveKeyIfNeeded(): Promise<{ provider: AIProvider; apiKey?: string }> {
    const provider = this.getActiveProvider();
    if (provider === 'copilot') {
      return { provider };
    }
    const apiKey = await this.getKey(provider);
    if (!apiKey) {
      vscode.window.showWarningMessage(
        `Automated QA: No API key configured for ${provider}. Falling back to Copilot.`
      );
      return { provider: 'copilot' };
    }
    return { provider, apiKey };
  }
}
