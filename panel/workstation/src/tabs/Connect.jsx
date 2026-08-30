import React from 'react';

export default function Connect() {
  return (
    <div>
      <h1>WhatsApp & payment</h1>
      <p className="subtitle">Connected after the business is built, not before.</p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Why not now</h3>
        <p>
          A WhatsApp number needs a real webhook URL to verify against, and that URL only exists once this business has its own live
          address. Same idea for payment: Paystack needs a real business to attach the keys to. Build first, connect right after — it's
          the very next thing you do, from the same place you build everything else.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>What happens after you build</h3>
        <ol style={{ paddingLeft: 20, lineHeight: 1.8 }}>
          <li>The new business shows up in Dash OS's client list, with its own live web address.</li>
          <li>
            Click <strong>Manage</strong> next to it, then <strong>Add WhatsApp</strong> — paste the Meta access token, phone number ID,
            and webhook verify token once you have them from Meta Business.
          </li>
          <li>
            Same panel, <strong>Add payment</strong> — paste the Paystack secret and public keys once that account is approved.
          </li>
        </ol>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>The parts that stay manual, on purpose</h3>
        <p>Meta's Business verification and Paystack's KYC happen on their own dashboards — nothing here can script around that.</p>
      </div>
    </div>
  );
}
