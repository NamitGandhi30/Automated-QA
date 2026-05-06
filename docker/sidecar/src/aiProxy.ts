import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

type Provider = 'openai' | 'grok' | 'claude' | 'gemini' | 'copilot';

interface ProviderConfig {
  defaultModel: string;
  handler: (prompt: string, apiKey: string, model: string) => Promise<string>;
}

const providers: Record<string, ProviderConfig> = {
  openai: {
    defaultModel: 'gpt-4o',
    handler: async (prompt, apiKey, model) => {
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4096,
      });
      return response.choices[0]?.message?.content || '';
    },
  },

  grok: {
    defaultModel: 'grok-3',
    handler: async (prompt, apiKey, model) => {
      // Grok uses OpenAI-compatible API
      const client = new OpenAI({
        apiKey,
        baseURL: 'https://api.x.ai/v1',
      });
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4096,
      });
      return response.choices[0]?.message?.content || '';
    },
  },

  claude: {
    defaultModel: 'claude-sonnet-4-20250514',
    handler: async (prompt, apiKey, model) => {
      const client = new Anthropic({ apiKey });
      const message = await client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = message.content[0];
      return block.type === 'text' ? block.text : '';
    },
  },

  gemini: {
    defaultModel: 'gemini-2.0-flash',
    handler: async (prompt, apiKey, model) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const genModel = genAI.getGenerativeModel({ model });
      const result = await genModel.generateContent(prompt);
      return result.response.text();
    },
  },
};

export async function aiComplete(
  prompt: string,
  provider: string,
  apiKey?: string,
  model?: string
): Promise<string> {
  if (provider === 'copilot') {
    throw new Error('Copilot requests should be handled by the extension host, not the sidecar.');
  }

  const config = providers[provider];
  if (!config) {
    throw new Error(`Unknown AI provider: ${provider}. Supported: ${Object.keys(providers).join(', ')}`);
  }

  if (!apiKey) {
    throw new Error(`API key required for provider: ${provider}`);
  }

  const selectedModel = model || config.defaultModel;
  console.log(`AI request: provider=${provider}, model=${selectedModel}, promptLength=${prompt.length}`);

  try {
    const response = await config.handler(prompt, apiKey, selectedModel);
    console.log(`AI response: provider=${provider}, responseLength=${response.length}`);
    return response;
  } catch (err: any) {
    console.error(`AI provider ${provider} error:`, err.message);
    throw new Error(`${provider} API error: ${err.message}`);
  }
}
