import React, { useState, useEffect, useCallback } from 'react';
import Dashboard from './components/Dashboard';
import ReviewPanel from './components/ReviewPanel';
import TestPanel from './components/TestPanel';
import VisualQAPanel from './components/VisualQAPanel';
import PRAutomatorPanel from './components/PRAutomator';
import SettingsPanel from './components/SettingsPanel';

declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

type Tab = 'dashboard' | 'reviewer' | 'tests' | 'visual' | 'automator' | 'settings';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [dockerStatus, setDockerStatus] = useState(false);
  const [provider, setProvider] = useState('copilot');
  const [readiness, setReadiness] = useState({ percent: 0, files: {} as any });
  const [findings, setFindings] = useState<any[]>([]);
  const [tests, setTests] = useState<any>(null);
  const [testOutput, setTestOutput] = useState('');
  const [visualResult, setVisualResult] = useState<any>(null);
  const [pipelineStatus, setPipelineStatus] = useState<any>({ stage: 'idle', progress: 0, message: 'Ready' });
  const [connectionResult, setConnectionResult] = useState<any>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case 'dockerStatus':
          setDockerStatus(msg.data);
          break;
        case 'provider':
          setProvider(msg.data);
          break;
        case 'readiness':
          setReadiness(msg.data);
          break;
        case 'reviewFindings':
          setFindings(msg.data);
          break;
        case 'testsGenerated':
          setTests(msg.data);
          break;
        case 'testOutput':
          setTestOutput(msg.data);
          break;
        case 'visualResult':
          setVisualResult(msg.data);
          break;
        case 'pipelineStatus':
          setPipelineStatus(msg.data);
          break;
        case 'connectionResult':
          setConnectionResult(msg.data);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const postMessage = useCallback((msg: any) => vscode.postMessage(msg), []);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'reviewer', label: 'Reviewer', icon: '🔍' },
    { id: 'tests', label: 'Tests', icon: '🧪' },
    { id: 'visual', label: 'Visual QA', icon: '🖼️' },
    { id: 'automator', label: 'PR Ready', icon: '🚀' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  return (
    <div style={{ padding: '0 8px 8px 8px' }}>
      {/* Header */}
      <div style={{ padding: '12px 4px 8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '16px' }}>✈️</span>
        <span style={{ fontWeight: 700, fontSize: '13px', letterSpacing: '0.3px' }}>
          Pre-Flight Controller
        </span>
      </div>

      {/* Tab Bar */}
      <div className="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'dashboard' && (
        <Dashboard
          dockerStatus={dockerStatus}
          provider={provider}
          readiness={readiness}
          postMessage={postMessage}
        />
      )}
      {activeTab === 'reviewer' && (
        <ReviewPanel findings={findings} postMessage={postMessage} />
      )}
      {activeTab === 'tests' && (
        <TestPanel tests={tests} testOutput={testOutput} postMessage={postMessage} />
      )}
      {activeTab === 'visual' && (
        <VisualQAPanel result={visualResult} postMessage={postMessage} dockerStatus={dockerStatus} />
      )}
      {activeTab === 'automator' && (
        <PRAutomatorPanel status={pipelineStatus} postMessage={postMessage} />
      )}
      {activeTab === 'settings' && (
        <SettingsPanel
          provider={provider}
          connectionResult={connectionResult}
          postMessage={postMessage}
        />
      )}
    </div>
  );
};

export default App;
