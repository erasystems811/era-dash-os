import React, { useState } from 'react';

const EMPTY = { name: '', phone: '', role: '', shift_start: '', shift_end: '' };

export default function Staff({ staff, setStaff }) {
  const [form, setForm] = useState(EMPTY);
  const [editingIndex, setEditingIndex] = useState(null);

  function submit(e) {
    e.preventDefault();
    if (editingIndex === null) setStaff([...staff, form]);
    else setStaff(staff.map((s, i) => (i === editingIndex ? form : s)));
    setForm(EMPTY);
    setEditingIndex(null);
  }

  function edit(i) {
    setForm(staff[i]);
    setEditingIndex(i);
  }

  function remove(i) {
    setStaff(staff.filter((_, idx) => idx !== i));
    if (editingIndex === i) {
      setForm(EMPTY);
      setEditingIndex(null);
    }
  }

  return (
    <div>
      <h1>Staff</h1>
      <p className="subtitle">Everyone who will get tasks over WhatsApp. Each staff member's tasks are their own -- nobody's task list is fixed.</p>

      {staff.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Role</th>
                <th>Shift</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s, i) => (
                <tr key={i}>
                  <td>{s.name}</td>
                  <td>{s.phone}</td>
                  <td>{s.role}</td>
                  <td>{s.shift_start && s.shift_end ? `${s.shift_start}-${s.shift_end}` : '—'}</td>
                  <td>
                    <button className="secondary" onClick={() => edit(i)}>
                      Edit
                    </button>{' '}
                    <button className="danger" onClick={() => remove(i)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{editingIndex === null ? 'Add a staff member' : 'Edit staff member'}</h3>
        <form onSubmit={submit}>
          <div className="form-row">
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>WhatsApp phone</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+234..." required />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Role (e.g. receptionist, cleaner)</label>
              <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} required />
            </div>
            <div className="field">
              <label>Shift start</label>
              <input type="time" value={form.shift_start} onChange={(e) => setForm({ ...form, shift_start: e.target.value })} />
            </div>
            <div className="field">
              <label>Shift end</label>
              <input type="time" value={form.shift_end} onChange={(e) => setForm({ ...form, shift_end: e.target.value })} />
            </div>
          </div>
          <button type="submit">{editingIndex === null ? 'Add staff member' : 'Save'}</button>
          {editingIndex !== null && (
            <button
              type="button"
              className="secondary"
              style={{ marginLeft: 8 }}
              onClick={() => {
                setForm(EMPTY);
                setEditingIndex(null);
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
