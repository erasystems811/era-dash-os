import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStaff, isPinTier } from '../StaffContext.jsx';
import { useScope } from '../ScopeContext.jsx';
import { api } from '../api.js';

// Order is Chidera's own explicit call, 2026-09-03: "orders-conversations-
// delivery-catalogue-knowledge base-branches-documents-roles and numbers-
// activity log-settings". Delivery/Voice aren't listed here since they're
// add-ons spliced in conditionally below (right after Conversations, so
// they land in the same spot the requested order puts Delivery).
const BASE_NAV = [
  { to: '/', label: 'Orders', end: true },
  { to: '/conversations', label: 'Conversations' },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/knowledge-base', label: 'Knowledge base' },
  { to: '/branches', label: 'Branches' },
  { to: '/documents', label: 'Documents' },
  { to: '/staff', label: 'Roles and numbers' },
  { to: '/activity-log', label: 'Activity log' },
  { to: '/settings', label: 'Settings' },
];

// Tier 3 (PIN) staff -- exactly these 5, nothing else, regardless of
// add-ons the business has on (Delivery/Voice included) or how many
// branches exist. No Branches/Staff/Settings/Activity log: none of those
// are staff's to see, per the RBAC spec, and requireFullAccessApi already
// blocks the underlying API calls server-side even if this list were
// bypassed some other way -- this is the "don't even render the tab" half
// of that same defense-in-depth.
const PIN_NAV = [
  { to: '/', label: 'Orders', end: true },
  { to: '/conversations', label: 'Conversations' },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/knowledge-base', label: 'Knowledge base' },
  { to: '/documents', label: 'Documents' },
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
  // Branches is hidden (not just filtered) for a branch-locked manager --
  // closes a real gap that used to exist: the page itself used to show
  // every branch to anyone who could reach it, not just the one they're
  // locked to. Staff/Settings/Activity log stay owner-or-manager-visible
  // in the nav; requireEditorApi on their write routes already governs
  // who can actually change anything once there.
  const baseNav = locked ? BASE_NAV.filter((item) => item.to !== '/branches') : BASE_NAV;
  const NAV = isPinTier(staff) ? PIN_NAV : addOnItems.length ? [...baseNav.slice(0, 2), ...addOnItems, ...baseNav.slice(2)] : baseNav;

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
