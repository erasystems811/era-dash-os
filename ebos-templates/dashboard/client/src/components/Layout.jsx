import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStaff } from '../StaffContext.jsx';
import { useScope } from '../ScopeContext.jsx';
import { api } from '../api.js';

const BASE_NAV = [
  { to: '/', label: 'Orders', end: true },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/branches', label: 'Branches' },
  { to: '/conversations', label: 'Conversations' },
  { to: '/knowledge-base', label: 'Knowledge base' },
  { to: '/documents', label: 'Documents' },
  { to: '/staff', label: 'Roles and numbers' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const { staff, logout } = useStaff();
  const { scope, setScope, branches, locked } = useScope();
  const [businessName, setBusinessName] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  // Delivery (own_riders mode) is an ERA-switched add-on -- off by default,
  // and "off" must be genuinely inert: with mode !== 'own_riders', this nav
  // item doesn't exist in the DOM at all, not just hidden, exactly the same
  // "no navigation item appears" rule the branch scope switcher above
  // already follows.
  const [deliveryMode, setDeliveryMode] = useState('none');
  // Voice ordering add-on -- same "genuinely inert while off" rule as
  // deliveryMode above.
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const location = useLocation();
  // Zero DOM below one branch, not just hidden -- a single-location
  // business must not be able to tell this feature exists at all. Also
  // never shown to a branch-locked staff member, regardless of how many
  // branches the business has -- "no branch control anywhere in the
  // interface" is the whole point of locking them, not a default to
  // override.
  const showScopeSwitcher = branches.length > 1 && !locked;

  const addOnItems = [
    ...(deliveryMode === 'own_riders' ? [{ to: '/delivery', label: 'Delivery' }] : []),
    ...(voiceEnabled ? [{ to: '/voice', label: 'Voice' }] : []),
  ];
  const NAV = addOnItems.length ? [...BASE_NAV.slice(0, 2), ...addOnItems, ...BASE_NAV.slice(2)] : BASE_NAV;

  useEffect(() => {
    api.get('/business').then((b) => setBusinessName(b?.name || ''));
    api.get('/delivery-config').then((c) => setDeliveryMode(c?.mode || 'none'));
    api.get('/voice-config').then((c) => setVoiceEnabled(Boolean(c?.enabled)));
  }, []);

  // A route change is the clearest signal the user picked something on
  // mobile -- close the drawer so the next screen isn't hidden behind it.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <button className="nav-toggle" aria-label="Open menu" onClick={() => setNavOpen(true)}>
          ☰
        </button>
        <div className="mobile-header-brand">{businessName || 'EBOS'}</div>
      </header>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">EB</span>
          <div>
            EBOS
            <small>{businessName}</small>
          </div>
        </div>
        {showScopeSwitcher && (
          <div className="scope-switcher">
            <label>Viewing</label>
            <select value={scope === 'all' ? 'all' : scope || ''} onChange={(e) => setScope(e.target.value || null)}>
              <option value="">All orders</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              <option value="all">Compare branches</option>
            </select>
          </div>
        )}
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="staff-info">
          <div className="name">{staff?.name}</div>
          <div>{staff?.role}</div>
          <button onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
