import React from 'react';

interface PipelineStatus {
  stage: string;
  progress: number;
  message: string;
  commitMessage?: string;
  error?: string;
}

interface Props {
  status: PipelineStatus;
  postMessage: (msg: any) => void;
}

const stages = [
  { key: 'reviewing', label: 'Semantic Review', icon: '🔍' },
  { key: 'generating-tests', label: 'Generate Tests', icon: '🧪' },
  { key: 'running-tests', label: 'Run Stress Tests', icon: '▶️' },
  { key: 'visual-check', label: 'Visual QA Check', icon: '🖼️' },
  { key: 'commit-message', label: 'Commit Message', icon: '💬' },
];

const PRAutomatorPanel: React.FC<Props> = ({ status, postMessage }) => {
  const handleReady = () => {
    postMessage({ command: 'readyForPR' });
  };

  const getStageStatus = (stageKey: string) => {
    const stageOrder = stages.map(s => s.key);
    const currentIdx = stageOrder.indexOf(status.stage);
    const thisIdx = stageOrder.indexOf(stageKey);

    if (status.stage === 'done') { return 'done'; }
    if (status.stage === 'error') { return thisIdx <= currentIdx ? 'error' : 'pending'; }
    if (thisIdx < currentIdx) { return 'done'; }
    if (thisIdx === currentIdx) { return 'active'; }
    return 'pending';
  };

  const isRunning = !['idle', 'done', 'error'].includes(status.stage);

  return (
    <div>
      <button
        className="btn-primary"
        onClick={handleReady}
        disabled={isRunning}
        style={{ marginBottom: '16px', fontSize: '14px', padding: '14px 16px' }}
      >
        {isRunning ? '⏳ Running...' : '🚀 Ready for PR'}
      </button>

      {/* Progress */}
      {(isRunning || status.stage === 'done' || status.stage === 'error') && (
        <div className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
              Pipeline Progress
            </span>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#a78bfa' }}>
              {status.progress}%
            </span>
          </div>
          <div className="progress-container" style={{ marginBottom: '12px' }}>
            <div className="progress-bar" style={{
              width: `${status.progress}%`,
              background: status.stage === 'error'
                ? 'linear-gradient(90deg, #ef4444, #f87171)'
                : undefined,
            }} />
          </div>

          {/* Steps */}
          {stages.map((stage) => {
            const stageStatus = getStageStatus(stage.key);
            return (
              <div key={stage.key} className={`pipeline-step ${stageStatus}`}>
                <div className={`step-icon ${stageStatus}`}>
                  {stageStatus === 'done' ? '✓' :
                   stageStatus === 'active' ? '•' :
                   stageStatus === 'error' ? '✕' : '○'}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', fontWeight: 600 }}>
                    {stage.icon} {stage.label}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Status message */}
      {status.message && status.stage !== 'idle' && (
        <div className="glass-card" style={{ fontSize: '11px', opacity: 0.8 }}>
          {status.message}
        </div>
      )}

      {/* Commit message */}
      {status.commitMessage && (
        <div className="glass-card">
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
            Semantic Commit Message
          </div>
          <div
            className="code-block"
            style={{ cursor: 'pointer', position: 'relative' }}
            onClick={() => {
              navigator.clipboard?.writeText(status.commitMessage || '');
            }}
            title="Click to copy"
          >
            {status.commitMessage}
            <span style={{ position: 'absolute', top: 4, right: 6, fontSize: '10px', opacity: 0.5 }}>
              📋 Click to copy
            </span>
          </div>
        </div>
      )}

      {/* Error */}
      {status.error && (
        <div className="glass-card" style={{ borderColor: '#f8717140' }}>
          <div style={{ fontSize: '11px', color: '#f87171' }}>
            ❌ {status.error}
          </div>
        </div>
      )}

      {status.stage === 'idle' && (
        <div className="glass-card" style={{ textAlign: 'center', opacity: 0.5, fontSize: '12px' }}>
          Click "Ready for PR" to run the full pre-flight pipeline:
          <div style={{ marginTop: '6px', fontSize: '11px', lineHeight: '1.6' }}>
            Review → Tests → Stress → Visual QA → Commit Message
          </div>
        </div>
      )}
    </div>
  );
};

export default PRAutomatorPanel;
