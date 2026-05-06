import React, { useState } from 'react';

interface Finding {
  file: string;
  line: number;
  endLine?: number;
  severity: 'error' | 'warning' | 'info';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  title: string;
  description: string;
  suggestion?: string;
}

interface ReviewStatus {
  kind: 'no-issues' | 'findings' | 'parse-failure' | 'runtime-error';
  summary: string;
  reviewedFile?: string;
  timestamp?: number;
  rawOutput?: string;
}

interface Props {
  findings: Finding[];
  reviewStatus: ReviewStatus | null;
  postMessage: (msg: any) => void;
}

const categoryIcons: Record<string, string> = {
  logic: '🧠',
  architecture: '🏗️',
  security: '🔒',
  performance: '⚡',
};

const severityColor: Record<string, string> = {
  error: '#f87171',
  warning: '#fb923c',
  info: '#60a5fa',
};

const confidenceColor: Record<string, string> = {
  HIGH: '#f87171',
  MEDIUM: '#fb923c',
  LOW: '#94a3b8',
};

function formatTime(ts?: number): string {
  if (!ts) { return ''; }
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function basename(p?: string): string {
  if (!p) { return ''; }
  return p.split(/[\\/]/).pop() || p;
}

const FindingCard: React.FC<{
  finding: Finding;
  index: number;
  onReveal: (line: number) => void;
}> = ({ finding, index, onReveal }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        marginBottom: '6px',
        borderRadius: '6px',
        border: `1px solid ${severityColor[finding.severity]}33`,
        background: `${severityColor[finding.severity]}08`,
        overflow: 'hidden',
      }}
    >
      {/* Header row — always visible */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '7px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ fontSize: '13px', flexShrink: 0 }}>{categoryIcons[finding.category] || '📋'}</span>
        <span style={{ fontWeight: 600, fontSize: '11px', flex: 1, lineHeight: 1.3 }}>{finding.title}</span>
        <span style={{
          fontSize: '9px',
          fontWeight: 700,
          color: confidenceColor[finding.confidence],
          border: `1px solid ${confidenceColor[finding.confidence]}55`,
          borderRadius: '3px',
          padding: '1px 5px',
          flexShrink: 0,
        }}>
          {finding.confidence}
        </span>
        <span style={{ fontSize: '9px', opacity: 0.45, flexShrink: 0 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: '0 10px 10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {/* Meta row */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
            <span style={{
              fontSize: '9px',
              color: severityColor[finding.severity],
              border: `1px solid ${severityColor[finding.severity]}44`,
              borderRadius: '3px',
              padding: '1px 5px',
            }}>
              {finding.severity.toUpperCase()}
            </span>
            <span style={{ fontSize: '9px', opacity: 0.5 }}>
              {finding.category} · line {finding.line}{finding.endLine && finding.endLine !== finding.line ? `–${finding.endLine}` : ''}
            </span>
            <button
              style={{
                fontSize: '9px',
                padding: '1px 6px',
                marginLeft: 'auto',
                background: 'rgba(124,58,237,0.15)',
                border: '1px solid rgba(124,58,237,0.3)',
                borderRadius: '3px',
                color: '#a78bfa',
                cursor: 'pointer',
              }}
              onClick={(e) => { e.stopPropagation(); onReveal(finding.line); }}
            >
              ↗ Go to line {finding.line}
            </button>
          </div>

          {/* Description */}
          <div style={{ fontSize: '11px', lineHeight: 1.5, opacity: 0.85, marginBottom: finding.suggestion ? '8px' : 0 }}>
            {finding.description}
          </div>

          {/* Suggestion */}
          {finding.suggestion && (
            <div style={{
              marginTop: '4px',
              padding: '6px 8px',
              background: 'rgba(74,222,128,0.07)',
              border: '1px solid rgba(74,222,128,0.2)',
              borderRadius: '5px',
              fontSize: '10px',
              lineHeight: 1.5,
              color: '#86efac',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              <span style={{ fontWeight: 700, display: 'block', marginBottom: '3px' }}>💡 Suggested fix</span>
              {finding.suggestion}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ReviewPanel: React.FC<Props> = ({ findings, reviewStatus, postMessage }) => {
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  const isReviewing = reviewStatus?.kind === 'no-issues' && reviewStatus?.summary?.endsWith('…');

  const handleRunReview = () => {
    postMessage({ command: 'runReview' });
  };

  const handleClear = () => {
    postMessage({ command: 'clearReview' });
  };

  const handleRevealLine = (line: number) => {
    postMessage({ command: 'revealLine', line });
  };

  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warningCount = findings.filter(f => f.severity === 'warning').length;
  const infoCount = findings.filter(f => f.severity === 'info').length;

  const filtered = findings.filter(f => {
    if (filterSeverity !== 'all' && f.severity !== filterSeverity) { return false; }
    if (filterCategory !== 'all' && f.category !== filterCategory) { return false; }
    return true;
  });

  const categories = Array.from(new Set(findings.map(f => f.category)));

  return (
    <div>
      {/* Action row */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        <button
          className="btn-primary"
          onClick={handleRunReview}
          disabled={isReviewing}
          style={{ flex: 1 }}
        >
          {isReviewing ? '⏳ Reviewing…' : '🔍 Run Deep Review'}
        </button>
        {(findings.length > 0 || reviewStatus) && (
          <button
            className="btn-secondary"
            onClick={handleClear}
            style={{ fontSize: '10px', padding: '4px 8px' }}
            title="Clear results"
          >
            ✕ Clear
          </button>
        )}
      </div>

      {/* Status banner */}
      {reviewStatus && !isReviewing && (
        <div style={{
          marginBottom: '8px',
          padding: '7px 10px',
          borderRadius: '6px',
          border: reviewStatus.kind === 'findings'
            ? '1px solid rgba(251,146,60,0.35)'
            : reviewStatus.kind === 'no-issues'
              ? '1px solid rgba(74,222,128,0.35)'
              : '1px solid rgba(248,113,113,0.35)',
          background: reviewStatus.kind === 'findings'
            ? 'rgba(251,146,60,0.07)'
            : reviewStatus.kind === 'no-issues'
              ? 'rgba(74,222,128,0.07)'
              : 'rgba(248,113,113,0.07)',
          fontSize: '11px',
          lineHeight: 1.4,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{reviewStatus.summary}</span>
            {reviewStatus.timestamp && (
              <span style={{ fontSize: '9px', opacity: 0.45, flexShrink: 0, marginLeft: '8px' }}>
                {formatTime(reviewStatus.timestamp)}
              </span>
            )}
          </div>
          {reviewStatus.reviewedFile && (
            <div style={{ fontSize: '9px', opacity: 0.5, marginTop: '3px' }}>
              {basename(reviewStatus.reviewedFile)}
            </div>
          )}

          {/* Parse-failure detail */}
          {reviewStatus.kind === 'parse-failure' && (
            <details style={{ marginTop: '6px' }}>
              <summary style={{ fontSize: '9px', opacity: 0.6, cursor: 'pointer' }}>
                Show raw model output
              </summary>
              <pre style={{
                marginTop: '6px',
                padding: '6px',
                background: 'rgba(0,0,0,0.3)',
                borderRadius: '4px',
                fontSize: '9px',
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '120px',
                overflowY: 'auto',
                opacity: 0.7,
              }}>
                {reviewStatus.rawOutput || '(empty)'}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Summary counts + filters */}
      {findings.length > 0 && (
        <div className="glass-card" style={{ padding: '8px 10px', marginBottom: '8px' }}>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '11px', alignItems: 'center', marginBottom: '8px' }}>
            {errorCount > 0 && (
              <span style={{ color: '#f87171', fontWeight: 600 }}>
                ❌ {errorCount} error{errorCount > 1 ? 's' : ''}
              </span>
            )}
            {warningCount > 0 && (
              <span style={{ color: '#fb923c', fontWeight: 600 }}>
                ⚠️ {warningCount} warning{warningCount > 1 ? 's' : ''}
              </span>
            )}
            {infoCount > 0 && (
              <span style={{ color: '#60a5fa', fontWeight: 600 }}>
                ℹ️ {infoCount} info
              </span>
            )}
          </div>

          {/* Filter row */}
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {(['all', 'error', 'warning', 'info'] as const).map(s => (
              <button
                key={s}
                onClick={() => setFilterSeverity(s)}
                style={{
                  fontSize: '9px',
                  padding: '2px 7px',
                  borderRadius: '10px',
                  border: filterSeverity === s
                    ? '1px solid rgba(124,58,237,0.7)'
                    : '1px solid rgba(255,255,255,0.12)',
                  background: filterSeverity === s ? 'rgba(124,58,237,0.2)' : 'transparent',
                  color: filterSeverity === s ? '#c4b5fd' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
            {categories.length > 1 && (
              <>
                <span style={{ fontSize: '9px', opacity: 0.3, alignSelf: 'center' }}>|</span>
                {(['all', ...categories] as string[]).map(c => (
                  <button
                    key={c}
                    onClick={() => setFilterCategory(c)}
                    style={{
                      fontSize: '9px',
                      padding: '2px 7px',
                      borderRadius: '10px',
                      border: filterCategory === c
                        ? '1px solid rgba(124,58,237,0.7)'
                        : '1px solid rgba(255,255,255,0.12)',
                      background: filterCategory === c ? 'rgba(124,58,237,0.2)' : 'transparent',
                      color: filterCategory === c ? '#c4b5fd' : 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {c === 'all' ? 'All' : `${categoryIcons[c] || ''} ${c}`}
                  </button>
                ))}
              </>
            )}
          </div>

          {filtered.length !== findings.length && (
            <div style={{ fontSize: '9px', opacity: 0.4, marginTop: '5px' }}>
              Showing {filtered.length} of {findings.length} findings
            </div>
          )}
        </div>
      )}

      {/* Empty state — before any review */}
      {!reviewStatus && findings.length === 0 && (
        <div className="glass-card" style={{ textAlign: 'center', padding: '20px 12px', opacity: 0.55, fontSize: '12px', lineHeight: 1.6 }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>🔍</div>
          Click <strong>Run Deep Review</strong> to analyze the active file.
          <div style={{ fontSize: '10px', marginTop: '6px', opacity: 0.7 }}>
            Findings include severity, confidence, category, and suggested fixes.
          </div>
        </div>
      )}

      {/* Findings list */}
      {filtered.map((finding, idx) => (
        <FindingCard
          key={`${finding.line}-${finding.title}-${idx}`}
          finding={finding}
          index={idx}
          onReveal={handleRevealLine}
        />
      ))}
    </div>
  );
};

export default ReviewPanel;
