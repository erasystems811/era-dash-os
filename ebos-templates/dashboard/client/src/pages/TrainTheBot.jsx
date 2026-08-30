import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, addEdge, applyNodeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';

const EMPTY_FIELD = { key: '', label: '', question: '', type: 'text', choices: '', examples: '', required_for_state: '' };

function StateCanvas({ states, editable, onPositionChange, onTransitionsChange }) {
  const nodes = useMemo(
    () =>
      states.map((s) => ({
        id: s.key,
        position: { x: s.position_x || 0, y: s.position_y || 0 },
        data: { label: s.label },
        style: { borderRadius: 10, border: '1px solid var(--border)', padding: 4, fontSize: 12.5, fontWeight: 600 },
      })),
    [states]
  );
  const edges = useMemo(
    () =>
      states.flatMap((s) => (s.allowed_next || []).map((target) => ({ id: `${s.key}->${target}`, source: s.key, target, animated: false }))),
    [states]
  );

  const [nodeState, setNodeState] = useState(nodes);
  useEffect(() => setNodeState(nodes), [nodes]);

  const onNodesChange = useCallback((changes) => setNodeState((nds) => applyNodeChanges(changes, nds)), []);

  const onNodeDragStop = useCallback(
    (event, node) => {
      if (!editable) return;
      onPositionChange(node.id, node.position.x, node.position.y);
    },
    [editable, onPositionChange]
  );

  const onConnect = useCallback(
    (connection) => {
      if (!editable) return;
      const source = states.find((s) => s.key === connection.source);
      if (!source) return;
      const nextAllowed = Array.from(new Set([...(source.allowed_next || []), connection.target]));
      onTransitionsChange(source.key, nextAllowed);
    },
    [editable, states, onTransitionsChange]
  );

  const onEdgesDelete = useCallback(
    (deleted) => {
      if (!editable) return;
      for (const edge of deleted) {
        const source = states.find((s) => s.key === edge.source);
        if (!source) continue;
        onTransitionsChange(
          source.key,
          (source.allowed_next || []).filter((k) => k !== edge.target)
        );
      }
    },
    [editable, states, onTransitionsChange]
  );

  return (
    <div style={{ height: 480, border: '1px solid var(--border)', borderRadius: 10, background: '#fafafa' }}>
      <ReactFlow
        nodes={nodeState}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable={editable}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export default function TrainTheBot() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [states, setStates] = useState(null);
  const [fields, setFields] = useState(null);
  const [form, setForm] = useState(EMPTY_FIELD);
  const [error, setError] = useState(null);

  function load() {
    api.get('/bot-states').then(setStates);
    api.get('/bot-fields').then(setFields);
  }
  useEffect(load, []);

  async function savePosition(key, x, y) {
    await api.post(`/bot-states/${key}/position`, { x, y });
  }

  async function saveTransitions(key, allowed_next) {
    setStates((prev) => prev.map((s) => (s.key === key ? { ...s, allowed_next } : s)));
    await api.post(`/bot-states/${key}/transitions`, { allowed_next });
  }

  async function addField(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/bot-fields', {
        ...form,
        choices: form.choices ? form.choices.split(',').map((s) => s.trim()) : null,
        examples: form.examples ? form.examples.split(',').map((s) => s.trim()) : null,
        required_for_state: form.required_for_state || null,
      });
      setForm(EMPTY_FIELD);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeField(key) {
    await api.delete(`/bot-fields/${key}`);
    load();
  }

  if (!states || !fields) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Train the bot</h1>
          <p className="subtitle">What it asks, what it extracts, and how the conversation moves between steps.</p>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Conversation flow</h3>
        <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
          Drag a box to reposition. Drag from one box's edge to another to allow that move. Click a connecting line and press delete to remove it.
        </p>
        <StateCanvas states={states} editable={editable} onPositionChange={savePosition} onTransitionsChange={saveTransitions} />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Questions and what to extract</h3>
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Question asked</th>
              <th>Type</th>
              <th>Choices</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key}>
                <td>{f.key}</td>
                <td>{f.question}</td>
                <td>{f.type}</td>
                <td>{(f.choices || []).join(', ')}</td>
                {editable && (
                  <td>
                    <button className="danger" onClick={() => removeField(f.key)}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add a question</h3>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={addField}>
            <div className="form-row">
              <div className="field">
                <label>Field key (no spaces)</label>
                <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} required />
              </div>
              <div className="field">
                <label>Label</label>
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
              </div>
            </div>
            <div className="field">
              <label>Question the bot asks</label>
              <input value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} required />
            </div>
            <div className="form-row">
              <div className="field">
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option value="text">Text</option>
                  <option value="date">Date</option>
                  <option value="boolean">Yes / no</option>
                  <option value="choice">Choice</option>
                </select>
              </div>
              <div className="field">
                <label>Required for state</label>
                <select value={form.required_for_state} onChange={(e) => setForm({ ...form, required_for_state: e.target.value })}>
                  <option value="">(none)</option>
                  {states.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {form.type === 'choice' && (
              <div className="field">
                <label>Choices (comma separated)</label>
                <input value={form.choices} onChange={(e) => setForm({ ...form, choices: e.target.value })} />
              </div>
            )}
            <button type="submit">Add question</button>
          </form>
        </div>
      )}
    </div>
  );
}
