import React, { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useStaff } from '../StaffContext.jsx';
import { api } from '../api.js';

// Three steps: pick a branch (skipped entirely below two branches -- same
// "invisible until needed" rule Layout.jsx's own scope switcher follows),
// pick a name (buttons, not a dropdown -- this is meant to work on a
// shared/kiosk-style touch device, not typed), enter the 4-digit PIN.
export default function PinLogin() {
  const { staff, loginWithPin } = useStaff();
  const [branches, setBranches] = useState(null); // null = still loading
  const [branchId, setBranchId] = useState(null);
  const [people, setPeople] = useState([]);
  const [staffId, setStaffId] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .get('/pin-login/branches')
      .then((d) => {
        setBranches(d.branches);
        // Single-branch business: nothing to pick, skip straight to names.
        if (d.branches.length === 1) setBranchId(d.branches[0].id);
      })
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    if (!branchId) return;
    api
      .get(`/pin-login/staff?branch_id=${branchId}`)
      .then((d) => setPeople(d.staff))
      .catch(() => setPeople([]));
  }, [branchId]);

  if (staff) return <Navigate to="/" replace />;

  async function submitPin(nextPin) {
    setError(null);
    setLoading(true);
    try {
      await loginWithPin(branchId, staffId, nextPin);
    } catch (err) {
      setError(err.message);
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  function pressDigit(d) {
    if (loading) return;
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) submitPin(next);
  }

  function backspace() {
    setPin((p) => p.slice(0, -1));
  }

  if (branches === null) return <div className="login-screen" />;

  // Step 1: branch (only ever shown for a multi-branch business).
  if (branches.length > 1 && !branchId) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>EBOS</h1>
          <p>Which branch are you at?</p>
          <div className="pin-name-list">
            {branches.map((b) => (
              <button key={b.id} onClick={() => setBranchId(b.id)}>
                {b.name}
              </button>
            ))}
          </div>
          <p style={{ textAlign: 'center', marginTop: '1rem' }}>
            <Link to="/login">Manager? Log in with email and password</Link>
          </p>
        </div>
      </div>
    );
  }

  // Step 2: name.
  if (!staffId) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>EBOS</h1>
          <p>Which one is you?</p>
          <div className="pin-name-list">
            {people.map((p) => (
              <button key={p.id} onClick={() => setStaffId(p.id)}>
                {p.name}
              </button>
            ))}
            {people.length === 0 && <p className="muted">No staff set up for this branch yet -- ask your manager.</p>}
          </div>
          <p style={{ textAlign: 'center', marginTop: '1rem' }}>
            <Link to="/login">Manager? Log in with email and password</Link>
          </p>
        </div>
      </div>
    );
  }

  // Step 3: PIN pad.
  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>EBOS</h1>
        <p>Enter your 4-digit PIN</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="pin-dots">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={i < pin.length ? 'filled' : ''} />
          ))}
        </div>
        <div className="pin-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
            k === '' ? (
              <span key={i} />
            ) : (
              <button key={i} disabled={loading} onClick={() => (k === '⌫' ? backspace() : pressDigit(k))}>
                {k}
              </button>
            )
          )}
        </div>
        <p style={{ textAlign: 'center', marginTop: '1rem' }}>
          <button className="link-button" onClick={() => setStaffId(null)}>
            Not you? Pick a different name
          </button>
        </p>
      </div>
    </div>
  );
}
