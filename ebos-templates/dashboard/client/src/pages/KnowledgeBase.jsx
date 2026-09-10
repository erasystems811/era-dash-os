import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function KnowledgeBase() {
  // Every tier that can reach this page (owner/manager/PIN staff) can edit
  // it -- Chidera's call, 2026-09-03: "when i say they can see knowledge
  // base and catalogue it means they can edit it and work on it normally
  // not just view only". Kept as its own constant (not just deleting every
  // `editable &&` below) so the RBAC decision stays one documented line,
  // not scattered assumptions.
  const editable = true;
  const [entries, setEntries] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editAnswer, setEditAnswer] = useState('');

  function load() {
    api.get('/knowledge-base').then(setEntries);
  }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault();
    await api.post('/knowledge-base', { question, answer });
    setQuestion('');
    setAnswer('');
    load();
  }

  async function remove(id) {
    await api.delete(`/knowledge-base/${id}`);
    load();
  }

  function startEdit(k) {
    setEditingId(k.id);
    setEditQuestion(k.question);
    setEditAnswer(k.answer);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id) {
    await api.post(`/knowledge-base/${id}`, { question: editQuestion, answer: editAnswer });
    setEditingId(null);
    load();
  }

  if (!entries) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Knowledge base</h1>
          <p className="subtitle">What the bot answers customer questions from. Nothing outside this list gets guessed.</p>
        </div>
      </div>

      <div className="card">
        {entries.map((k) =>
          editingId === k.id ? (
            <div key={k.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="field">
                <label>Question</label>
                <input value={editQuestion} onChange={(e) => setEditQuestion(e.target.value)} />
              </div>
              <div className="field">
                <label>Answer</label>
                <textarea rows={3} value={editAnswer} onChange={(e) => setEditAnswer(e.target.value)} />
              </div>
              <button onClick={() => saveEdit(k.id)} style={{ marginRight: 8 }}>
                Save
              </button>
              <button className="secondary" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          ) : (
            <div key={k.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600 }}>{k.question}</div>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{k.answer}</div>
              {editable && (
                <div style={{ marginTop: 8 }}>
                  <button className="secondary" onClick={() => startEdit(k)} style={{ marginRight: 8 }}>
                    Edit
                  </button>
                  <button className="danger" onClick={() => remove(k.id)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          )
        )}
        {!entries.length && <div className="empty-state">No entries yet.</div>}
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add entry</h3>
          <form onSubmit={add}>
            <div className="field">
              <label>Question</label>
              <input value={question} onChange={(e) => setQuestion(e.target.value)} required />
            </div>
            <div className="field">
              <label>Answer</label>
              <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} required />
            </div>
            <button type="submit">Add</button>
          </form>
        </div>
      )}
    </div>
  );
}
