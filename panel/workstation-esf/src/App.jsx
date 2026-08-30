import React, { useState } from 'react';
import BusinessDetails from './tabs/BusinessDetails.jsx';
import Staff from './tabs/Staff.jsx';
import Tasks from './tabs/Tasks.jsx';
import Connect from './tabs/Connect.jsx';
import ReviewBuild from './tabs/ReviewBuild.jsx';

const TABS = [
  { key: 'business', label: 'Business details' },
  { key: 'staff', label: 'Staff' },
  { key: 'tasks', label: 'Tasks & steps' },
  { key: 'connect', label: 'WhatsApp' },
  { key: 'review', label: 'Review & build' },
];

export default function App() {
  const [tab, setTab] = useState('business');
  const [navOpen, setNavOpen] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [size, setSize] = useState('small');
  const [whatsapp, setWhatsapp] = useState(false);
  const [business, setBusiness] = useState({
    name: '',
    owner_phone: '',
    timezone: 'Africa/Lagos',
    lat: '',
    lng: '',
    radius_m: '200',
  });
  const [owner, setOwner] = useState({ email: '' });
  const [staff, setStaff] = useState([]);
  const [tasks, setTasks] = useState([]);

  const draft = { businessName: business.name, subdomain, size, whatsapp, business, owner, staff, tasks };

  return (
    <div className="shell">
      <header className="mobile-header">
        <button className="nav-toggle" aria-label="Open menu" onClick={() => setNavOpen(true)}>
          ☰
        </button>
        <div className="mobile-header-brand">ERA Dash OS</div>
      </header>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <aside className={`tabs ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          ERA Dash OS
          <small>Build an ESF business</small>
        </div>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab-link ${tab === t.key ? 'active' : ''}`}
            onClick={() => {
              setTab(t.key);
              setNavOpen(false);
            }}
          >
            {t.label}
          </button>
        ))}
      </aside>
      <main className="content">
        {tab === 'business' && (
          <BusinessDetails
            subdomain={subdomain}
            setSubdomain={setSubdomain}
            size={size}
            setSize={setSize}
            business={business}
            setBusiness={setBusiness}
            owner={owner}
            setOwner={setOwner}
          />
        )}
        {tab === 'staff' && <Staff staff={staff} setStaff={setStaff} />}
        {tab === 'tasks' && <Tasks tasks={tasks} setTasks={setTasks} staff={staff} />}
        {tab === 'connect' && <Connect whatsapp={whatsapp} setWhatsapp={setWhatsapp} />}
        {tab === 'review' && <ReviewBuild draft={draft} />}
      </main>
    </div>
  );
}
