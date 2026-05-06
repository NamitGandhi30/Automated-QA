import React from 'react';

interface Finding {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  title: string;
  description: string;
  suggestion?: string;
}

interface Props {
  findings: Finding[];
  postMessage: (msg: any) => void;
}

const ReviewPanel: React.FC<Props> = ({ findings, postMessage }) => {
  const handleRunReview = () => {
    postMessage({ command: 'runReview' });
  };

  const handleRevealLine = (line: number) => {
    postMessage({ command: 'revealLine', line });
  };

  const categoryIcons: Record<string, string> = {
    logic: '🧠',
    architecture: '🏗️',
    security: '🔒',
    performance: '⚡',
  };

  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warningCount = findings.filter(f => f.severity === 'warning').length;
  const infoCount = findings.filter(f => f.severity === 'info').length;

  return (
    <div>
      <button className="btn-primary" onClick={handleRunReview} style={{ marginBottom: '12px' }}>
        🔍 Run Deep Review
      </button>

      {findings.length > 0 && (
        <div className="glass-card" style={{ padding: '8px 12px' }}>
          <div style={{ display: 'flex', gap: '12px', fontSize: '11px' }}>
            {errorCount > 0 && <span style={{ color: '#f87171' }}>❌ {errorCount} errors</span>}
            {warningCount > 0 && <span style={{ color: '#fb923c' }}>⚠️ {warningCount} warnings</span>}
            {infoCount > 0 && <span style={{ color: '#60a5fa' }}>ℹ️ {infoCount} info</span>}
          </div>
        </div>
      )}

      {findings.length === 0 && (
        <div className="glass-card" style={{ textAlign: 'center', opacity: 0.5, fontSize: '12px' }}>
          No findings yet. Click "Run Deep Review" to analyze the active file.
        </div>
      )}

      {findings.map((finding, idx) => (
        <div
          key={idx}
          className={`finding-item severity-${finding.severity}`}
          onClick={() => handleRevealLine(finding.line)}
          style={{ marginBottom: '4px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>{categoryIcons[finding.category] || '📋'}</span>
              <span style={{ fontWeight: 600, fontSize: '12px' }}>{finding.title}</span>
            </div>
            <span className={`badge badge-${finding.confidence.toLowerCase()}`}>
              {finding.confidence}
            </span>
          </div>
          <div style={{ fontSize: '11px', opacity: 0.8, marginBottom: '4px', lineHeight: 1.4 }}>
            {finding.description}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', opacity: 0.5 }}>Line {finding.line}</span>
            {finding.suggestion && (
              <span style={{ fontSize: '10px', color: '#4ade80', cursor: 'help' }} title={finding.suggestion}>
                💡 Fix available
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ReviewPanel;
