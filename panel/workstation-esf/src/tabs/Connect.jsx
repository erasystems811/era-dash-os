import React from 'react';

export default function Connect({ whatsapp, setWhatsapp }) {
  return (
    <div>
      <h1>WhatsApp</h1>
      <p className="subtitle">This business gets its own WhatsApp number -- never shared with any other business.</p>

      <div className="card">
        <div className="field checkbox-row">
          <input type="checkbox" id="whatsapp" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} />
          <label htmlFor="whatsapp" style={{ margin: 0 }}>
            Provision WhatsApp infrastructure for this business now
          </label>
        </div>
        <p className="hint">
          This reserves the number and webhook on our side. Connecting it to a real Meta Business account -- pasting the access token and phone
          number ID -- happens after the build, from the client list in Dash OS, once those credentials are ready.
        </p>
      </div>
    </div>
  );
}
