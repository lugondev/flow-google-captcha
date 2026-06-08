import { useEffect, useState } from 'react';
import { useWorkflowStore } from './store/workflow';

interface Project { projectId: string; title: string }
interface Workflow { workflowId: string; count: number }

export function ProjectBar() {
  const { projectId, workflowId, setProject, setWorkflow } = useWorkflowStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [tokenOk, setTokenOk] = useState<boolean | null>(null);
  const [tabProject, setTabProject] = useState('');

  useEffect(() => {
    fetchStatus();
    loadProjects();
    const listener = (msg: { type: string }) => {
      if (msg?.type === 'STATUS_PUSH') fetchStatus();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (projectId) loadWorkflows(projectId);
    else setWorkflows([]);
  }, [projectId]);

  function fetchStatus() {
    chrome.runtime.sendMessage({ type: 'STATUS' }, (data) => {
      if (chrome.runtime.lastError) return;
      setTokenOk(!!data?.flowKeyPresent);
      setTabProject(data?.projectId || '');
    });
  }

  function loadProjects() {
    chrome.runtime.sendMessage({ type: 'GET_PROJECTS' }, (data) => {
      if (chrome.runtime.lastError || !data) return;
      setProjects((data.projects as Project[]) || []);
    });
  }

  function loadWorkflows(pid: string) {
    chrome.runtime.sendMessage({ type: 'GET_WORKFLOWS', projectId: pid }, (data) => {
      if (chrome.runtime.lastError) return;
      setWorkflows((data?.workflows as Workflow[]) || []);
    });
  }

  const effectiveProject = projectId || tabProject;

  return (
    <div className="wf-project-bar">
      <span className="wf-pb-item">
        Project
        <select
          className="wf-pb-select"
          value={projectId}
          onChange={e => setProject(e.target.value)}
        >
          <option value="">(tab hiện tại)</option>
          {projects.map(p => (
            <option key={p.projectId} value={p.projectId}>{p.title}</option>
          ))}
        </select>
      </span>

      <span className="wf-pb-item">
        Workflow
        <select
          className="wf-pb-select"
          value={workflows.some(w => w.workflowId === workflowId) ? workflowId : ''}
          onChange={e => setWorkflow(e.target.value)}
        >
          <option value="">(mặc định)</option>
          {workflows.map(w => (
            <option key={w.workflowId} value={w.workflowId}>
              {w.workflowId.slice(0, 8)}… ({w.count})
            </option>
          ))}
        </select>
        <input
          className="wf-pb-input"
          placeholder="hoặc nhập ID…"
          value={workflowId}
          onChange={e => setWorkflow(e.target.value)}
        />
      </span>

      {effectiveProject && (
        <span className="wf-pb-item wf-pb-muted">
          ID: <code>{effectiveProject.slice(0, 8)}…</code>
        </span>
      )}

      <span className="wf-pb-spacer" />

      <button
        className="wf-pb-btn"
        onClick={() => { fetchStatus(); loadProjects(); }}
        title="Làm mới"
      >↻</button>

      <button
        className="wf-pb-btn"
        onClick={() => chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' })}
      >↗ Flow</button>

      <span className={`wf-token-badge ${tokenOk === true ? 'ok' : tokenOk === false ? 'bad' : ''}`}>
        {tokenOk === true ? '● token' : tokenOk === false ? '● no token' : '…'}
      </span>
    </div>
  );
}
