import React from 'react';
import { BUSINESS_TYPES, DEFAULT_BOT_FIELDS, OTHER_TYPE } from '../defaults.js';

// True if the current question list is still exactly one of the built-in
// presets (or empty) -- i.e. nobody has customised it yet, so switching
// type is safe to re-seed. Once it diverges from every preset, it's someone
// else's work now and a type change should never touch it again.
function isUntouchedDefault(fields) {
  if (fields.length === 0) return true;
  return Object.values(DEFAULT_BOT_FIELDS).some((preset) => JSON.stringify(preset) === JSON.stringify(fields));
}

export default function BusinessDetails({ subdomain, setSubdomain, size, setSize, business, setBusiness, owner, setOwner, botFields, setBotFields }) {
  const isKnownType = BUSINESS_TYPES.some((t) => t.value === business.type);

  function set(key, value) {
    setBusiness((b) => ({ ...b, [key]: value }));
  }

  function changeType(type) {
    set('type', type);
    if (isUntouchedDefault(botFields)) setBotFields(DEFAULT_BOT_FIELDS[type] || []);
  }

  function pickFromDropdown(value) {
    if (value === OTHER_TYPE) {
      // Custom type has no built-in questions -- leave whatever's on Train
      // the bot alone (same "don't clobber" rule), just clear the type
      // name so it's obviously not one of the presets until they type one.
      set('type', '');
    } else {
      changeType(value);
    }
  }

  function onLogoChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set('logo_data_url', reader.result);
    reader.readAsDataURL(file);
  }

  return (
    <div>
      <h1>Business details</h1>
      <p className="subtitle">What this business is, and who its first owner login belongs to.</p>

      <div className="card">
        <div className="form-row">
          <div className="field">
            <label>Business name</label>
            <input value={business.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sunset Grill" required />
          </div>
          <div className="field">
            <label>Business type</label>
            <select value={isKnownType ? business.type : OTHER_TYPE} onChange={(e) => pickFromDropdown(e.target.value)}>
              {BUSINESS_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
              <option value={OTHER_TYPE}>Other — type your own</option>
            </select>
            {!isKnownType && (
              <input
                style={{ marginTop: 8 }}
                value={business.type}
                onChange={(e) => set('type', e.target.value)}
                placeholder="e.g. car wash, tailoring, laundry"
                autoFocus
              />
            )}
          </div>
        </div>
        {!isKnownType && (
          <p className="hint">
            No built-in starter questions for a type like this — add them yourself on the Train the bot tab, same as any business.
          </p>
        )}
        <div className="form-row">
          <div className="field">
            <label>Address</label>
            <input value={business.address} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="field">
            <label>Business phone number</label>
            <input value={business.phone_number} onChange={(e) => set('phone_number', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>
            <input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={business.delivery_enabled} onChange={(e) => set('delivery_enabled', e.target.checked)} />
            This business does delivery
          </label>
        </div>
        <div className="form-row">
          <div className="field">
            <label>WhatsApp connection</label>
            <select value={business.whatsapp_connection} onChange={(e) => set('whatsapp_connection', e.target.value)}>
              <option value="api_only">API only (staff reply from the dashboard)</option>
              <option value="coexistence">Coexistence (staff reply from their own phone)</option>
            </select>
          </div>
          <div className="field">
            <label>Handover number (where escalations go)</label>
            <input value={business.handover_number} onChange={(e) => set('handover_number', e.target.value)} />
          </div>
        </div>
        <h3>Branding</h3>
        <p className="hint">Shown on this business's own invoices and receipts -- their own logo and colour, not a shared one.</p>
        <div className="form-row">
          <div className="field">
            <label>Logo</label>
            {business.logo_data_url && <img src={business.logo_data_url} alt="Logo" style={{ maxHeight: 40, display: 'block', marginBottom: 8 }} />}
            <input type="file" accept="image/*" onChange={onLogoChange} />
          </div>
          <div className="field">
            <label>Brand colour</label>
            <input type="color" value={business.brand_color} onChange={(e) => set('brand_color', e.target.value)} style={{ padding: 2, height: 38 }} />
          </div>
        </div>
        <h3>Payment</h3>
        <div className="form-row">
          <div className="field">
            <label>Bank name</label>
            <input value={business.bank_name} onChange={(e) => set('bank_name', e.target.value)} />
          </div>
          <div className="field">
            <label>Account number</label>
            <input value={business.bank_account_number} onChange={(e) => set('bank_account_number', e.target.value)} />
          </div>
          <div className="field">
            <label>Account name</label>
            <input value={business.bank_account_name} onChange={(e) => set('bank_account_name', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Owner login</h3>
        <p className="hint">Created automatically once you build. The password is generated and shown once, at the end.</p>
        <div className="form-row">
          <div className="field">
            <label>Owner name</label>
            <input value={owner.name} onChange={(e) => setOwner({ ...owner, name: e.target.value })} required />
          </div>
          <div className="field">
            <label>Owner email (their login)</label>
            <input type="email" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} required />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Deployment</h3>
        <div className="form-row">
          <div className="field">
            <label>Subdomain (optional, auto-generated from the business name if blank)</label>
            <input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="e.g. sunset-grill" />
          </div>
          <div className="field">
            <label>Server size</label>
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
