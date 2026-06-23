import React, { useState, useEffect, useMemo, useRef } from 'react';

interface GraphNode {
  id: string;
  label: string;
  type: 'main' | 'file' | 'lib';
  language?: string;
  isMain: boolean;
  imports: string[];
  missingDeps: string[];
}

interface GraphEdge {
  source: string;
  target: string;
  type: 'import' | 'dependency';
}

interface CodebaseGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mainFiles: string[];
  externalLibs: string[];
}

interface Props {
  graph: CodebaseGraph | null;
  postMessage: (msg: any) => void;
}

interface NodePos {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const CodebaseGraphPanel: React.FC<Props> = ({ graph, postMessage }) => {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const width = 450;
  const height = 380;

  // 1. Parse nodes and edges
  const nodes = useMemo(() => graph?.nodes || [], [graph]);
  const edges = useMemo(() => graph?.edges || [], [graph]);

  // Find all missing packages across all nodes
  const allMissingDeps = useMemo(() => {
    const set = new Set<string>();
    nodes.forEach(n => {
      n.missingDeps.forEach(d => set.add(d));
    });
    return Array.from(set);
  }, [nodes]);

  // 2. Perform layout when graph is received
  useEffect(() => {
    if (nodes.length === 0) return;

    const pos: Record<string, NodePos> = {};
    nodes.forEach((node, idx) => {
      const angle = (idx / nodes.length) * 2 * Math.PI;
      const r = 110 + Math.random() * 20;
      pos[node.id] = {
        x: width / 2 + r * Math.cos(angle),
        y: height / 2 + r * Math.sin(angle),
        vx: 0,
        vy: 0,
      };
    });

    const kRepulse = 700;
    const kAttract = 0.04;
    const centerPull = 0.01;

    for (let step = 0; step < 150; step++) {
      // Repulse nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const idA = nodes[i].id;
          const idB = nodes[j].id;
          const nA = pos[idA];
          const nB = pos[idB];
          if (!nA || !nB) continue;

          const dx = nB.x - nA.x;
          const dy = nB.y - nA.y;
          const distSq = dx * dx + dy * dy + 0.1;
          const dist = Math.sqrt(distSq);
          if (dist < 400) {
            const force = kRepulse / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            nA.vx -= fx;
            nA.vy -= fy;
            nB.vx += fx;
            nB.vy += fy;
          }
        }
      }

      // Attract connected nodes along edges
      edges.forEach(edge => {
        const nA = pos[edge.source];
        const nB = pos[edge.target];
        if (!nA || !nB) return;

        const dx = nB.x - nA.x;
        const dy = nB.y - nA.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = kAttract * (dist - 80); // 80 is natural spring distance
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nA.vx += fx;
        nA.vy += fy;
        nB.vx -= fx;
        nB.vy -= fy;
      });

      // Gravity and dampening
      nodes.forEach(node => {
        const n = pos[node.id];
        if (!n) return;

        const dx = width / 2 - n.x;
        const dy = height / 2 - n.y;
        n.vx += dx * centerPull;
        n.vy += dy * centerPull;

        n.x += n.vx;
        n.y += n.vy;
        n.vx *= 0.75;
        n.vy *= 0.75;

        // Keep in bounds
        n.x = Math.max(30, Math.min(width - 30, n.x));
        n.y = Math.max(30, Math.min(height - 30, n.y));
      });
    }

    // Set stable coordinate state
    const finalCoords: Record<string, { x: number; y: number }> = {};
    nodes.forEach(node => {
      if (pos[node.id]) {
        finalCoords[node.id] = { x: pos[node.id].x, y: pos[node.id].y };
      }
    });
    setPositions(finalCoords);
  }, [nodes, edges]);

  // 3. Handle node dragging
  const handleMouseDown = (nodeId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setDraggedNode(nodeId);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggedNode || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.max(20, Math.min(width - 20, e.clientX - rect.left));
    const y = Math.max(20, Math.min(height - 20, e.clientY - rect.top));
    setPositions(prev => ({
      ...prev,
      [draggedNode]: { x, y },
    }));
  };

  const handleMouseUp = () => {
    setDraggedNode(null);
  };

  // Determine node highlighting
  const connectedNodes = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const set = new Set<string>([hoveredNode]);
    edges.forEach(edge => {
      if (edge.source === hoveredNode) set.add(edge.target);
      if (edge.target === hoveredNode) set.add(edge.source);
    });
    return set;
  }, [hoveredNode, edges]);

  const isHighlighted = (nodeId: string) => {
    if (!hoveredNode) return true;
    return connectedNodes.has(nodeId);
  };

  const isEdgeHighlighted = (edge: GraphEdge) => {
    if (!hoveredNode) return true;
    return edge.source === hoveredNode || edge.target === hoveredNode;
  };

  const getFramework = () => {
    return nodes.some(n => n.id.endsWith('.py')) ? 'pytest' : 'jest';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div className="glass-card">
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', opacity: 0.7, marginBottom: '6px' }}>
          Codebase Map
        </div>
        <div style={{ fontSize: '11px', opacity: 0.8, lineHeight: '1.4' }}>
          Dynamic import & dependency visualizer. Drag nodes to explore relationships. Missing packages are highlighted in <span style={{ color: '#ef4444', fontWeight: 600 }}>Red</span>.
        </div>
        <button 
          className="btn-secondary" 
          style={{ marginTop: '8px', fontSize: '10px', padding: '4px 8px' }}
          onClick={() => postMessage({ command: 'getCodebaseGraph' })}
        >
          🔄 Refresh Map
        </button>
      </div>

      {/* SVG Canvas */}
      <div 
        style={{ 
          border: '1px solid var(--vscode-panel-border)', 
          borderRadius: '6px', 
          background: 'rgba(0,0,0,0.15)', 
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <svg
          ref={svgRef}
          width={width}
          height={height}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: draggedNode ? 'grabbing' : 'default' }}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--vscode-descriptionForeground)" opacity="0.6" />
            </marker>
          </defs>

          {/* Draw Edges */}
          {edges.map((edge, idx) => {
            const from = positions[edge.source];
            const to = positions[edge.target];
            if (!from || !to) return null;

            const isLit = isEdgeHighlighted(edge);
            return (
              <line
                key={`edge-${idx}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={edge.type === 'dependency' ? 'var(--vscode-textSeparator-foreground)' : 'var(--vscode-descriptionForeground)'}
                strokeWidth={isLit ? 1.5 : 0.5}
                strokeDasharray={edge.type === 'dependency' ? '4,4' : undefined}
                opacity={isLit ? 0.75 : 0.15}
                markerEnd="url(#arrow)"
                style={{ transition: 'stroke-width 0.2s, opacity 0.2s' }}
              />
            );
          })}

          {/* Draw Nodes */}
          {nodes.map(node => {
            const pos = positions[node.id];
            if (!pos) return null;

            const isLit = isHighlighted(node.id);
            const isMissing = node.missingDeps.length > 0;
            
            // Choose node color
            let bgColor = 'var(--vscode-button-secondaryBackground)';
            let strokeColor = 'var(--vscode-panel-border)';
            let textColor = 'var(--vscode-button-secondaryForeground)';

            if (node.type === 'main') {
              bgColor = '#5b21b6';
              strokeColor = '#a78bfa';
              textColor = '#ffffff';
            } else if (node.type === 'lib') {
              if (isMissing) {
                bgColor = '#991b1b';
                strokeColor = '#f87171';
                textColor = '#ffffff';
              } else {
                bgColor = '#1e293b';
                strokeColor = '#475569';
                textColor = '#cbd5e1';
              }
            }

            return (
              <g
                key={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                onMouseDown={handleMouseDown(node.id)}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                style={{ cursor: 'grab', opacity: isLit ? 1 : 0.2, transition: 'opacity 0.2s' }}
              >
                {/* Node Box */}
                <rect
                  x={-55}
                  y={-14}
                  width={110}
                  height={28}
                  rx={6}
                  fill={bgColor}
                  stroke={strokeColor}
                  strokeWidth={hoveredNode === node.id ? 2 : 1}
                  style={{ transition: 'stroke-width 0.1s' }}
                />
                
                {/* Star icon for Main files */}
                {node.type === 'main' && (
                  <text x={-48} y={4} fontSize={11} fill="#fbbf24">⭐️</text>
                )}

                {/* Node Text */}
                <text
                  x={node.type === 'main' ? -32 : 0}
                  y={4}
                  textAnchor={node.type === 'main' ? 'start' : 'middle'}
                  fontSize={9}
                  fontWeight={node.type === 'main' || isMissing ? 'bold' : 'normal'}
                  fill={textColor}
                  style={{
                    userSelect: 'none',
                    pointerEvents: 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {node.label.length > 17 ? node.label.substring(0, 15) + '..' : node.label}
                </text>

                {/* Missing warning dot badge */}
                {isMissing && (
                  <circle cx={50} cy={-10} r={4} fill="#ef4444" stroke="#ffffff" strokeWidth={1} />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend & Details */}
      <div className="glass-card" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '9px', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', background: '#5b21b6', borderRadius: '2px', border: '1px solid #a78bfa' }} />
          <span>Entry Point (⭐️)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', background: 'var(--vscode-button-secondaryBackground)', borderRadius: '2px', border: '1px solid var(--vscode-panel-border)' }} />
          <span>Workspace File</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', background: '#1e293b', borderRadius: '2px', border: '1px solid #475569' }} />
          <span>Library Package</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', background: '#991b1b', borderRadius: '2px', border: '1px solid #f87171' }} />
          <span>Missing Dependency</span>
        </div>
      </div>

      {/* Missing dependencies list with installer */}
      {allMissingDeps.length > 0 && (
        <div className="glass-card" style={{ borderColor: 'rgba(239, 68, 68, 0.4)' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#f87171', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>⚠️</span>
            <span>Unresolved Workspace Dependencies</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {allMissingDeps.map(dep => (
              <div 
                key={dep} 
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between', 
                  padding: '4px 6px', 
                  background: 'rgba(239, 68, 68, 0.1)', 
                  borderRadius: '4px',
                  border: '1px solid rgba(239, 68, 68, 0.2)'
                }}
              >
                <span style={{ fontSize: '11px', fontFamily: 'monospace', fontWeight: 600, color: '#f87171' }}>{dep}</span>
                <button 
                  className="btn-primary" 
                  style={{ fontSize: '9px', padding: '2px 6px', background: '#991b1b', hover: { background: '#b91c1c' } } as any}
                  onClick={() => postMessage({
                    command: 'installDependency',
                    packageName: dep,
                    framework: getFramework(),
                  })}
                >
                  📥 Install in Sidecar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No missing deps banner */}
      {allMissingDeps.length === 0 && (
        <div className="glass-card" style={{ borderColor: 'rgba(34, 197, 94, 0.3)', background: 'rgba(34, 197, 94, 0.05)' }}>
          <div style={{ fontSize: '11px', color: '#4ade80', display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
            <span>✅</span>
            <span>All import dependencies resolved and package-ready!</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default CodebaseGraphPanel;
