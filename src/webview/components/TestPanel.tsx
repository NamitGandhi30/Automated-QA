import React, { useState } from 'react';

interface Props {
  tests: {
    filePath: string;
    framework: string;
    normal: string;
    edgeCase: string;
    stress: string;
  } | null;
  testOutput: string;
  postMessage: (msg: any) => void;
}

const TestPanel: React.FC<Props> = ({ tests, testOutput, postMessage }) => {
  const [openTier, setOpenTier] = useState<string | null>('normal');

  const handleGenerate = () => {
    postMessage({ command: 'generateTests' });
  };

  const handleRun = () => {
    postMessage({ command: 'runTests' });
  };

  const tiers = [
    { id: 'normal', label: 'Tier 1: Normal (Happy Path)', icon: '✅', content: tests?.normal },
    { id: 'edgeCase', label: 'Tier 2: Edge Case', icon: '🔲', content: tests?.edgeCase },
    { id: 'stress', label: 'Tier 3: Stress Test', icon: '🔥', content: tests?.stress },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
        <button className="btn-primary" onClick={handleGenerate} style={{ flex: 2 }}>
          🧪 Generate Tests
        </button>
        {tests && (
          <button className="btn-secondary" onClick={handleRun} style={{ flex: 1 }}>
            ▶️ Run
          </button>
        )}
      </div>

      {!tests && (
        <div className="glass-card" style={{ textAlign: 'center', opacity: 0.5, fontSize: '12px' }}>
          Select a function or class in the editor, then click "Generate Tests".
        </div>
      )}

      {tests && (
        <>
          <div className="glass-card" style={{ padding: '8px 12px', marginBottom: '8px' }}>
            <div style={{ fontSize: '10px', opacity: 0.5 }}>Framework</div>
            <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'capitalize' }}>
              {tests.framework}
            </div>
            <div style={{ fontSize: '10px', opacity: 0.5, marginTop: '4px', wordBreak: 'break-all' }}>
              {tests.filePath.split(/[/\\]/).pop()}
            </div>
          </div>

          {tiers.map((tier) => (
            <div key={tier.id} style={{ marginBottom: '6px' }}>
              <button
                className={`accordion-header ${openTier === tier.id ? 'open' : ''}`}
                onClick={() => setOpenTier(openTier === tier.id ? null : tier.id)}
              >
                <span>{tier.icon} {tier.label}</span>
                <span style={{ fontSize: '10px' }}>{openTier === tier.id ? '▼' : '▶'}</span>
              </button>
              <div className={`accordion-content ${openTier === tier.id ? 'open' : ''}`}>
                <div className="code-block">{tier.content || 'No tests in this tier.'}</div>
              </div>
            </div>
          ))}
        </>
      )}

      {testOutput && (
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
            Test Output
          </div>
          <div className="code-block" style={{ maxHeight: '200px', overflowY: 'auto' }}>
            {testOutput}
          </div>
        </div>
      )}
    </div>
  );
};

export default TestPanel;
