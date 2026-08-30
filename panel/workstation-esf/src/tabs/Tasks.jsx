import React, { useState } from 'react';
import { PROOF_TYPES, PROOF_TYPE_LABELS, PROOF_CONFIG_FIELDS, DAY_CODES } from '../proofTypes.js';

const EMPTY_TASK = { name: '', assignTo: '', days: [...DAY_CODES], available_from: '08:00', due_by: '20:00', mode: 'chat', steps: [] };
const EMPTY_STEP = { instruction: '', proof_type: 'tap', on_problem: 'continue', optional: false, clock_action: 'none', config: {} };
const FORM_INCOMPATIBLE = ['location', 'photo'];

export default function Tasks({ tasks, setTasks, staff }) {
  const [taskForm, setTaskForm] = useState(EMPTY_TASK);
  const [editingTaskIndex, setEditingTaskIndex] = useState(null);
  const [openTaskIndex, setOpenTaskIndex] = useState(null);
  const [step, setStep] = useState(EMPTY_STEP);
  const [editingStepIndex, setEditingStepIndex] = useState(null);
  const [error, setError] = useState(null);

  const roles = [...new Set(staff.map((s) => s.role).filter(Boolean))];

  function toggleDay(day) {
    setTaskForm((f) => ({ ...f, days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day] }));
  }

  function submitTask(e) {
    e.preventDefault();
    if (editingTaskIndex === null) {
      setTasks([...tasks, taskForm]);
      setOpenTaskIndex(tasks.length);
    } else {
      setTasks(tasks.map((t, i) => (i === editingTaskIndex ? { ...taskForm, steps: t.steps } : t)));
      setOpenTaskIndex(editingTaskIndex);
    }
    setTaskForm(EMPTY_TASK);
    setEditingTaskIndex(null);
  }

  function editTask(i) {
    const { steps, ...rest } = tasks[i];
    setTaskForm(rest);
    setEditingTaskIndex(i);
  }

  function removeTask(i) {
    setTasks(tasks.filter((_, idx) => idx !== i));
    if (openTaskIndex === i) setOpenTaskIndex(null);
    if (editingTaskIndex === i) {
      setTaskForm(EMPTY_TASK);
      setEditingTaskIndex(null);
    }
  }

  function setConfigField(name, value) {
    setStep((s) => ({ ...s, config: { ...s.config, [name]: value } }));
  }

  function startEditStep(i, s) {
    setOpenTaskIndex(i);
    setEditingStepIndex(tasks[i].steps.indexOf(s));
    setStep(s);
  }

  function cancelEditStep() {
    setEditingStepIndex(null);
    setStep(EMPTY_STEP);
  }

  function submitStep(e, taskIndex) {
    e.preventDefault();
    setError(null);
    const task = tasks[taskIndex];
    if (task.mode === 'form' && FORM_INCOMPATIBLE.includes(step.proof_type)) {
      setError(`"${PROOF_TYPE_LABELS[step.proof_type]}" needs a live camera/GPS check and can't go in a form-mode task -- switch this task to chat mode, or pick a different proof type.`);
      return;
    }
    const steps = editingStepIndex === null ? [...task.steps, step] : task.steps.map((s, i) => (i === editingStepIndex ? step : s));
    setTasks(tasks.map((t, i) => (i === taskIndex ? { ...t, steps } : t)));
    setStep({ ...EMPTY_STEP, proof_type: step.proof_type });
    setEditingStepIndex(null);
  }

  function removeStep(taskIndex, stepIndex) {
    setTasks(tasks.map((t, i) => (i === taskIndex ? { ...t, steps: t.steps.filter((_, si) => si !== stepIndex) } : t)));
    if (editingStepIndex === stepIndex) cancelEditStep();
  }

  function moveStep(taskIndex, stepIndex, direction) {
    setTasks(
      tasks.map((t, i) => {
        if (i !== taskIndex) return t;
        const steps = [...t.steps];
        const target = direction === 'up' ? stepIndex - 1 : stepIndex + 1;
        if (target < 0 || target >= steps.length) return t;
        [steps[stepIndex], steps[target]] = [steps[target], steps[stepIndex]];
        return { ...t, steps };
      })
    );
  }

  const fields = PROOF_CONFIG_FIELDS[step.proof_type] || [];

  return (
    <div>
      <h1>Tasks & steps</h1>
      <p className="subtitle">Each task is a job someone does, broken into steps. Nothing here is fixed to opening/closing -- design whatever tasks this business actually needs.</p>

      {error && <div className="error-banner">{error}</div>}

      {tasks.map((t, i) => (
        <div className="task-card" key={i}>
          <div className="task-card-header">
            <div>
              <strong>{t.name}</strong>
              <span className="pill">{t.steps.length} step{t.steps.length === 1 ? '' : 's'}</span>
              <span className="pill">{t.mode === 'form' ? 'Form' : 'Chat'}</span>
            </div>
            <div>
              <button className="secondary" onClick={() => setOpenTaskIndex(openTaskIndex === i ? null : i)}>
                {openTaskIndex === i ? 'Close' : 'Open'}
              </button>{' '}
              <button className="secondary" onClick={() => editTask(i)}>
                Edit
              </button>{' '}
              <button className="danger" onClick={() => removeTask(i)}>
                Delete
              </button>
            </div>
          </div>
          <div className="meta">
            {t.assignTo ? (t.assignTo.startsWith('role:') ? `Role: ${t.assignTo.slice(5)}` : `Just ${staff.find((s) => s.phone === t.assignTo.slice(6))?.name || t.assignTo.slice(6)}`) : 'Everyone'}
            {' · '}
            {t.days.length === 7 ? 'Every day' : t.days.join(', ')} · {t.available_from}-{t.due_by}
          </div>

          {openTaskIndex === i && (
            <div style={{ marginTop: 14 }}>
              {t.steps.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {t.steps.map((s, si) => (
                    <div className="step-card" key={si} style={editingStepIndex === si ? { borderColor: 'var(--accent)' } : undefined}>
                      <div>
                        <span className="seq">{si + 1}.</span>
                        {s.instruction}
                      </div>
                      <div className="meta">
                        Proof: {PROOF_TYPE_LABELS[s.proof_type]} · On problem: {s.on_problem}
                        {s.optional ? ' · optional' : ''}
                        {s.clock_action !== 'none' ? ` · clock ${s.clock_action}` : ''}
                      </div>
                      <div className="actions" style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                        {si > 0 && (
                          <button className="secondary" onClick={() => moveStep(i, si, 'up')}>
                            Move up
                          </button>
                        )}
                        {si < t.steps.length - 1 && (
                          <button className="secondary" onClick={() => moveStep(i, si, 'down')}>
                            Move down
                          </button>
                        )}
                        <button className="secondary" onClick={() => startEditStep(i, s)}>
                          Edit
                        </button>
                        <button className="danger" onClick={() => removeStep(i, si)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="card">
                <h3 style={{ marginTop: 0 }}>{editingStepIndex !== null ? 'Edit step' : 'Add a step'}</h3>
                <form onSubmit={(e) => submitStep(e, i)}>
                  <div className="field">
                    <label>Instruction (what they see)</label>
                    <textarea rows={2} value={step.instruction} onChange={(e) => setStep({ ...step, instruction: e.target.value })} required />
                  </div>

                  <label>Proof type -- what proves this step is done</label>
                  <div className="proof-type-picker">
                    {PROOF_TYPES.map((pt) => (
                      <label key={pt}>
                        <input
                          type="radio"
                          name={`proof_type_${i}`}
                          value={pt}
                          checked={step.proof_type === pt}
                          onChange={() => setStep({ ...step, proof_type: pt, config: {} })}
                        />
                        {PROOF_TYPE_LABELS[pt]}
                      </label>
                    ))}
                  </div>

                  {fields.length > 0 && (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12, marginBottom: 14 }}>
                      {fields.map((f) => (
                        <div className="field" key={f.name}>
                          <label>{f.label}</label>
                          {f.type === 'textarea' ? (
                            <textarea rows={3} value={step.config[f.name] || ''} onChange={(e) => setConfigField(f.name, e.target.value)} />
                          ) : f.type === 'select' ? (
                            <select value={step.config[f.name] || f.options[0]} onChange={(e) => setConfigField(f.name, e.target.value)}>
                              {f.options.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input type={f.type} value={step.config[f.name] ?? f.default ?? ''} onChange={(e) => setConfigField(f.name, e.target.value)} />
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
                    <input type="checkbox" id={`optional_${i}`} checked={step.optional} onChange={(e) => setStep({ ...step, optional: e.target.checked })} />
                    <label htmlFor={`optional_${i}`} style={{ margin: 0 }}>
                      Optional (they can reply SKIP)
                    </label>
                  </div>
                  <button type="submit">{editingStepIndex !== null ? 'Save step' : 'Add step'}</button>
                  {editingStepIndex !== null && (
                    <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={cancelEditStep}>
                      Cancel
                    </button>
                  )}
                </form>
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{editingTaskIndex === null ? 'Add a task' : 'Edit task'}</h3>
        <form onSubmit={submitTask}>
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
              {staff.map((s) => (
                <option key={s.phone} value={`staff:${s.phone}`}>
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
                  <input type="checkbox" checked={taskForm.days.includes(d)} onChange={() => toggleDay(d)} />
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
          <button type="submit">{editingTaskIndex === null ? 'Add task' : 'Save'}</button>
          {editingTaskIndex !== null && (
            <button
              type="button"
              className="secondary"
              style={{ marginLeft: 8 }}
              onClick={() => {
                setTaskForm(EMPTY_TASK);
                setEditingTaskIndex(null);
              }}
            >
              Cancel
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
