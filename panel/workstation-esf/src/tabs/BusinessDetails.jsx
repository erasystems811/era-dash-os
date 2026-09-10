import React, { useState } from 'react';

export default function BusinessDetails({ subdomain, setSubdomain, size, setSize, business, setBusiness, owner, setOwner }) {
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(null);

  function useMyLocation() {
    setLocateError(null);
    if (!navigator.geolocation) {
      setLocateError('This browser can’t get your location. Enter it manually below.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusiness((b) => ({ ...b, lat: String(pos.coords.latitude), lng: String(pos.coords.longitude) }));
        setLocating(false);
      },
      () => {
        setLocateError('Could not get your location -- check the browser allowed it, or enter it manually below.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  return (
    <div>
      <h1>Business details</h1>
      <p className="subtitle">This business gets its own server, its own database, and its own WhatsApp number -- nothing here is shared with any other business.</p>

      <div className="card">
        <div className="field">
          <label>Business name</label>
          <input value={business.name} onChange={(e) => setBusiness({ ...business, name: e.target.value })} required />
        </div>
        <div className="field">
          <label>Subdomain (blank picks one automatically, e.g. acme.erasystems.com.ng)</label>
          <input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="acme" />
        </div>
        <div className="form-row">
          <div className="field">
            <label>Server size</label>
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </div>
          <div className="field">
            <label>Reception / business phone</label>
            <input value={business.owner_phone} onChange={(e) => setBusiness({ ...business, owner_phone: e.target.value })} placeholder="+234..." />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Clock-in location</h3>
        <p className="hint">Only needed if any task uses a Location step. Only fill this in while you're physically at the business.</p>
        <button type="button" className="secondary" onClick={useMyLocation} disabled={locating}>
          {locating ? 'Getting your location...' : '📍 Use my current location'}
        </button>
        {locateError && <p className="hint" style={{ color: 'var(--danger)' }}>{locateError}</p>}
        {business.lat && business.lng && (
          <p className="hint" style={{ marginTop: 10 }}>
            Location set: {Number(business.lat).toFixed(5)}, {Number(business.lng).toFixed(5)}
          </p>
        )}
        <div className="field" style={{ marginTop: 14 }}>
          <label>Default radius (meters) -- how far from this point still counts as "at the business"</label>
          <input value={business.radius_m} onChange={(e) => setBusiness({ ...business, radius_m: e.target.value })} />
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Owner login</h3>
        <p className="hint">A password is generated automatically and shown once the business is built.</p>
        <div className="field">
          <label>Owner email</label>
          <input type="email" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} required />
        </div>
      </div>
    </div>
  );
}
