import React, { useState, useEffect } from 'react';

type Provider = 'copilot' | 'openai' | 'grok' | 'claude' | 'gemini' | 'ollama';

interface Props {
  provider: string;
  ollamaConfig: { baseUrl: string; model: string };
  ollamaHasKey: boolean;
  connectionResult: { success: boolean; message: string } | null;
  postMessage: (msg: any) => void;
}

const providers: { id: Provider; name: string; icon: string; requiresKey: boolean; description: string }[] = [
  { id: 'copilot', name: 'GitHub Copilot', icon: '🤖', requiresKey: false, description: 'VS Code Language Model API — no key needed' },
  { id: 'openai', name: 'OpenAI', icon: '🟢', requiresKey: true, description: 'GPT-4o, GPT-4o-mini — requires API key' },
  { id: 'grok', name: 'Grok (xAI)', icon: '⚡', requiresKey: true, description: 'Grok-3 — requires API key' },
  { id: 'claude', name: 'Claude (Anthropic)', icon: '🟣', requiresKey: true, description: 'Claude Haiku / Sonnet — requires API key' },
  { id: 'gemini', name: 'Gemini (Google)', icon: '🔵', requiresKey: true, description: 'Gemini Flash / Pro — requires API key' },
  { id: 'ollama', name: 'Ollama', icon: '🦙', requiresKey: false, description: 'Local or cloud Ollama — no API key needed' },
];

const SettingsPanel: React.FC<Props> = ({ provider, ollamaConfig, ollamaHasKey, connectionResult, postMessage }) => {
  const [selectedProvider, setSelectedProvider] = useState<Provider>(provider as Provider);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [savedProviders, setSavedProviders] = useState<Set<string>>(new Set());
  const [isTesting, setIsTesting] = useState(false);

  // Ollama local state
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(ollamaConfig?.baseUrl || 'http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState(ollamaConfig?.model || 'llama3');
  const [ollamaSaved, setOllamaSaved] = useState(false);
  const [ollamaApiKey, setOllamaApiKey] = useState('');
  const [ollamaApiKeySaved, setOllamaApiKeySaved] = useState(false);

  // Sync ollamaHasKey from parent
  useEffect(() => {
    setOllamaApiKeySaved(ollamaHasKey);
  }, [ollamaHasKey]);

  // Sync when parent updates provider
  useEffect(() => {
    setSelectedProvider(provider as Provider);
  }, [provider]);

  // Sync Ollama config from extension host
  useEffect(() => {
    if (ollamaConfig) {
      setOllamaBaseUrl(ollamaConfig.baseUrl || 'http://localhost:11434');
      setOllamaModel(ollamaConfig.model || 'llama3');
    }
  }, [ollamaConfig]);

  // When connection result arrives, clear testing state
  useEffect(() => {
    if (connectionResult !== null) {
      setIsTesting(false);
    }
  }, [connectionResult]);

  const handleSelectProvider = (providerId: Provider) => {
    setSelectedProvider(providerId);
    postMessage({ command: 'setProvider', provider: providerId });
  };

  const handleSaveKey = (providerId: Provider) => {
    const key = apiKeys[providerId];
    if (!key || !key.trim()) { return; }
    postMessage({ command: 'setApiKey', provider: providerId, apiKey: key.trim() });
    setSavedProviders(prev => new Set([...prev, providerId]));
    setApiKeys(prev => ({ ...prev, [providerId]: '' }));
  };

  const handleDeleteKey = (providerId: Provider) => {
    postMessage({ command: 'deleteApiKey', provider: providerId });
    setSavedProviders(prev => {
      const next = new Set(prev);
      next.delete(providerId);
      return next;
    });
  };

  const handleTestConnection = (providerId: Provider) => {
    setIsTesting(true);
    postMessage({ command: 'testConnection', provider: providerId });
  };

  const handleSaveOllama = () => {
    postMessage({ command: 'setOllamaConfig', baseUrl: ollamaBaseUrl.trim(), model: ollamaModel.trim() });
    setOllamaSaved(true);
    setTimeout(() => setOllamaSaved(false), 3000);
  };

  const handleSaveOllamaKey = () => {
    if (!ollamaApiKey.trim()) { return; }
    postMessage({ command: 'setOllamaApiKey', apiKey: ollamaApiKey.trim() });
    setOllamaApiKey('');
    setOllamaApiKeySaved(true);
  };

  const handleDeleteOllamaKey = () => {
    postMessage({ command: 'deleteOllamaApiKey' });
    setOllamaApiKeySaved(false);
  };

  const currentProviderInfo = providers.find(p => p.id === selectedProvider);

  return (
    <div>
      {/* Provider selector */}
      <div className="glass-card">
        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
          AI Provider
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {providers.map((p) => (
            <button
              key={p.id}
              className="btn-secondary"
              onClick={() => handleSelectProvider(p.id)}
              style={{
                width: '100%',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderColor: selectedProvider === p.id ? '#7c3aed' : undefined,
                background: selectedProvider === p.id ? '#7c3aed18' : undefined,
              }}
            >
              <span style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <span>{p.icon} {p.name}</span>
                <span style={{ fontSize: '9px', opacity: 0.5, fontWeight: 400 }}>{p.description}</span>
              </span>
              {selectedProvider === p.id && (
                <span style={{ color: '#7c3aed', fontSize: '10px', fontWeight: 700, flexShrink: 0, marginLeft: '8px' }}>● Active</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Copilot info */}
      {selectedProvider === 'copilot' && (
        <div className="glass-card">
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>🤖 GitHub Copilot / VS Code LM</div>
          <div style={{ fontSize: '11px', opacity: 0.7, lineHeight: 1.5, marginBottom: '10px' }}>
            Uses the VS Code Language Model API. No API key needed — just have GitHub Copilot installed and signed in.
            Works with any available model (Qwen, GPT-4o, Claude, Gemini, etc.).
          </div>

          <div style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
              <label style={{ fontSize: '10px', opacity: 0.6 }}>Pin Model</label>
              <span style={{ fontSize: '9px', opacity: 0.4, fontStyle: 'italic' }}>optional</span>
            </div>
            <input
              className="input"
              type="text"
              placeholder="e.g. qwen, gpt-4o, claude-3, gemini-2.0-flash — blank = auto"
              onBlur={(e) => {
                const val = e.target.value.trim();
                postMessage({ command: 'setPinnedCopilotModel', model: val });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  postMessage({ command: 'setPinnedCopilotModel', model: val });
                }
              }}
            />
            <div style={{ fontSize: '9px', opacity: 0.4, marginTop: '3px' }}>
              Test Connection below will list all models available to you.
            </div>
          </div>

          <button
            className="btn-secondary"
            style={{ width: '100%' }}
            onClick={() => handleTestConnection('copilot')}
            disabled={isTesting}
          >
            {isTesting ? '⏳ Listing models...' : '🔗 Test Connection & List Models'}
          </button>
        </div>
      )}


      {/* Ollama config card */}
      {selectedProvider === 'ollama' && (
        <div className="glass-card">
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>🦙 Ollama Configuration</div>
          <div style={{ fontSize: '10px', opacity: 0.6, lineHeight: 1.5, marginBottom: '10px' }}>
            No API key required. Works with local Ollama (<code>ollama serve</code>) or any cloud-hosted Ollama endpoint.
          </div>

          <div style={{ marginBottom: '6px' }}>
            <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '3px' }}>Base URL</label>
            <input
              className="input"
              type="text"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              placeholder="http://localhost:11434"
            />
          </div>

          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '10px', opacity: 0.6, display: 'block', marginBottom: '3px' }}>Model</label>
            <input
              className="input"
              type="text"
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              placeholder="llama3, mistral, codellama, qwen2.5-coder..."
            />
            <div style={{ fontSize: '9px', opacity: 0.4, marginTop: '3px' }}>
              Run <code>ollama list</code> to see available models.
            </div>
          </div>

          {/* Optional API key for protected/cloud endpoints */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '10px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
              <label style={{ fontSize: '10px', opacity: 0.6 }}>Bearer Token</label>
              <span style={{ fontSize: '9px', opacity: 0.4, fontStyle: 'italic' }}>optional</span>
              {ollamaApiKeySaved && (
                <span style={{ fontSize: '9px', color: '#4ade80', marginLeft: 'auto' }}>● key saved</span>
              )}
            </div>
            <div style={{ fontSize: '9px', opacity: 0.4, marginBottom: '6px', lineHeight: 1.4 }}>
              Only needed for cloud/protected Ollama endpoints that require authentication.
              Local Ollama does not need this.
            </div>
            <input
              className="input"
              type="password"
              value={ollamaApiKey}
              onChange={(e) => setOllamaApiKey(e.target.value)}
              placeholder={ollamaApiKeySaved ? '••••••••••••  (token saved)' : 'Bearer token (if required)...'}
              onKeyDown={(e) => { if (e.key === 'Enter') { handleSaveOllamaKey(); } }}
            />
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button
                className="btn-primary"
                style={{ flex: 1, fontSize: '11px', padding: '6px' }}
                onClick={handleSaveOllamaKey}
                disabled={!ollamaApiKey.trim()}
              >
                💾 Save Token
              </button>
              {ollamaApiKeySaved && (
                <button
                  className="btn-secondary"
                  style={{ color: '#f87171', borderColor: '#f8717140' }}
                  onClick={handleDeleteOllamaKey}
                  title="Remove saved token"
                >
                  🗑️
                </button>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className="btn-primary"
              style={{ flex: 1, fontSize: '11px', padding: '6px' }}
              onClick={handleSaveOllama}
              disabled={!ollamaBaseUrl.trim() || !ollamaModel.trim()}
            >
              {ollamaSaved ? '✅ Saved!' : '💾 Save Config'}
            </button>
            <button
              className="btn-secondary"
              style={{ flex: 1 }}
              onClick={() => handleTestConnection('ollama')}
              disabled={isTesting}
            >
              {isTesting ? '⏳' : '🔗 Test'}
            </button>
          </div>

        </div>
      )}

      {/* Key config for providers that need a key */}
      {providers.filter(p => p.requiresKey && p.id === selectedProvider).map((p) => (
        <div key={p.id} className="glass-card">
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>
            {p.icon} {p.name} API Key
          </div>
          <div style={{ marginBottom: '8px' }}>
            <input
              className="input"
              type="password"
              value={apiKeys[p.id] || ''}
              onChange={(e) => setApiKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
              placeholder={savedProviders.has(p.id) ? '••••••••••••••••  (key saved)' : 'Paste your API key...'}
              onKeyDown={(e) => { if (e.key === 'Enter') { handleSaveKey(p.id); } }}
            />
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className="btn-primary"
              style={{ flex: 1, fontSize: '11px', padding: '6px' }}
              onClick={() => handleSaveKey(p.id)}
              disabled={!apiKeys[p.id]?.trim()}
            >
              💾 Save Key
            </button>
            <button
              className="btn-secondary"
              style={{ flex: 1 }}
              onClick={() => handleTestConnection(p.id)}
              disabled={isTesting}
            >
              {isTesting ? '⏳' : '🔗 Test'}
            </button>
            {savedProviders.has(p.id) && (
              <button
                className="btn-secondary"
                style={{ color: '#f87171', borderColor: '#f8717140' }}
                onClick={() => handleDeleteKey(p.id)}
                title="Delete saved key"
              >
                🗑️
              </button>
            )}
          </div>
          <div style={{ marginTop: '8px', fontSize: '10px', opacity: 0.5 }}>
            {p.id === 'openai' && 'Get key at: platform.openai.com/api-keys'}
            {p.id === 'grok' && 'Get key at: console.x.ai'}
            {p.id === 'claude' && 'Get key at: console.anthropic.com/settings/keys'}
            {p.id === 'gemini' && 'Get key at: aistudio.google.com/apikey'}
          </div>
        </div>
      ))}

      {/* Connection result */}
      {connectionResult && (
        <div className="glass-card" style={{
          borderColor: connectionResult.success ? '#4ade8040' : '#f8717140',
          background: connectionResult.success ? '#4ade8008' : '#f8717108',
        }}>
          <div style={{ fontSize: '11px', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
            <span>{connectionResult.success ? '✅' : '❌'}</span>
            <span style={{ lineHeight: 1.4 }}>{connectionResult.message}</span>
          </div>
        </div>
      )}

      {/* Security note */}
      <div className="glass-card" style={{ opacity: 0.55, fontSize: '10px', lineHeight: 1.5 }}>
        🔒 API keys are stored in VS Code's Secret Storage — never written to disk, config files, or logs.
        Ollama config is stored in VS Code settings (no sensitive data).
      </div>
    </div>
  );
};

export default SettingsPanel;
