import React, { useState } from 'react';

const EMPTY_FIELD = { key: '', label: '', question: '', type: 'text', choices: '', examples: '', required_for_state: 'collect_info' };
const EMPTY_KB = { question: '', answer: '' };

export default function TrainTheBot({ botFields, setBotFields, botStates, knowledgeBase, setKnowledgeBase }) {
  const [fieldForm, setFieldForm] = useState(EMPTY_FIELD);
  const [kbForm, setKbForm] = useState(EMPTY_KB);

  function addField(e) {
    e.preventDefault();
    setBotFields([
      ...botFields,
      {
        ...fieldForm,
        choices: fieldForm.choices ? fieldForm.choices.split(',').map((s) => s.trim()) : [],
        examples: fieldForm.examples ? fieldForm.examples.split(',').map((s) => s.trim()) : [],
      },
    ]);
    setFieldForm(EMPTY_FIELD);
  }

  function removeField(key) {
    setBotFields(botFields.filter((f) => f.key !== key));
  }

  function addKb(e) {
    e.preventDefault();
    setKnowledgeBase([...knowledgeBase, kbForm]);
    setKbForm(EMPTY_KB);
  }

  function removeKb(i) {
    setKnowledgeBase(knowledgeBase.filter((_, idx) => idx !== i));
  }

  return (
    <div>
      <h1>Train the bot</h1>
      <p className="subtitle">What it asks, and what counts as a valid answer.</p>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Question asked</th>
              <th>Type</th>
              <th>Choices</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {botFields.map((f) => (
              <tr key={f.key}>
                <td>{f.key}</td>
                <td>{f.question}</td>
                <td>{f.type}</td>
                <td>{(f.choices || []).join(', ')}</td>
                <td>
                  <button type="button" className="danger" onClick={() => removeField(f.key)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!botFields.length && (
              <tr>
                <td colSpan={5} style={{ color: 'var(--text-muted)' }}>
                  Picking a business type on the Business details tab starts you off with the usual questions for that type. Add or remove from there.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add a question</h3>
        <form onSubmit={addField}>
          <div className="form-row">
            <div className="field">
              <label>Field key (no spaces, e.g. delivery_address)</label>
              <input value={fieldForm.key} onChange={(e) => setFieldForm({ ...fieldForm, key: e.target.value })} required />
            </div>
            <div className="field">
              <label>Label</label>
              <input value={fieldForm.label} onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })} required />
            </div>
          </div>
          <div className="field">
            <label>Question the bot asks</label>
            <input value={fieldForm.question} onChange={(e) => setFieldForm({ ...fieldForm, question: e.target.value })} required />
          </div>
          <div className="form-row">
            <div className="field">
              <label>Type</label>
              <select value={fieldForm.type} onChange={(e) => setFieldForm({ ...fieldForm, type: e.target.value })}>
                <option value="text">Text</option>
                <option value="date">Date</option>
                <option value="boolean">Yes / no</option>
                <option value="choice">Choice</option>
              </select>
            </div>
            <div className="field">
              <label>Required for state</label>
              <select value={fieldForm.required_for_state} onChange={(e) => setFieldForm({ ...fieldForm, required_for_state: e.target.value })}>
                {botStates.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {fieldForm.type === 'choice' && (
            <div className="field">
              <label>Choices (comma separated)</label>
              <input value={fieldForm.choices} onChange={(e) => setFieldForm({ ...fieldForm, choices: e.target.value })} />
            </div>
          )}
          <button type="submit">Add question</button>
        </form>
      </div>

      <h1 style={{ marginTop: 32 }}>Knowledge base</h1>
      <p className="subtitle">What the bot answers customer questions from. Nothing outside this list gets guessed.</p>

      <div className="card">
        {knowledgeBase.map((k, i) => (
          <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600 }}>{k.question}</div>
            <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{k.answer}</div>
            <button type="button" className="danger" style={{ marginTop: 8 }} onClick={() => removeKb(i)}>
              Delete
            </button>
          </div>
        ))}
        {!knowledgeBase.length && <p style={{ color: 'var(--text-muted)' }}>No entries yet.</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add entry</h3>
        <form onSubmit={addKb}>
          <div className="field">
            <label>Question</label>
            <input value={kbForm.question} onChange={(e) => setKbForm({ ...kbForm, question: e.target.value })} required />
          </div>
          <div className="field">
            <label>Answer</label>
            <textarea rows={3} value={kbForm.answer} onChange={(e) => setKbForm({ ...kbForm, answer: e.target.value })} required />
          </div>
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
  );
}
