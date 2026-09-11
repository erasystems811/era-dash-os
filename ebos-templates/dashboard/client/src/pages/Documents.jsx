import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Documents() {
  const [docs, setDocs] = useState(null);

  useEffect(() => {
    api.get('/documents').then(setDocs);
  }, []);

  if (!docs) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Receipts</h1>
          <p className="subtitle">Every receipt the bot has generated.</p>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td style={{ textTransform: 'capitalize' }}>{d.type}</td>
                <td>{new Date(d.created_at).toLocaleString()}</td>
                <td>
                  <a href={d.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
            {!docs.length && (
              <tr>
                <td colSpan={3} className="empty-state">
                  Nothing generated yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
