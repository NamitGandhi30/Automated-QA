import React from 'react';

interface Props {
  dockerStatus: boolean;
  provider: string;
  readiness: { percent: number; files: Record<string, any> };
  postMessage: (msg: any) => void;
}

const Dashboard: React.FC<Props> = ({ dockerStatus, provider, readiness, postMessage }) => {
  const fileEntries = Object.entries(readiness.files || {});

  return (
    <div>
      {/* System Health */}
      <div className="glass-card">
        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
          System Health
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span className={`status-dot ${dockerStatus ? 'online' : 'offline'}`} />
              <span style={{ fontSize: '12px' }}>Docker Sidecar</span>
            </div>
            {!dockerStatus && (
              <button className="btn-secondary" onClick={() => postMessage({ command: 'startDocker' })} style={{ fontSize: '10px' }}>
                Start
              </button>
            )}
            {dockerStatus && (
              <span className="badge badge-success">Running</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span className="status-dot online" />
              <span style={{ fontSize: '12px' }}>AI Provider</span>
            </div>
            <span className="badge badge-success" style={{ textTransform: 'capitalize' }}>
              {provider}
            </span>
          </div>
        </div>
      </div>

      {/* PR Readiness */}
      <div className="glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
            PR Readiness
          </span>
          <span style={{ fontSize: '20px', fontWeight: 700, color: '#a78bfa' }}>
            {readiness.percent}%
          </span>
        </div>
        <div className="progress-container">
          <div className="progress-bar" style={{ width: `${readiness.percent}%` }} />
        </div>

        {/* File breakdown */}
        {fileEntries.length > 0 && (
          <div style={{ marginTop: '10px', fontSize: '11px' }}>
            {fileEntries.map(([filepath, status]: [string, any]) => {
              const name = filepath.split(/[/\\]/).pop() || filepath;
              return (
                <div key={filepath} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 0', borderBottom: '1px solid var(--vscode-panel-border)' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filepath}>
                    {name}
                  </span>
                  <span style={{ opacity: status.reviewed ? 1 : 0.3 }}>🔍</span>
                  <span style={{ opacity: status.tested ? 1 : 0.3 }}>🧪</span>
                  <span style={{ opacity: status.visualChecked ? 1 : 0.3 }}>🖼️</span>
                </div>
              );
            })}
          </div>
        )}

        {fileEntries.length === 0 && (
          <div style={{ marginTop: '10px', fontSize: '11px', opacity: 0.5, textAlign: 'center' }}>
            No files checked yet. Run a review to get started.
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="glass-card">
        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7 }}>
          Quick Actions
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <button className="btn-primary" onClick={() => postMessage({ command: 'readyForPR' })}>
            🚀 Ready for PR
          </button>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => postMessage({ command: 'runReview' })}>
              🔍 Review
            </button>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => postMessage({ command: 'generateTests' })}>
              🧪 Tests
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
