import React, { useState } from 'react';
import BusinessDetails from './tabs/BusinessDetails.jsx';
import Catalogue from './tabs/Catalogue.jsx';
import TrainTheBot from './tabs/TrainTheBot.jsx';
import ConversationFlow from './tabs/ConversationFlow.jsx';
import Connect from './tabs/Connect.jsx';
import ReviewBuild from './tabs/ReviewBuild.jsx';
import { DEFAULT_BOT_STATES, DEFAULT_BOT_FIELDS } from './defaults.js';

const TABS = [
  { key: 'business', label: 'Business details' },
  { key: 'catalogue', label: 'Catalogue' },
  { key: 'train', label: 'Train the bot' },
  { key: 'flow', label: 'Conversation flow' },
  { key: 'connect', label: 'WhatsApp & payment' },
  { key: 'review', label: 'Review & build' },
];

export default function App() {
  const [tab, setTab] = useState('business');
  const [navOpen, setNavOpen] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [size, setSize] = useState('small');
  const [provider, setProvider] = useState('oracle');
  const [business, setBusiness] = useState({
    name: '',
    type: 'restaurant',
    address: '',
    phone_number: '',
    delivery_enabled: false,
    whatsapp_connection: 'api_only',
    handover_number: '',
    bank_name: '',
    bank_account_number: '',
    bank_account_name: '',
    logo_data_url: '',
    brand_color: '#111827',
  });
  const [owner, setOwner] = useState({ name: '', email: '' });
  const [catalogue, setCatalogue] = useState([]);
  // Seeded from the default type (restaurant) up front -- picking a type on
  // the Business details tab only re-seeds on an actual change event, which
  // never fires for a type that was already selected by default.
  const [botFields, setBotFields] = useState(DEFAULT_BOT_FIELDS.restaurant);
  const [botStates, setBotStates] = useState(DEFAULT_BOT_STATES);
  const [knowledgeBase, setKnowledgeBase] = useState([]);

  const draft = { businessName: business.name, subdomain, size, provider, business, owner, catalogue, botFields, botStates, knowledgeBase };

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
          <small>Build workstation</small>
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
            provider={provider}
            setProvider={setProvider}
            business={business}
            setBusiness={setBusiness}
            owner={owner}
            setOwner={setOwner}
            botFields={botFields}
            setBotFields={setBotFields}
          />
        )}
        {tab === 'catalogue' && <Catalogue catalogue={catalogue} setCatalogue={setCatalogue} businessType={business.type} />}
        {tab === 'train' && (
          <TrainTheBot botFields={botFields} setBotFields={setBotFields} botStates={botStates} knowledgeBase={knowledgeBase} setKnowledgeBase={setKnowledgeBase} />
        )}
        {tab === 'flow' && <ConversationFlow botStates={botStates} setBotStates={setBotStates} />}
        {tab === 'connect' && <Connect />}
        {tab === 'review' && <ReviewBuild draft={draft} />}
      </main>
    </div>
  );
}
