import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Today() {
  const [runs, setRuns] = useState(null);

  useEffect(() => {
    api.get('/today').then(setRuns);
  }, []);

  if (!runs) return null;

  const counts = { open: 0, complete: 0, blocked: 0, missed: 0 };
  for (const r of runs) counts[r.status] = (counts[r.status] || 0) + 1;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Today</h1>
          <p className="subtitle">Every task due today, across every staff member.</p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat-card warn">
          <div className="value">{counts.open}</div>
          <div className="label">Open</div>
        </div>
        <div className="stat-card success">
          <div className="value">{counts.complete}</div>
          <div className="label">Complete</div>
        </div>
        <div className="stat-card danger">
          <div className="value">{counts.blocked}</div>
          <div className="label">Blocked</div>
        </div>
        <div className="stat-card danger">
          <div className="value">{counts.missed}</div>
          <div className="label">Missed</div>
        </div>
      </div>

      <div className="card">
        {runs.length ? (
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Staff</th>
                <th>Status</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={i}>
                  <td>{r.task_name}</td>
                  <td>{r.staff_name}</td>
                  <td>
                    <span className={`badge ${r.status}`}>{r.status}</span>
                  </td>
                  <td>step {r.current_seq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No runs yet today.</div>
        )}
      </div>
    </div>
  );
}
