import { create } from 'zustand';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import type { ImageNodeData, GenerateNodeData, WorkflowNodeData, WorkflowSettings } from '../types';
import type { GenerateParams, GenResult } from '../../background/types';

let seq = 0;
function uid() {
  return `n${Date.now().toString(36)}_${(seq++).toString(36)}`;
}

const MAX_INPUTS = 9;

// Topological sort of upstream GenerateNodes for `targetId`.
// Returns IDs in execution order (roots first), NOT including targetId itself.
function upstreamGenOrder(targetId: string, nodes: Node[], edges: Edge[]): string[] {
  const result: string[] = [];
  const visited = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const e of edges) {
      if (e.target !== id) continue;
      const src = nodes.find(n => n.id === e.source);
      if (!src || (src.data as WorkflowNodeData).type !== 'generate') continue;
      visit(e.source);
    }
    if (id !== targetId) result.push(id);
  }

  visit(targetId);
  return result;
}

interface WorkflowState {
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  settings: WorkflowSettings;
  projectId: string;
  workflowId: string;

  onNodesChange(changes: NodeChange[]): void;
  onEdgesChange(changes: EdgeChange[]): void;
  onConnect(connection: Connection): void;
  addImageNode(data?: Partial<ImageNodeData>, position?: { x: number; y: number }): string;
  addGenerateNode(position?: { x: number; y: number }): string;
  updateNodeData(id: string, patch: Record<string, unknown>): void;
  deleteNode(id: string): void;
  promoteOutput(generateNodeId: string): void;
  runGeneration(generateNodeId: string): Promise<void>;
  updateSettings(patch: Partial<WorkflowSettings>): void;
  setProject(projectId: string): void;
  setWorkflow(workflowId: string): void;
  stopAll(): void;
  clearAll(): void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  nodes: [],
  edges: [],
  settings: { model: 'nano_banana_pro', orientation: 'portrait' },
  projectId: '',
  workflowId: '',

  onNodesChange(changes) {
    set(s => ({ nodes: applyNodeChanges(changes, s.nodes) as Node<WorkflowNodeData>[] }));
  },

  onEdgesChange(changes) {
    set(s => ({ edges: applyEdgeChanges(changes, s.edges) }));
  },

  onConnect(connection) {
    const { edges, nodes } = get();
    const source = nodes.find(n => n.id === connection.source);
    const target = nodes.find(n => n.id === connection.target);
    if (!source || !target) return;
    const srcType = (source.data as WorkflowNodeData).type;
    const tgtType = (target.data as WorkflowNodeData).type;
    if (tgtType !== 'generate') return;
    if (srcType !== 'image' && srcType !== 'generate') return;
    if (connection.source === connection.target) return;

    // Auto-assign the next free in-X slot so dropping on the node body
    // (targetHandle=null) or on an occupied handle never overwrites an
    // existing edge — each source always lands in its own slot.
    const usedHandles = new Set(
      edges.filter(e => e.target === connection.target).map(e => e.targetHandle),
    );
    let freeSlot = -1;
    for (let i = 0; i < MAX_INPUTS; i++) {
      if (!usedHandles.has(`in-${i}`)) { freeSlot = i; break; }
    }
    if (freeSlot === -1) return;

    set(s => ({ edges: addEdge({ ...connection, targetHandle: `in-${freeSlot}` }, s.edges) }));
  },

  addImageNode(data = {}, position) {
    const id = uid();
    const pos = position ?? { x: 80 + Math.random() * 160, y: 80 + Math.random() * 160 };
    const node: Node<ImageNodeData> = {
      id, type: 'imageNode', position: pos,
      data: { type: 'image', ...data } as ImageNodeData,
    };
    set(s => ({ nodes: [...s.nodes, node] }));
    return id;
  },

  addGenerateNode(position) {
    const id = uid();
    const pos = position ?? { x: 380 + Math.random() * 160, y: 80 + Math.random() * 160 };
    const node: Node<GenerateNodeData> = {
      id, type: 'generateNode', position: pos,
      data: { type: 'generate', prompt: '', status: 'idle' } as GenerateNodeData,
    };
    set(s => ({ nodes: [...s.nodes, node] }));
    return id;
  },

  updateNodeData(id, patch) {
    set(s => ({
      nodes: s.nodes.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n),
    }));
  },

  deleteNode(id) {
    set(s => ({
      nodes: s.nodes.filter(n => n.id !== id),
      edges: s.edges.filter(e => e.source !== id && e.target !== id),
    }));
  },

  promoteOutput(generateNodeId) {
    const { nodes, addImageNode } = get();
    const genNode = nodes.find(n => n.id === generateNodeId);
    if (!genNode) return;
    const data = genNode.data as GenerateNodeData;
    if (!data.outputUrl) return;
    addImageNode(
      { mediaId: data.outputMediaId, thumbnailUrl: data.outputUrl, name: 'Generated', source: 'project' },
      { x: genNode.position.x + 340, y: genNode.position.y },
    );
  },

  async runGeneration(targetId) {
    const { nodes, edges } = get();
    const target = nodes.find(n => n.id === targetId);
    if (!target || (target.data as GenerateNodeData).status === 'running') return;

    // Run upstream generate nodes in order first, then run target
    const execOrder = [...upstreamGenOrder(targetId, nodes, edges), targetId];

    for (const id of execOrder) {
      const currentNode = get().nodes.find(n => n.id === id);
      if (!currentNode) continue;
      const data = currentNode.data as GenerateNodeData;
      if (id !== targetId && data.status === 'done' && data.outputUrl) continue;

      await runSingleNode(id, get);
      const afterNode = get().nodes.find(n => n.id === id);
      if ((afterNode?.data as GenerateNodeData)?.status === 'error') break;
    }
  },

  updateSettings(patch) {
    set(s => ({ settings: { ...s.settings, ...patch } }));
  },

  setProject(projectId) {
    set({ projectId, workflowId: '' });
  },

  setWorkflow(workflowId) {
    set({ workflowId });
  },

  stopAll() {
    chrome.runtime.sendMessage({ type: 'CANCEL_GENERATE' });
    set(s => ({
      nodes: s.nodes.map(n => {
        if ((n.data as WorkflowNodeData).type !== 'generate') return n;
        const d = n.data as GenerateNodeData;
        if (d.status !== 'running') return n;
        return { ...n, data: { ...d, status: 'idle' as const, progress: 'Đã dừng' } };
      }),
    }));
  },

  clearAll() {
    set({ nodes: [], edges: [] });
  },
}));

// Execute one GenerateNode: collect refs from current store state, call GENERATE, update node.
async function runSingleNode(
  id: string,
  get: () => WorkflowState,
) {
  const { edges, settings, updateNodeData } = get();
  const node = get().nodes.find(n => n.id === id);
  if (!node) return;
  const data = node.data as GenerateNodeData;

  // Collect source nodes connected to this GenerateNode
  const srcNodes = edges
    .filter(e => e.target === id)
    .map(e => ({ edge: e, node: get().nodes.find(n => n.id === e.source) }))
    .filter((x): x is { edge: typeof x.edge; node: NonNullable<typeof x.node> } => !!x.node);

  // Pre-upload any ImageNode with base64 data → get mediaId, update node state
  const uploadNeeded = srcNodes.filter(({ node: src }) => {
    const d = src.data as WorkflowNodeData;
    return d.type === 'image' && !!(d as ImageNodeData).base64;
  });

  if (uploadNeeded.length > 0) {
    updateNodeData(id, { status: 'running', progress: `Upload ${uploadNeeded.length} ảnh…`, error: undefined, outputUrl: undefined });
    await Promise.all(
      uploadNeeded.map(async ({ node: src }) => {
        const img = src.data as ImageNodeData;
        const result: { mediaId?: string; url?: string; error?: string } = await new Promise(resolve =>
          chrome.runtime.sendMessage(
            {
              type: 'UPLOAD_IMAGE',
              ref: { source: 'upload', base64: img.base64, mime: img.mime || 'image/jpeg', name: img.name },
              projectId: get().projectId || undefined,
              workflowId: get().workflowId || undefined,
            },
            resolve,
          ),
        );
        if (result?.mediaId) {
          // Promote node from upload → project so future generations reuse mediaId
          get().updateNodeData(src.id, {
            mediaId: result.mediaId,
            thumbnailUrl: result.url || img.thumbnailUrl,
            base64: undefined,
            source: 'project',
          });
        } else {
          console.warn('[Workflow] upload failed for', src.id, result?.error);
        }
      }),
    );
  }

  // Collect refs from (now-updated) source nodes
  const refs = srcNodes
    .map(({ node: src }) => {
      const d = src.data as WorkflowNodeData;
      // Re-read latest data in case upload just updated it
      const latest = (get().nodes.find(n => n.id === src.id)?.data ?? d) as WorkflowNodeData;
      if (latest.type === 'image') {
        const img = latest as ImageNodeData;
        if (img.mediaId) return { source: 'project' as const, mediaId: img.mediaId, url: img.thumbnailUrl };
        if (img.base64) return { source: 'upload' as const, base64: img.base64, mime: img.mime || 'image/jpeg' };
        if (img.thumbnailUrl) return { source: 'project' as const, url: img.thumbnailUrl };
      }
      if (latest.type === 'generate') {
        const gen = latest as GenerateNodeData;
        if (gen.outputMediaId) return { source: 'project' as const, mediaId: gen.outputMediaId, url: gen.outputUrl };
        if (gen.outputUrl) {
          if (gen.outputUrl.startsWith('data:')) {
            const [header, base64] = gen.outputUrl.split(',');
            const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
            return { source: 'upload' as const, base64, mime };
          }
          return { source: 'project' as const, url: gen.outputUrl };
        }
      }
      return null;
    })
    .filter((r): r is NonNullable<typeof r> => !!(r && (('mediaId' in r && r.mediaId) || ('base64' in r && r.base64) || ('url' in r && r.url))));

  console.log(`[Workflow] node ${id}: ${refs.length} refs`, refs);

  updateNodeData(id, { status: 'running', progress: `${refs.length} refs — bắt đầu…`, error: undefined, outputUrl: undefined });

  const params: GenerateParams = {
    mediaType: 'image',
    prompt: data.prompt,
    model: settings.model,
    orientation: settings.orientation,
    count: 1,
    maxAttempts: 3,
    references: refs,
    clientId: id,
    projectId: get().projectId || undefined,
    workflowId: get().workflowId || undefined,
  };

  const progressListener = (msg: { type: string; progress?: { clientId?: string; message?: string } }) => {
    if (msg?.type === 'GEN_PROGRESS' && msg.progress?.clientId === id) {
      get().updateNodeData(id, { progress: msg.progress.message });
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const result = await new Promise<GenResult>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GENERATE', params }, (r?: GenResult) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r) return reject(new Error('No result'));
        resolve(r);
      });
    });

    if (result.ok && result.media.length > 0) {
      const m = result.media[0];
      get().updateNodeData(id, {
        status: 'done',
        outputUrl: m.url || m.dataUri,
        outputMediaId: undefined,
        progress: `Xong sau ${result.attempts} lần`,
        error: undefined,
      });
    } else {
      get().updateNodeData(id, { status: 'error', error: result.error || 'Thất bại', progress: undefined });
    }
  } catch (e) {
    get().updateNodeData(id, { status: 'error', error: (e as Error).message, progress: undefined });
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
  }
}
