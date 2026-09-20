import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import { compressImageToDataUrl } from '../imageUpload.js';
import Loading from '../components/Loading.jsx';

export default function Settings() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [business, setBusiness] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [currentPasswordForEmail, setCurrentPasswordForEmail] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailError, setEmailError] = useState(null);
  const [emailSaved, setEmailSaved] = useState(false);
  const [instagramStatus, setInstagramStatus] = useState(null);
  const [waProfile, setWaProfile] = useState(null);
  const [waSaved, setWaSaved] = useState(false);
  const [waError, setWaError] = useState(null);
  const [uploadingField, setUploadingField] = useState(null);
  // Chidera, 2026-09-16: "let it never happen again" -- the cover photo is
  // what actually attaches to the WhatsApp menu-link message itself (see
  // flow.js's businessCoverPhotoUrl), so a low-res one there is the most
  // visible place this can go wrong. Keyed by field so logo/cover warn
  // independently.
  const [photoWarnings, setPhotoWarnings] = useState({});
  const [hoursOpen, setHoursOpen] = useState('');
  const [hoursClose, setHoursClose] = useState('');
  const [hoursSaved, setHoursSaved] = useState(false);
  const [hoursError, setHoursError] = useState(null);
  // Chidera, 2026-09-20: "a business can choose pos, flutterwave,
  // paystack, or manual" -- Flutterwave left out of the picker on
  // purpose ("leave flutterwave out for now"), same reasoning as the DB
  // check constraint (payment_config's own schema comment). Own state,
  // own save/load, same as Opening hours below -- a separate table
  // (payment_config), not part of the big business-details form.
  const [paymentConfig, setPaymentConfig] = useState(null);
  const [paymentConfigSaved, setPaymentConfigSaved] = useState(false);
  const [paymentConfigError, setPaymentConfigError] = useState(null);

  useEffect(() => {
    api.get('/business').then(setBusiness);
    api.get('/settings/instagram-status').then(setInstagramStatus);
    api.get('/whatsapp-profile').then(setWaProfile).catch((err) => setWaError(err.message));
    api.get('/business-hours').then((h) => {
      setHoursOpen(h.opening_hours?.open || '');
      setHoursClose(h.opening_hours?.close || '');
    });
    api.get('/payment-config').then(setPaymentConfig);
  }, []);

  if (!business) return <Loading />;

  async function save(e) {
    e.preventDefault();
    setSaved(false);
    setSaveError(null);
    try {
      const updated = await api.post('/business', business);
      setBusiness(updated);
      setSaved(true);
    } catch (err) {
      // Was unhandled before -- a save that failed (e.g. a photo too large
      // for the server to accept) just did nothing visible at all, no
      // error and no "Saved.", which looked exactly like the upload was
      // silently ignored. Found live, 2026-09-10: "i put a cover photo
      // and its not showing" -- it never actually saved.
      setSaveError(err.message);
    }
  }

  function set(key, value) {
    setBusiness((b) => ({ ...b, [key]: value }));
  }

  // Saves immediately, not just into local state waiting on the page's
  // own Save button -- Chidera 2026-09-10, after the cover photo still
  // wasn't saving even once uploads could go through: "is the back end
  // really connected to the chat?" Two real ways the old
  // set(...)-then-wait-for-Save version could lose the photo entirely: a
  // click on Save that lands while compression is still in flight (the
  // photo genuinely isn't in `business` yet to submit), or just never
  // clicking Save at all after picking the file, since nothing said that
  // step was still required. Posting straight away removes both.
  async function uploadBusinessImage(field, file) {
    setSaved(false);
    setSaveError(null);
    setUploadingField(field);
    setPhotoWarnings((w) => ({ ...w, [field]: null }));
    try {
      const { dataUrl, isLowRes } = await compressImageToDataUrl(file);
      const updated = await api.post('/business', { ...business, [field]: dataUrl });
      setBusiness(updated);
      setSaved(true);
      if (isLowRes) {
        setPhotoWarnings((w) => ({
          ...w,
          [field]: 'This photo is quite small -- it may look blurry wherever it shows (the menu page, or the photo attached to the WhatsApp menu message). A closer, higher-resolution photo will look sharper.',
        }));
      }
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setUploadingField(null);
    }
  }

  async function onLogoChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    await uploadBusinessImage('logo_data_url', file);
  }

  async function onCoverPhotoChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    // maxDimension 1600 is already comfortably wider than the menu header
    // ever renders at, and well under the size that made a raw upload
    // here fail (~20MB) in the first place.
    await uploadBusinessImage('cover_photo_data_url', file);
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

  async function saveHours(e) {
    e.preventDefault();
    setHoursError(null);
    setHoursSaved(false);
    try {
      const updated = await api.post('/business-hours', { open: hoursOpen || null, close: hoursClose || null });
      setHoursOpen(updated.opening_hours?.open || '');
      setHoursClose(updated.opening_hours?.close || '');
      setHoursSaved(true);
    } catch (err) {
      setHoursError(err.message);
    }
  }

  async function savePaymentConfig(e) {
    e.preventDefault();
    setPaymentConfigError(null);
    setPaymentConfigSaved(false);
    try {
      const updated = await api.post('/payment-config', paymentConfig);
      setPaymentConfig(updated);
      setPaymentConfigSaved(true);
    } catch (err) {
      setPaymentConfigError(err.message);
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

  async function changeEmail(e) {
    e.preventDefault();
    setEmailError(null);
    setEmailSaved(false);
    try {
      await api.post('/change-email', { currentPassword: currentPasswordForEmail, newEmail });
      setCurrentPasswordForEmail('');
      setNewEmail('');
      setEmailSaved(true);
    } catch (err) {
      setEmailError(err.message);
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
        {saveError && <div style={{ color: 'var(--danger, #c0392b)', marginBottom: 12, fontSize: 13 }}>Could not save: {saveError}</div>}
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
              {editable && <input type="file" accept="image/*" onChange={onLogoChange} disabled={uploadingField === 'logo_data_url'} />}
              {uploadingField === 'logo_data_url' && <p className="hint">Uploading...</p>}
              {photoWarnings.logo_data_url && <p className="hint" style={{ color: 'var(--warn, #b4700f)' }}>{photoWarnings.logo_data_url}</p>}
            </div>
            <div className="field">
              <label>Brand colour</label>
              <input type="color" value={business.brand_color || '#111827'} onChange={(e) => set('brand_color', e.target.value)} disabled={!editable} style={{ padding: 2, height: 38 }} />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Web menu cover photo</label>
              <p className="hint">Shown as the photo attached to the WhatsApp greeting, and across the top of the web menu. Saves as soon as you pick a file -- no separate Save needed.</p>
              {business.cover_photo_data_url && (
                <img src={business.cover_photo_data_url} alt="Cover" style={{ width: '100%', maxWidth: 320, height: 120, objectFit: 'cover', borderRadius: 8, display: 'block', marginBottom: 8 }} />
              )}
              {editable && <input type="file" accept="image/*" onChange={onCoverPhotoChange} disabled={uploadingField === 'cover_photo_data_url'} />}
              {uploadingField === 'cover_photo_data_url' && <p className="hint">Uploading...</p>}
              {photoWarnings.cover_photo_data_url && <p className="hint" style={{ color: 'var(--warn, #b4700f)' }}>{photoWarnings.cover_photo_data_url}</p>}
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

      {paymentConfig && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>How you get paid</h3>
          <p className="hint">
            POS: customers pick Transfer (we quote the account below) or Card (they tap it on the terminal). Either way, payment
            confirms automatically, no staff step. Paystack: a real payment link. Manual: the bank details above, plus a photo of
            proof. Leave unset to keep things exactly as they are today.
          </p>
          {paymentConfigSaved && <div className="success-banner">Saved.</div>}
          {paymentConfigError && <div className="error-banner">Could not save: {paymentConfigError}</div>}
          <form onSubmit={savePaymentConfig}>
            <div className="form-row">
              <div className="field">
                <label>Provider</label>
                <select
                  value={paymentConfig.provider || ''}
                  onChange={(e) => setPaymentConfig({ ...paymentConfig, provider: e.target.value || null })}
                  disabled={!editable}
                >
                  <option value="">Not set (keep current behaviour)</option>
                  <option value="pos">POS</option>
                  <option value="paystack">Paystack</option>
                  <option value="manual">Manual</option>
                </select>
              </div>
            </div>
            {paymentConfig.provider === 'pos' && (
              <div className="form-row">
                <div className="field">
                  <label>Transfer bank name</label>
                  <input
                    value={paymentConfig.transfer_bank_name || ''}
                    onChange={(e) => setPaymentConfig({ ...paymentConfig, transfer_bank_name: e.target.value })}
                    disabled={!editable}
                  />
                </div>
                <div className="field">
                  <label>Transfer account number</label>
                  <input
                    value={paymentConfig.transfer_account_number || ''}
                    onChange={(e) => setPaymentConfig({ ...paymentConfig, transfer_account_number: e.target.value })}
                    disabled={!editable}
                  />
                </div>
                <div className="field">
                  <label>Transfer account name</label>
                  <input
                    value={paymentConfig.transfer_account_name || ''}
                    onChange={(e) => setPaymentConfig({ ...paymentConfig, transfer_account_name: e.target.value })}
                    disabled={!editable}
                  />
                </div>
              </div>
            )}
            {editable && <button type="submit">Save</button>}
          </form>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Opening hours</h3>
        <p className="hint">
          While you're closed, customers who message get told when you open and are messaged again the moment you do -- instead of
          the bot replying like you're open. Leave both blank to stay always open (the default).
        </p>
        {hoursSaved && <div className="success-banner">Saved.</div>}
        {hoursError && <div className="error-banner">Could not save: {hoursError}</div>}
        <form onSubmit={saveHours}>
          <div className="form-row">
            <div className="field">
              <label>Opens at</label>
              <input type="time" value={hoursOpen} onChange={(e) => setHoursOpen(e.target.value)} disabled={!editable} />
            </div>
            <div className="field">
              <label>Closes at</label>
              <input type="time" value={hoursClose} onChange={(e) => setHoursClose(e.target.value)} disabled={!editable} />
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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change your login email</h3>
        <p className="hint">Useful if the account was set up with a placeholder email, or ownership is handing over to someone else.</p>
        {emailError && <div className="error-banner">{emailError}</div>}
        {emailSaved && <div className="success-banner">Email changed. Use the new email next time you log in.</div>}
        <form onSubmit={changeEmail}>
          <div className="form-row">
            <div className="field">
              <label>Current password</label>
              <input type="password" value={currentPasswordForEmail} onChange={(e) => setCurrentPasswordForEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label>New email</label>
              <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
            </div>
          </div>
          <button type="submit">Change email</button>
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
