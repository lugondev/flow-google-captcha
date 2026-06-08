import { Handle, Position, useEdges, type NodeProps } from '@xyflow/react';
import { useWorkflowStore } from '../store/workflow';
import type { GenerateNodeData } from '../types';

const INPUT_HANDLES = Array.from({ length: 9 }, (_, i) => i);

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  running: '⟳ running',
  done: '✓ done',
  error: '✗ error',
};

export function GenerateNode({ id, data }: NodeProps) {
  const d = data as GenerateNodeData;
  const { updateNodeData, deleteNode, promoteOutput, runGeneration } = useWorkflowStore();
  const edges = useEdges();
  const connectedHandles = new Set(
    edges.filter(e => e.target === id).map(e => e.targetHandle),
  );

  return (
    <div className={`wf-node wf-gen-node wf-gen-${d.status}`}>
      {INPUT_HANDLES.map(i => (
        <Handle
          key={i}
          type="target"
          position={Position.Left}
          id={`in-${i}`}
          style={{ top: `${(i + 1) * 100 / 10}%` }}
          className={connectedHandles.has(`in-${i}`) ? 'wf-handle-active' : 'wf-handle-empty'}
        />
      ))}

      <div className="wf-node-header">
        <span className="wf-node-icon">✦</span>
        <span className="wf-node-title">Generate</span>
        <span className={`wf-badge wf-badge-${d.status}`}>{STATUS_LABEL[d.status]}</span>
        <button className="wf-node-del nodrag" onClick={() => deleteNode(id)}>×</button>
      </div>

      <textarea
        className="wf-prompt nodrag"
        placeholder="Nhập prompt…"
        value={d.prompt}
        onChange={e => updateNodeData(id, { prompt: e.target.value })}
        rows={3}
      />

      <div className="wf-gen-footer">
        {d.status === 'running' ? (
          <button
            className="wf-btn wf-btn-stop nodrag"
            onClick={() => {
              chrome.runtime.sendMessage({ type: 'CANCEL_GENERATE' });
              updateNodeData(id, { status: 'idle', progress: 'Đã dừng' });
            }}
          >⬛ Stop</button>
        ) : (
          <button
            className="wf-btn wf-btn-primary nodrag"
            onClick={() => runGeneration(id)}
            disabled={!d.prompt.trim()}
          >▶ Generate</button>
        )}
        {d.progress && <span className={`wf-progress${d.status === 'error' ? ' wf-progress-err' : ''}`}>{d.progress}</span>}
      </div>

      {d.status === 'done' && d.outputUrl && (
        <div className="wf-output">
          <img src={d.outputUrl} alt="output" />
          <button className="wf-btn wf-btn-promote nodrag" onClick={() => promoteOutput(id)}>
            Promote →
          </button>
        </div>
      )}

      {d.status === 'error' && d.error && (
        <div className="wf-error">{d.error}</div>
      )}

      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
