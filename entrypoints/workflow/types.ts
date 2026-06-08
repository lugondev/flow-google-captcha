export interface ImageNodeData extends Record<string, unknown> {
  type: 'image';
  mediaId?: string;
  thumbnailUrl?: string;
  name?: string;
  source?: 'upload' | 'project';
  base64?: string;
  mime?: string;
}

export interface GenerateNodeData extends Record<string, unknown> {
  type: 'generate';
  prompt: string;
  status: 'idle' | 'running' | 'done' | 'error';
  outputUrl?: string;
  outputMediaId?: string;
  progress?: string;
  error?: string;
}

export type WorkflowNodeData = ImageNodeData | GenerateNodeData;

export interface WorkflowSettings {
  model: string;
  orientation: 'portrait' | 'landscape' | 'square';
}
