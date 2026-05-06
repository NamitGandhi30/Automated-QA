import React, { useRef, useState, useCallback, useEffect } from 'react';

interface Props {
  localBase64: string;
  productionBase64: string;
  diffBase64: string;
  deltaPercent: number;
}

const DiffViewer: React.FC<Props> = ({ localBase64, productionBase64, diffBase64, deltaPercent }) => {
  const [mode, setMode] = useState<'slider' | 'overlay'>('slider');
  const [sliderPos, setSliderPos] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) { return; }
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    setSliderPos((x / rect.width) * 100);
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { setSliderPos(p => Math.max(0, p - 2)); }
    if (e.key === 'ArrowRight') { setSliderPos(p => Math.min(100, p + 2)); }
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const localSrc = `data:image/png;base64,${localBase64}`;
  const prodSrc = `data:image/png;base64,${productionBase64}`;
  const diffSrc = `data:image/png;base64,${diffBase64}`;

  return (
    <div>
      {/* Mode Toggle */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center' }}>
        <button
          className={`btn-secondary ${mode === 'slider' ? 'active' : ''}`}
          onClick={() => setMode('slider')}
          style={{ flex: 1, borderColor: mode === 'slider' ? '#7c3aed' : undefined }}
        >
          ↔️ Slider
        </button>
        <button
          className={`btn-secondary ${mode === 'overlay' ? 'active' : ''}`}
          onClick={() => setMode('overlay')}
          style={{ flex: 1, borderColor: mode === 'overlay' ? '#7c3aed' : undefined }}
        >
          🔴 Diff Overlay
        </button>
        <span className={`badge ${deltaPercent > 5 ? 'badge-high' : deltaPercent > 0 ? 'badge-medium' : 'badge-success'}`}>
          {deltaPercent.toFixed(2)}%
        </span>
      </div>

      {/* Viewer */}
      {mode === 'slider' ? (
        <div
          ref={containerRef}
          className="diff-slider-container"
          style={{ height: '300px' }}
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {/* Production (full width, behind) */}
          <img
            src={prodSrc}
            alt="Production"
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain',
            }}
          />
          {/* Local (clipped) */}
          <div style={{
            position: 'absolute', top: 0, left: 0, width: `${sliderPos}%`, height: '100%', overflow: 'hidden',
          }}>
            <img
              src={localSrc}
              alt="Local"
              style={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain',
              }}
              draggable={false}
            />
          </div>
          {/* Slider handle */}
          <div
            className="diff-slider-handle"
            style={{ left: `${sliderPos}%` }}
            onMouseDown={handleMouseDown}
          />
          {/* Labels */}
          <div style={{
            position: 'absolute', bottom: 6, left: 8, fontSize: '10px', background: '#00000080', padding: '2px 6px', borderRadius: '3px', color: '#fff',
          }}>
            Local Dev
          </div>
          <div style={{
            position: 'absolute', bottom: 6, right: 8, fontSize: '10px', background: '#00000080', padding: '2px 6px', borderRadius: '3px', color: '#fff',
          }}>
            Production
          </div>
        </div>
      ) : (
        <div className="diff-slider-container" style={{ height: '300px' }}>
          <img
            src={diffSrc}
            alt="Pixel Diff"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, fontSize: '10px', background: '#00000080', padding: '2px 6px', borderRadius: '3px', color: '#fff',
          }}>
            🔴 Changed Pixels
          </div>
        </div>
      )}
    </div>
  );
};

export default DiffViewer;
