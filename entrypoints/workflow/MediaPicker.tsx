import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { useWorkflowStore } from './store/workflow';

interface MediaItem {
  mediaId: string;
  url?: string;
  type: 'image' | 'video';
  prompt?: string;
}

interface Props {
  onSelect(mediaId: string, url: string): void;
  onClose(): void;
}

export function MediaPicker({ onSelect, onClose }: Props) {
  const { projectId, workflowId } = useWorkflowStore();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'workflow' | 'project'>(workflowId ? 'workflow' : 'project');

  function load(s: 'workflow' | 'project') {
    setLoading(true);
    setError('');
    chrome.runtime.sendMessage(
      { type: 'GET_PROJECT_MEDIA', projectId: projectId || undefined, scope: s },
      (data) => {
        setLoading(false);
        if (chrome.runtime.lastError || !data) {
          setError(chrome.runtime.lastError?.message || 'Lỗi tải media');
          return;
        }
        if (data.error) { setError(data.error); return; }
        setItems(((data.media as MediaItem[]) || []).filter(m => m.type === 'image' && m.url));
      },
    );
  }

  useEffect(() => { load(scope); }, [scope]);

  return createPortal(
    <div className="wf-picker-overlay" onClick={onClose}>
      <div className="wf-picker-panel" onClick={e => e.stopPropagation()}>
        <div className="wf-picker-head">
          <span>Chọn ảnh từ project</span>
          <div className="wf-picker-scope">
            <button
              className={scope === 'workflow' ? 'on' : ''}
              onClick={() => setScope('workflow')}
              disabled={!workflowId}
            >Workflow</button>
            <button
              className={scope === 'project' ? 'on' : ''}
              onClick={() => setScope('project')}
            >Project</button>
          </div>
          <button className="wf-picker-close" onClick={onClose}>×</button>
        </div>
        <div className="wf-picker-body">
          {loading && <div className="wf-picker-status">Đang tải…</div>}
          {!loading && error && <div className="wf-picker-status wf-picker-err">{error}</div>}
          {!loading && !error && items.length === 0 && (
            <div className="wf-picker-status">Không có ảnh nào.</div>
          )}
          {!loading && items.length > 0 && (
            <div className="wf-picker-grid">
              {items.map(item => (
                <div
                  key={item.mediaId}
                  className="wf-picker-tile"
                  title={item.prompt || item.mediaId}
                  onClick={() => { onSelect(item.mediaId, item.url!); onClose(); }}
                >
                  <img src={item.url} alt="" loading="lazy" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
