import { useCallback, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useWorkflowStore } from '../store/workflow';
import { MediaPicker } from '../MediaPicker';
import type { ImageNodeData } from '../types';

export function ImageNode({ id, data }: NodeProps) {
  const d = data as ImageNodeData;
  const { updateNodeData, deleteNode, projectId, workflowId } = useWorkflowStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [uploading, setUploading] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = String(reader.result);
        updateNodeData(id, {
          thumbnailUrl: dataUri,
          base64: dataUri.split(',')[1] || '',
          mime: file.type,
          name: file.name,
          source: 'upload',
          mediaId: undefined,
        });
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData],
  );

  function handleProjectSelect(mediaId: string, url: string) {
    updateNodeData(id, {
      mediaId,
      thumbnailUrl: url,
      base64: undefined,
      mime: undefined,
      name: mediaId.slice(0, 8) + '…',
      source: 'project',
    });
  }

  async function handleUpload() {
    if (!d.base64 || uploading) return;
    setUploading(true);
    const result = await new Promise<{ mediaId?: string; url?: string; error?: string }>(resolve =>
      chrome.runtime.sendMessage(
        {
          type: 'UPLOAD_IMAGE',
          ref: { source: 'upload', base64: d.base64, mime: d.mime || 'image/jpeg', name: d.name },
          projectId: projectId || undefined,
          workflowId: workflowId || undefined,
        },
        resolve,
      ),
    );
    setUploading(false);
    if (result?.mediaId) {
      updateNodeData(id, {
        mediaId: result.mediaId,
        base64: undefined,
        source: 'project',
      });
    } else {
      console.warn('[ImageNode] upload failed:', result?.error);
    }
  }

  const isLocal = d.source === 'upload' && !!d.base64;
  const isProject = d.source === 'project' && !!d.mediaId;

  return (
    <div
      className="wf-node wf-image-node"
      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) handleFile(f); }}
      onDragOver={e => e.preventDefault()}
    >
      <div className="wf-node-header">
        <span className="wf-node-icon">▣</span>
        <span className="wf-node-title">{d.name || 'Image'}</span>
        <button className="wf-node-del nodrag" onClick={() => deleteNode(id)}>×</button>
      </div>

      {d.thumbnailUrl ? (
        <>
          <div className="wf-image-thumb">
            <img src={d.thumbnailUrl} alt="" />
            <button
              className="wf-image-clear nodrag"
              onClick={() => updateNodeData(id, { thumbnailUrl: undefined, base64: undefined, mediaId: undefined, name: undefined, source: undefined })}
            >×</button>
            {isProject && (
              <span className="wf-image-badge wf-image-badge-ok nodrag">✓ project</span>
            )}
          </div>
          {isLocal && (
            <div className="wf-image-actions">
              <button
                className="wf-btn wf-btn-primary nodrag"
                disabled={uploading}
                onClick={handleUpload}
              >
                {uploading ? 'Đang upload…' : '↑ Upload lên Flow'}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="wf-image-actions">
          <div
            className="wf-image-drop nodrag"
            onClick={() => fileRef.current?.click()}
          >
            <span>Drop ảnh / Chọn file</span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
          </div>
          <button
            className="wf-btn wf-btn-project nodrag"
            onClick={() => setShowPicker(true)}
          >📁 Từ project</button>
        </div>
      )}

      {showPicker && (
        <MediaPicker
          onSelect={handleProjectSelect}
          onClose={() => setShowPicker(false)}
        />
      )}

      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
