import React, { useState, useEffect } from 'react';

type Provider = 'copilot' | 'openai' | 'grok' | 'claude' | 'gemini';

interface Props {
  provider: string;
  connectionResult: { success: boolean; message: string } | null;
  postMessage: (msg: any) => void;
}

const providers: { id: Provider; name: string; icon: string; requiresKey: boolean }[] = [
  { id: 'copilot', name: 'GitHub Copilot', icon: '🤖', requiresKey: false },
  { id: 'openai', name: 'OpenAI', icon: '🟢', requiresKey: true },
  { id: 'grok', name: 'Grok (xAI)', icon: '⚡', requiresKey: true },
  { id: 'claude', name: 'Claude (Anthropic)', icon: '🟣', requiresKey: true },
  { id: 'gemini', name: 'Gemini (Google)', icon: '🔵', requiresKey: true },
];

const SettingsPanel: React.FC<Props> = ({ provider, connectionResult, postMessage }) => {
  const [selectedProvider, setSelectedProvider] = useState<Provider>(provider as Provider);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [savedProviders, setSavedProviders] = useState<Set<string>>(new Set());
  const [isTesting, setIsTesting] = useState(false);

  // Sync when parent updates provider
  useEffect(() => {
    setSelectedProvider(provider as Provider);
  }, [provider]);

  // When connection result arrives, clear testing state
  useEffect(() => {
    if (connectionResult !== null) {
      setIsTesting(false);
    }
  }, [connectionResult]);

  const handleSelectProvider = (providerId: Provider) => {
    setSelectedProvider(providerId);
    // Persist the change immediately to VS Code settings
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
              <span>{p.icon} {p.name}</span>
              {selectedProvider === p.id && (
                <span style={{ color: '#7c3aed', fontSize: '10px', fontWeight: 700 }}>● Active</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Copilot info */}
      {selectedProvider === 'copilot' && (
        <div className="glass-card">
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>🤖 GitHub Copilot</div>
          <div style={{ fontSize: '11px', opacity: 0.7, lineHeight: 1.5, marginBottom: '8px' }}>
            Uses the VS Code Language Model API. No API key needed — just have GitHub Copilot installed and signed in.
          </div>
          <button
            className="btn-secondary"
            style={{ width: '100%' }}
            onClick={() => handleTestConnection('copilot')}
            disabled={isTesting}
          >
            {isTesting ? '⏳ Testing...' : '🔗 Test Connection'}
          </button>
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
        🔒 Keys are stored in VS Code's Secret Storage — never written to disk, config files, or logs.
      </div>
    </div>
  );
};

export default SettingsPanel;
