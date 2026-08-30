import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PROOF_TYPES, PROOF_TYPE_LABELS, PROOF_CONFIG_FIELDS, DAY_CODES } from '../proofTypes.js';
import StepOverrides from '../components/StepOverrides.jsx';

const EMPTY_STEP = { instruction: '', proof_type: 'tap', on_problem: 'continue', optional: false, clock_action: 'none', config: {} };

export default function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState(null);
  const [steps, setSteps] = useState(null);
  const [staffList, setStaffList] = useState([]);
  const [step, setStep] = useState(EMPTY_STEP);
  const [editingStepId, setEditingStepId] = useState(null);
  const [editingTask, setEditingTask] = useState(false);
  const [taskForm, setTaskForm] = useState(null);
  const [error, setError] = useState(null);

  function load() {
    api.get(`/tasks/${id}`).then((d) => {
      setTask(d.task);
      setSteps(d.steps);
    });
  }
  useEffect(load, [id]);
  useEffect(() => {
    api.get('/staff').then((s) => setStaffList(s.filter((p) => p.active)));
  }, []);

  function setConfigField(name, value) {
    setStep((s) => ({ ...s, config: { ...s.config, [name]: value } }));
  }

  function startEditStep(s) {
    setEditingStepId(s.id);
    setStep({ instruction: s.instruction, proof_type: s.proof_type, on_problem: s.on_problem, optional: s.optional, clock_action: s.clock_action, config: s.rawConfig || {} });
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function cancelEditStep() {
    setEditingStepId(null);
    setStep(EMPTY_STEP);
  }

  async function submitStep(e) {
    e.preventDefault();
    setError(null);
    try {
      if (editingStepId) await api.patch(`/tasks/${id}/steps/${editingStepId}`, step);
      else await api.post(`/tasks/${id}/steps`, step);
      setStep({ ...EMPTY_STEP, proof_type: step.proof_type });
      setEditingStepId(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteStep(stepId) {
    await api.delete(`/tasks/${id}/steps/${stepId}`);
    if (editingStepId === stepId) cancelEditStep();
    load();
  }

  async function moveStep(stepId, direction) {
    await api.post(`/tasks/${id}/steps/${stepId}/move`, { direction });
    load();
  }

  async function toggleActive() {
    await api.post(`/tasks/${id}/toggle-active`);
    load();
  }

  async function deleteTask() {
    if (!window.confirm('Delete this task? Only works if it has no runs yet.')) return;
    try {
      await api.delete(`/tasks/${id}`);
      navigate('/tasks');
    } catch (err) {
      setError(err.message);
    }
  }

  function startEditTask() {
    setTaskForm({ name: task.name, assignTo: task.assignTo, days: task.days.split(',').filter(Boolean), available_from: task.available_from, due_by: task.due_by, mode: task.mode });
    setEditingTask(true);
  }

  function toggleTaskDay(day) {
    setTaskForm((f) => ({ ...f, days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day] }));
  }

  async function saveTask(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.patch(`/tasks/${id}`, taskForm);
      setEditingTask(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!task || !steps) return null;

  const fields = PROOF_CONFIG_FIELDS[step.proof_type] || [];
  const roles = [...new Set(staffList.map((s) => s.role))];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{task.name}</h1>
          <p className="subtitle">
            {task.assignment} &middot; {task.days} &middot; {task.available_from}-{task.due_by} &middot; {task.mode === 'form' ? 'Form' : 'Chat'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary" onClick={startEditTask}>
            Edit task
          </button>
          <button className="secondary" onClick={toggleActive}>
            {task.active ? 'Deactivate' : 'Reactivate'}
          </button>
          <button className="danger" onClick={deleteTask}>
            Delete task
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {editingTask && taskForm && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Edit task</h3>
          <form onSubmit={saveTask}>
            <div className="field">
              <label>Task name</label>
              <input value={taskForm.name} onChange={(e) => setTaskForm({ ...taskForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Assign to</label>
              <select value={taskForm.assignTo} onChange={(e) => setTaskForm({ ...taskForm, assignTo: e.target.value })}>
                <option value="">Everyone (every active staff member)</option>
                {roles.map((r) => (
                  <option key={r} value={`role:${r}`}>
                    Everyone with role: {r}
                  </option>
                ))}
                {staffList.map((s) => (
                  <option key={s.id} value={`staff:${s.id}`}>
                    {s.name} only ({s.role})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Days</label>
              <div className="day-picker">
                {DAY_CODES.map((d) => (
                  <label key={d}>
                    <input type="checkbox" checked={taskForm.days.includes(d)} onChange={() => toggleTaskDay(d)} />
                    {d}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Available from</label>
                <input type="time" value={taskForm.available_from} onChange={(e) => setTaskForm({ ...taskForm, available_from: e.target.value })} required />
              </div>
              <div className="field">
                <label>Due by</label>
                <input type="time" value={taskForm.due_by} onChange={(e) => setTaskForm({ ...taskForm, due_by: e.target.value })} required />
              </div>
            </div>
            <div className="field">
              <label>Delivery</label>
              <select value={taskForm.mode} onChange={(e) => setTaskForm({ ...taskForm, mode: e.target.value })}>
                <option value="chat">Chat -- one step at a time, in order</option>
                <option value="form">Form -- a link to fill out all at once (no location/photo steps)</option>
              </select>
            </div>
            <button type="submit">Save</button>
            <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={() => setEditingTask(false)}>
              Cancel
            </button>
          </form>
        </div>
      )}

      <h2 style={{ fontSize: 15, marginBottom: 8 }}>Steps</h2>
      {steps.length ? (
        steps.map((s, i) => (
          <div className="step-card" key={s.id} style={editingStepId === s.id ? { borderColor: 'var(--accent)' } : undefined}>
            <div>
              <span className="seq">{s.seq}.</span>
              {s.instruction}
            </div>
            <div className="meta">
              Proof: {PROOF_TYPE_LABELS[s.proof_type] || s.proof_type} &middot; On problem: {s.on_problem}
              {s.optional ? ' · optional' : ''}
              {s.clock_action !== 'none' ? ` · clock ${s.clock_action}` : ''}
            </div>
            <div className="actions">
              {i > 0 && (
                <button className="secondary" onClick={() => moveStep(s.id, 'up')}>
                  Move up
                </button>
              )}
              {i < steps.length - 1 && (
                <button className="secondary" onClick={() => moveStep(s.id, 'down')}>
                  Move down
                </button>
              )}
              <button className="secondary" onClick={() => startEditStep(s)}>
                Edit
              </button>
              <button className="danger" onClick={() => deleteStep(s.id)}>
                Delete
              </button>
            </div>
            <StepOverrides taskId={id} stepId={s.id} staffList={staffList} />
          </div>
        ))
      ) : (
        <div className="card empty-state">No steps yet -- add the first one below.</div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>{editingStepId ? 'Edit step' : 'Add a step'}</h3>
        <form onSubmit={submitStep}>
          <div className="field">
            <label>Instruction (what she sees)</label>
            <textarea rows={2} value={step.instruction} onChange={(e) => setStep({ ...step, instruction: e.target.value })} required />
          </div>

          <label>Proof type -- what proves this step is done</label>
          <div className="proof-type-picker">
            {PROOF_TYPES.map((t) => (
              <label key={t}>
                <input
                  type="radio"
                  name="proof_type"
                  value={t}
                  checked={step.proof_type === t}
                  onChange={() => setStep({ ...step, proof_type: t, config: {} })}
                />
                {PROOF_TYPE_LABELS[t]}
              </label>
            ))}
          </div>

          {fields.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12, marginBottom: 14 }}>
              {fields.map((f) => (
                <div className="field" key={f.name}>
                  <label>{f.label}</label>
                  {f.type === 'textarea' ? (
                    <textarea
                      rows={3}
                      value={step.config[f.name] || ''}
                      onChange={(e) => setConfigField(f.name, e.target.value)}
                    />
                  ) : f.type === 'select' ? (
                    <select value={step.config[f.name] || f.options[0]} onChange={(e) => setConfigField(f.name, e.target.value)}>
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type}
                      value={step.config[f.name] ?? f.default ?? ''}
                      onChange={(e) => setConfigField(f.name, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="form-row">
            <div className="field">
              <label>On problem</label>
              <select value={step.on_problem} onChange={(e) => setStep({ ...step, on_problem: e.target.value })}>
                <option value="continue">Continue -- just log it</option>
                <option value="alert">Alert -- tell the owner, keep going</option>
                <option value="block">Block -- stop until a manager clears it</option>
              </select>
            </div>
            <div className="field">
              <label>Clock action</label>
              <select value={step.clock_action} onChange={(e) => setStep({ ...step, clock_action: e.target.value })}>
                <option value="none">None</option>
                <option value="in">Clock in</option>
                <option value="out">Clock out</option>
              </select>
            </div>
          </div>
          <div className="field checkbox-row">
            <input
              type="checkbox"
              id="optional"
              checked={step.optional}
              onChange={(e) => setStep({ ...step, optional: e.target.checked })}
            />
            <label htmlFor="optional" style={{ margin: 0 }}>
              Optional (she can reply SKIP)
            </label>
          </div>
          <button type="submit">{editingStepId ? 'Save step' : 'Add step'}</button>
          {editingStepId && (
            <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={cancelEditStep}>
              Cancel
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
