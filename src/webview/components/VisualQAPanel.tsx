import React, { useState } from 'react';
import DiffViewer from './DiffViewer';

interface Props {
  result: {
    diffBase64: string;
    localBase64: string;
    productionBase64: string;
    deltaPercent: number;
    pixelsChanged: number;
    totalPixels: number;
  } | null;
  postMessage: (msg: any) => void;
  dockerStatus: boolean;
}

const VisualQAPanel: React.FC<Props> = ({ result, postMessage, dockerStatus }) => {
  const [localUrl, setLocalUrl] = useState('http://localhost:3000');
  const [productionUrl, setProductionUrl] = useState('');

  const handleRun = () => {
    if (!localUrl || !productionUrl) { return; }
    postMessage({ command: 'runVisualCheck', localUrl, productionUrl });
  };

  return (
    <div>
      {!dockerStatus && (
        <div className="glass-card" style={{ borderColor: '#fb923c40' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#fb923c' }}>
            <span className="status-dot offline" />
            Docker is required for Visual QA. Start the sidecar stack first.
          </div>
          <button
            className="btn-secondary"
            style={{ marginTop: '8px', width: '100%' }}
            onClick={() => postMessage({ command: 'startDocker' })}
          >
            Start Docker Stack
          </button>
        </div>
      )}

      <div className="glass-card">
        <div style={{ marginBottom: '8px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7, display: 'block', marginBottom: '4px' }}>
            Local Dev URL
          </label>
          <input
            className="input"
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
            placeholder="http://localhost:3000"
          />
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7, display: 'block', marginBottom: '4px' }}>
            Production URL
          </label>
          <input
            className="input"
            value={productionUrl}
            onChange={(e) => setProductionUrl(e.target.value)}
            placeholder="https://example.com"
          />
        </div>
        <button
          className="btn-primary"
          onClick={handleRun}
          disabled={!dockerStatus || !localUrl || !productionUrl}
        >
          🖼️ Run Visual Check
        </button>
      </div>

      {result && (
        <>
          <div className="glass-card" style={{ padding: '8px 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
              <span>Pixels changed</span>
              <span style={{ fontWeight: 600 }}>
                {result.pixelsChanged.toLocaleString()} / {result.totalPixels.toLocaleString()}
              </span>
            </div>
          </div>
          <DiffViewer
            localBase64={result.localBase64}
            productionBase64={result.productionBase64}
            diffBase64={result.diffBase64}
            deltaPercent={result.deltaPercent}
          />
        </>
      )}

      {!result && dockerStatus && (
        <div className="glass-card" style={{ textAlign: 'center', opacity: 0.5, fontSize: '12px' }}>
          Enter URLs above and run a visual check to see the diff.
        </div>
      )}
    </div>
  );
};

export default VisualQAPanel;
