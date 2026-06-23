import React, { useState } from 'react';

interface Finding {
  severity: 'low' | 'medium' | 'high';
  title: string;
  plainExplanation: string;
  likelyRealBug: boolean;
  suggestedFix?: string;
}

interface Explanation {
  verdict: 'all-green' | 'found-issues' | 'cant-run';
  plainSummary: string;
  whatWeTested: string[];
  findings: Finding[];
  recommendation: string;
}

interface Props {
  tests: {
    filePath: string;
    sourceFilePath?: string;
    language?: string;
    framework: string;
    workspaceRoot?: string;
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
  explanation: Explanation | null;
  postMessage: (msg: any) => void;
}

const VERDICT = {
  'all-green': { label: 'All tests passed', cls: 'badge-success', icon: '✅' },
  'found-issues': { label: 'Found possible issues', cls: 'badge-high', icon: '⚠️' },
  'cant-run': { label: 'Could not run', cls: 'badge-medium', icon: '🛠️' },
} as const;

const SEVERITY_CLS: Record<string, string> = {
  high: 'badge-high',
  medium: 'badge-medium',
  low: 'badge-success',
};

const TestPanel: React.FC<Props> = ({ tests, testOutput, explanation, postMessage }) => {
  const [openTier, setOpenTier] = useState<string | null>('normal');

  const runResult = typeof testOutput === 'string'
    ? (testOutput ? {
      status: 'running' as const, command: '', cwd: '', exitCode: null,
      output: testOutput, framework: tests?.framework || '', testFilePath: tests?.filePath || '',
    } : null)
    : testOutput;

  const handleGenerate = () => postMessage({ command: 'generateTests' });
  const handleRun = () => postMessage({ command: 'runTests' });
  const handleSave = () => postMessage({ command: 'saveTests' });

  const tiers = [
    { id: 'normal', label: 'Tier 1: Normal (Happy Path)', icon: '✅', content: tests?.normal },
    { id: 'edgeCase', label: 'Tier 2: Edge Case', icon: '🔲', content: tests?.edgeCase },
    { id: 'stress', label: 'Tier 3: Stress Test', icon: '🔥', content: tests?.stress },
  ];

  const verdict = explanation ? VERDICT[explanation.verdict] : null;
  const canSave = tests && runResult && runResult.status !== 'running';

  return (
    <div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
        <button className="btn-primary" onClick={handleGenerate} style={{ flex: 2 }}>
          🧪 Generate &amp; Run
        </button>
        {tests && (
          <button className="btn-secondary" onClick={handleRun} style={{ flex: 1 }}>
            ▶️ Re-run
          </button>
        )}
      </div>

      {!tests && (
        <div className="glass-card" style={{ textAlign: 'center', opacity: 0.6, fontSize: '12px' }}>
          Open any source file (TypeScript, JavaScript, Python, Go, Rust, Java, C, C++) and click
          “Generate &amp; Run”. Tests are generated, run in a sandbox, and explained in plain language —
          nothing is written to your project unless you click Save.
        </div>
      )}

      {tests && (
        <>
          <div className="glass-card" style={{ padding: '8px 12px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <div>
                <div style={{ fontSize: '10px', opacity: 0.5 }}>Language</div>
                <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'capitalize' }}>
                  {tests.language || 'unknown'} · {tests.framework}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '10px', opacity: 0.5 }}>Test file (ephemeral)</div>
                <div style={{ fontSize: '11px', wordBreak: 'break-all' }}>
                  {tests.filePath.split(/[/\\]/).pop()}
                </div>
              </div>
            </div>
          </div>

          {/* ── Plain-language report ─────────────────────────────── */}
          {verdict && explanation && (
            <div className="glass-card" style={{ padding: '10px 12px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span className={`badge ${verdict.cls}`}>{verdict.icon} {verdict.label}</span>
              </div>
              <div style={{ fontSize: '12px', lineHeight: 1.5, marginBottom: explanation.whatWeTested?.length ? '8px' : 0 }}>
                {explanation.plainSummary}
              </div>

              {explanation.whatWeTested?.length > 0 && (
                <div style={{ marginBottom: '8px' }}>
                  <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                    What we tested
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {explanation.whatWeTested.map((w, i) => (
                      <span key={i} className="badge badge-medium" style={{ fontSize: '10px' }}>{w}</span>
                    ))}
                  </div>
                </div>
              )}

              {explanation.findings?.length > 0 && (
                <div style={{ display: 'grid', gap: '8px', marginBottom: '8px' }}>
                  {explanation.findings.map((f, i) => (
                    <div key={i} style={{
                      borderLeft: '3px solid var(--vscode-panel-border)',
                      paddingLeft: '8px',
                    }}>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '3px' }}>
                        <span className={`badge ${SEVERITY_CLS[f.severity] || 'badge-medium'}`} style={{ fontSize: '9px' }}>
                          {f.severity}
                        </span>
                        {f.likelyRealBug && (
                          <span className="badge badge-high" style={{ fontSize: '9px' }}>🐞 likely a real bug in your code</span>
                        )}
                        <span style={{ fontSize: '12px', fontWeight: 600 }}>{f.title}</span>
                      </div>
                      <div style={{ fontSize: '11px', lineHeight: 1.45, opacity: 0.9 }}>{f.plainExplanation}</div>
                      {f.suggestedFix && (
                        <div style={{ fontSize: '11px', marginTop: '3px', opacity: 0.8 }}>
                          <strong>Suggested fix:</strong> {f.suggestedFix}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {explanation.recommendation && (
                <div style={{ fontSize: '11px', fontStyle: 'italic', opacity: 0.85 }}>
                  👉 {explanation.recommendation}
                </div>
              )}
            </div>
          )}

          {canSave && (
            <button className="btn-secondary" onClick={handleSave} style={{ width: '100%', marginBottom: '10px' }}>
              💾 Save tests to project
            </button>
          )}

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
            Test Run {runResult.status === 'running' && '· running…'}
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
              Running tests in the sandbox…
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TestPanel;
