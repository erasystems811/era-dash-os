import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';

export default function Settings() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [business, setBusiness] = useState(null);
  const [saved, setSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [instagramStatus, setInstagramStatus] = useState(null);
  const [waProfile, setWaProfile] = useState(null);
  const [waSaved, setWaSaved] = useState(false);
  const [waError, setWaError] = useState(null);

  useEffect(() => {
    api.get('/business').then(setBusiness);
    api.get('/settings/instagram-status').then(setInstagramStatus);
    api.get('/whatsapp-profile').then(setWaProfile).catch((err) => setWaError(err.message));
  }, []);

  if (!business) return null;

  async function save(e) {
    e.preventDefault();
    setSaved(false);
    const updated = await api.post('/business', business);
    setBusiness(updated);
    setSaved(true);
  }

  function set(key, value) {
    setBusiness((b) => ({ ...b, [key]: value }));
  }

  function onLogoChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set('logo_data_url', reader.result);
    reader.readAsDataURL(file);
  }

  function setWa(key, value) {
    setWaProfile((p) => ({ ...p, [key]: value }));
  }

  function setWaWebsite(index, value) {
    setWaProfile((p) => {
      const websites = [...(p.websites || [])];
      websites[index] = value;
      return { ...p, websites };
    });
  }

  async function saveWaProfile(e) {
    e.preventDefault();
    setWaError(null);
    setWaSaved(false);
    try {
      const updated = await api.post('/whatsapp-profile', {
        about: waProfile.about || '',
        description: waProfile.description || '',
        email: waProfile.email || '',
        address: waProfile.address || '',
        vertical: waProfile.vertical || 'UNDEFINED',
        websites: (waProfile.websites || []).filter(Boolean),
      });
      setWaProfile(updated);
      setWaSaved(true);
    } catch (err) {
      setWaError(err.message);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSaved(false);
    try {
      await api.post('/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setPasswordSaved(true);
    } catch (err) {
      setPasswordError(err.message);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Business details, delivery, and how WhatsApp handover works.</p>
        </div>
      </div>

      <div className="card">
        {saved && <div style={{ color: 'var(--success)', marginBottom: 12, fontSize: 13 }}>Saved.</div>}
        <form onSubmit={save}>
          <div className="form-row">
            <div className="field">
              <label>Business name</label>
              <input value={business.name || ''} onChange={(e) => set('name', e.target.value)} disabled={!editable} required />
            </div>
            <div className="field">
              <label>Type</label>
              <input value={business.type} disabled />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Address</label>
              <input value={business.address || ''} onChange={(e) => set('address', e.target.value)} disabled={!editable} />
            </div>
            <div className="field">
              <label>Phone number</label>
              <input value={business.phone_number || ''} onChange={(e) => set('phone_number', e.target.value)} disabled={!editable} />
            </div>
          </div>
          <div className="field">
            <label>
              <input
                type="checkbox"
                style={{ width: 'auto', marginRight: 8 }}
                checked={business.delivery_enabled}
                onChange={(e) => set('delivery_enabled', e.target.checked)}
                disabled={!editable}
              />
              Delivery enabled
            </label>
          </div>
          <div className="form-row">
            <div className="field">
              <label>WhatsApp connection</label>
              <select value={business.whatsapp_connection || ''} onChange={(e) => set('whatsapp_connection', e.target.value)} disabled={!editable}>
                <option value="">Not set</option>
                <option value="coexistence">Coexistence (staff reply from their own phone)</option>
                <option value="api_only">API only (staff reply from this dashboard)</option>
              </select>
            </div>
            <div className="field">
              <label>Handover number</label>
              <input value={business.handover_number || ''} onChange={(e) => set('handover_number', e.target.value)} disabled={!editable} />
            </div>
          </div>
          <h3>Branding</h3>
          <p className="hint">Shown on your invoices and receipts.</p>
          <div className="form-row">
            <div className="field">
              <label>Logo</label>
              {business.logo_data_url && <img src={business.logo_data_url} alt="Logo" style={{ maxHeight: 40, display: 'block', marginBottom: 8 }} />}
              {editable && <input type="file" accept="image/*" onChange={onLogoChange} />}
            </div>
            <div className="field">
              <label>Brand colour</label>
              <input type="color" value={business.brand_color || '#111827'} onChange={(e) => set('brand_color', e.target.value)} disabled={!editable} style={{ padding: 2, height: 38 }} />
            </div>
          </div>
          <h3>Payment</h3>
          <div className="form-row">
            <div className="field">
              <label>Bank name</label>
              <input value={business.bank_name || ''} onChange={(e) => set('bank_name', e.target.value)} disabled={!editable} />
            </div>
            <div className="field">
              <label>Account number</label>
              <input value={business.bank_account_number || ''} onChange={(e) => set('bank_account_number', e.target.value)} disabled={!editable} />
            </div>
            <div className="field">
              <label>Account name</label>
              <input value={business.bank_account_name || ''} onChange={(e) => set('bank_account_name', e.target.value)} disabled={!editable} />
            </div>
          </div>
          {editable && <button type="submit">Save</button>}
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Connected channels</h3>
        {instagramStatus?.connected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {instagramStatus.profilePictureUrl && (
              <img src={instagramStatus.profilePictureUrl} alt="" style={{ width: 48, height: 48, borderRadius: '50%' }} />
            )}
            <div>
              <div style={{ fontWeight: 600 }}>@{instagramStatus.username}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{instagramStatus.name}</div>
            </div>
            <span className="badge active" style={{ marginLeft: 'auto' }}>
              Instagram connected
            </span>
          </div>
        ) : (
          <p className="hint">No Instagram account connected yet.</p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>WhatsApp Business Profile</h3>
        <p className="hint">
          What a customer sees when they tap your name/photo inside WhatsApp -- separate from the business details above, which only
          drive how the bot itself behaves. Your display name (the bold name at the top of the chat) can't be changed here -- Meta
          reviews name changes separately, so ask us to submit that if you ever need to change it.
        </p>
        {waError && <div className="error-banner">{waError}</div>}
        {waProfile?.sandbox && <div className="hint">Sandbox mode -- no real WhatsApp number connected yet, so there's nothing to load or save here.</div>}
        {waProfile && !waProfile.sandbox && (
          <form onSubmit={saveWaProfile}>
            {waSaved && <div className="success-banner">Saved to WhatsApp.</div>}
            <div className="form-row">
              <div className="field">
                <label>Category</label>
                <select value={waProfile.vertical || 'UNDEFINED'} onChange={(e) => setWa('vertical', e.target.value)} disabled={!editable}>
                  <option value="UNDEFINED">Not set</option>
                  <option value="RESTAURANT">Restaurant</option>
                  <option value="RETAIL">Retail</option>
                  <option value="GROCERY">Grocery</option>
                  <option value="HOTEL">Hotel</option>
                  <option value="BEAUTY">Beauty / Spa / Salon</option>
                  <option value="APPAREL">Clothing and Apparel</option>
                  <option value="PROF_SERVICES">Professional Services</option>
                  <option value="EVENT_PLAN">Event Planning</option>
                  <option value="HEALTH">Health</option>
                  <option value="TRAVEL">Travel</option>
                  <option value="EDU">Education</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div className="field">
                <label>About (short status line, max 139 characters)</label>
                <input value={waProfile.about || ''} maxLength={139} onChange={(e) => setWa('about', e.target.value)} disabled={!editable} />
              </div>
            </div>
            <div className="field">
              <label>Description (about your business, max 512 characters)</label>
              <textarea
                rows={3}
                maxLength={512}
                value={waProfile.description || ''}
                onChange={(e) => setWa('description', e.target.value)}
                disabled={!editable}
              />
            </div>
            <div className="form-row">
              <div className="field">
                <label>Email</label>
                <input type="email" value={waProfile.email || ''} onChange={(e) => setWa('email', e.target.value)} disabled={!editable} />
              </div>
              <div className="field">
                <label>Address</label>
                <input value={waProfile.address || ''} onChange={(e) => setWa('address', e.target.value)} disabled={!editable} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Website 1</label>
                <input value={(waProfile.websites || [])[0] || ''} onChange={(e) => setWaWebsite(0, e.target.value)} disabled={!editable} placeholder="https://..." />
              </div>
              <div className="field">
                <label>Website 2</label>
                <input value={(waProfile.websites || [])[1] || ''} onChange={(e) => setWaWebsite(1, e.target.value)} disabled={!editable} placeholder="https://..." />
              </div>
            </div>
            {editable && <button type="submit">Save to WhatsApp</button>}
          </form>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change your password</h3>
        {passwordError && <div className="error-banner">{passwordError}</div>}
        {passwordSaved && <div className="success-banner">Password changed.</div>}
        <form onSubmit={changePassword}>
          <div className="form-row">
            <div className="field">
              <label>Current password</label>
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            </div>
            <div className="field">
              <label>New password</label>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} required />
            </div>
          </div>
          <button type="submit">Change password</button>
        </form>
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Your data</h3>
          <p className="hint">
            Every customer, message, order, and menu item -- yours, exportable any time, whether or not you keep using this.
          </p>
          <a className="btn" href="/api/export" download>
            Download my data
          </a>
        </div>
      )}
    </div>
  );
}
