import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowStore } from './store/workflow';
import { ImageNode } from './nodes/ImageNode';
import { GenerateNode } from './nodes/GenerateNode';
import { ProjectBar } from './ProjectBar';
import type { GenerateNodeData } from './types';

const nodeTypes = {
  imageNode: ImageNode,
  generateNode: GenerateNode,
};

export function App() {
  const {
    nodes, edges,
    onNodesChange, onEdgesChange, onConnect,
    addImageNode, addGenerateNode,
    settings, updateSettings,
    stopAll, clearAll,
  } = useWorkflowStore();

  const hasRunning = nodes.some(n => n.type === 'generateNode' && (n.data as GenerateNodeData).status === 'running');
  const hasNodes = nodes.length > 0;

  return (
    <div className="wf-root">
      <ProjectBar />
      <div className="wf-topbar">
        <div className="wf-logo">✦ <span>Workflow</span></div>
        <div className="wf-settings">
          <label>Model
            <select value={settings.model} onChange={e => updateSettings({ model: e.target.value })}>
              <option value="nano_banana_pro">🍌 Nano Banana Pro</option>
              <option value="narwhal_display">🍌 Nano Banana 2</option>
            </select>
          </label>
          <label>Orientation
            <select
              value={settings.orientation}
              onChange={e => updateSettings({ orientation: e.target.value as 'portrait' | 'landscape' | 'square' })}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
              <option value="square">Square</option>
            </select>
          </label>
          {hasRunning && (
            <button className="wf-top-btn wf-top-stop" onClick={stopAll} title="Dừng tất cả">⬛ Stop all</button>
          )}
          {hasNodes && (
            <button className="wf-top-btn wf-top-clear" onClick={clearAll} title="Xóa toàn bộ nodes">↺ Clear all</button>
          )}
        </div>
      </div>

      <div className="wf-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          colorMode="dark"
          defaultEdgeOptions={{ style: { stroke: '#6366f1', strokeWidth: 2 } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a4d" />
          <Controls />
          <MiniMap
            nodeColor={n => n.type === 'generateNode' ? '#6366f1' : '#3b82f6'}
            maskColor="rgba(11,11,22,0.7)"
          />
        </ReactFlow>
      </div>

      <div className="wf-palette">
        <button className="wf-pal-btn" onClick={() => addImageNode()}>＋ Image</button>
        <button className="wf-pal-btn wf-pal-primary" onClick={() => addGenerateNode()}>＋ Generate</button>
      </div>
    </div>
  );
}
