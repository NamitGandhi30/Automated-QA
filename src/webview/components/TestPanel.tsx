import React, { useState } from 'react';

interface Props {
  tests: {
    filePath: string;
    sourceFilePath?: string;
    framework: string;
    workspaceRoot?: string;
    testConfigPath?: string;
    normal: string;
    edgeCase: string;
    stress: string;
  } | null;
  testOutput: {
    status: 'passed' | 'failed' | 'skipped' | 'error' | 'running';
    command: string;
    cwd: string;
    exitCode: number | null;
    output: string;
    framework: string;
    testFilePath: string;
    failureReason?: string;
    failureSummary?: string;
  } | string | null;
  postMessage: (msg: any) => void;
}

const TestPanel: React.FC<Props> = ({ tests, testOutput, postMessage }) => {
  const [openTier, setOpenTier] = useState<string | null>('normal');
  const runResult = typeof testOutput === 'string'
    ? (testOutput ? {
      status: 'running' as const,
      command: '',
      cwd: '',
      exitCode: null,
      output: testOutput,
      framework: tests?.framework || '',
      testFilePath: tests?.filePath || '',
    } : null)
    : testOutput;

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
            <div style={{ display: 'grid', gap: '4px', marginTop: '8px', fontSize: '10px', opacity: 0.75 }}>
              <div><strong>Root:</strong> {tests.workspaceRoot || 'Workspace root unavailable'}</div>
              <div><strong>Config:</strong> {tests.testConfigPath || 'Auto-detect from workspace root'}</div>
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

      {runResult && (
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
            Test Run
          </div>
          <div className="glass-card" style={{ padding: '8px 10px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
              <span className={`badge ${
                runResult.status === 'passed' ? 'badge-success' :
                runResult.status === 'failed' || runResult.status === 'error' ? 'badge-high' :
                'badge-medium'
              }`}>
                {runResult.status}
              </span>
              <span style={{ fontSize: '10px', opacity: 0.7 }}>
                Exit {runResult.exitCode ?? '-'}
              </span>
            </div>
            {runResult.failureReason && (
              <div style={{ fontSize: '11px', marginBottom: '6px', color: 'var(--vscode-errorForeground)' }}>
                {runResult.failureReason}
              </div>
            )}
            <div style={{ fontSize: '10px', opacity: 0.65, wordBreak: 'break-all' }}>
              <div><strong>CWD:</strong> {runResult.cwd || '-'}</div>
              <div><strong>Command:</strong> {runResult.command || (runResult.status === 'running' ? 'Starting...' : '-')}</div>
            </div>
            {runResult.failureSummary && (
              <div style={{ marginTop: '8px', borderTop: '1px dashed var(--vscode-panel-border)', paddingTop: '8px' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--vscode-errorForeground)', marginBottom: '4px' }}>
                  Failure Summary:
                </div>
                <div className="code-block" style={{ margin: 0, padding: '8px', fontSize: '11px', whiteSpace: 'pre-wrap', maxHeight: '300px', overflowY: 'auto' }}>
                  {runResult.failureSummary}
                </div>
              </div>
            )}
          </div>
          {runResult.status !== 'running' ? (
            <details style={{ marginTop: '8px' }}>
              <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', fontSize: '11px', fontWeight: 600, opacity: 0.8 }}>
                🔍 View Full Console Output
              </summary>
              <div className="code-block" style={{ maxHeight: '200px', overflowY: 'auto', marginTop: '6px' }}>
                {runResult.output || 'No output captured.'}
              </div>
            </details>
          ) : (
            <div className="code-block" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              Running test command...
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TestPanel;
