import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const COLUMNS = [
  { key: 'new', label: 'New', hint: 'oldest first' },
  { key: 'confirmed', label: 'Confirmed', hint: 'awaiting kitchen' },
  { key: 'ready', label: 'Ready', hint: 'awaiting pickup/rider' },
  { key: 'delivery', label: 'Delivery', hint: 'rider or pickup' },
  { key: 'completed', label: 'Completed', hint: '' },
];

// Purely a visual affordance -- a long unattended wait means something
// different at different stages, but a single flat threshold is the
// simplest honest rule without inventing a per-column config surface for
// what's ultimately just a coloured hint, not a real business rule.
function waitingSince(createdAt) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60000));
  const text = minutes < 1 ? 'just now' : `${minutes} min`;
  const level = minutes >= 20 ? 'hot' : minutes >= 10 ? 'warm' : '';
  return { text, level };
}

function naira(amount) {
  return `₦${Number(amount).toLocaleString()}`;
}

function answeredInText(seconds) {
  if (seconds == null) return '–';
  if (seconds < 60) return `${seconds} sec`;
  return `${Math.round(seconds / 60)} min`;
}

function busiestHourText(hour) {
  if (!hour) return '–';
  const start = new Date(hour.start);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt(start)} to ${fmt(end)} · ${hour.count} order${hour.count === 1 ? '' : 's'}`;
}

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const [today, setToday] = useState(null);

  useEffect(() => {
    api.get('/orders').then(setOrders);
    api.get('/orders/stats/today').then(setToday);
  }, []);

  if (!orders) return null;

  const cancelled = orders.filter((o) => o.status === 'cancelled').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Orders</h1>
          <p className="subtitle">Every order that has come in through the bot or the dashboard.</p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat-card">
          <div className="value">{orders.length}</div>
          <div className="label">Total orders</div>
        </div>
        <div className="stat-card">
          <div className="value">{orders.filter((o) => o.payment_status !== 'accepted' && o.payment_status !== 'confirmed').length}</div>
          <div className="label">Awaiting payment</div>
        </div>
        <div className="stat-card">
          <div className="value">{cancelled}</div>
          <div className="label">Cancelled</div>
        </div>
      </div>

      {today && (
        <div className="card" style={{ maxWidth: 480 }}>
          <h3 style={{ marginTop: 0 }}>Today</h3>
          <div className="figs">
            <div className="fig">
              <span>Orders</span>
              <strong className="mono">{today.orders}</strong>
            </div>
            <div className="fig">
              <span>Collected</span>
              <strong className="mono">{naira(today.collected)}</strong>
            </div>
            <div className="fig">
              <span>Average</span>
              <strong className="mono">{naira(today.average)}</strong>
            </div>
            <div className="fig">
              <span>Answered in</span>
              <strong className="mono">{answeredInText(today.answeredSeconds)}</strong>
            </div>
            <div className="fig wide">
              <span>Busiest hour</span>
              <strong className="mono">{busiestHourText(today.busiestHour)}</strong>
            </div>
          </div>
        </div>
      )}

      <div className="board" style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8 }}>
        {COLUMNS.map((col) => {
          const colOrders = orders.filter((o) => o.status === col.key);
          return (
            <div key={col.key} className="board-column" style={{ minWidth: 220, flex: '0 0 220px' }}>
              <div className="lane-head">
                <h2>{col.label}</h2>
                <span className="count mono">{colOrders.length}</span>
                {col.hint && <p className="hint">{col.hint}</p>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {colOrders.map((o) => {
                  const waiting = waitingSince(o.created_at);
                  return (
                    <Link key={o.id} to={`/orders/${o.id}`} className="docket">
                      <div className="row1">
                        <span className="no mono">{o.reference}</span>
                        {o.customer_channel && <span className={`chan ${o.customer_channel}`}>{o.customer_channel}</span>}
                        <span className={`waiting mono ${waiting.level}`}>{waiting.text}</span>
                      </div>
                      <p className="who">{o.customer_name || o.customer_phone}</p>
                      {o.items?.length > 0 && (
                        <ul>
                          {o.items.map((item, i) => (
                            <li key={i}>
                              <b>{item.quantity}</b> {item.name}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="foot">
                        <span className="total mono">NGN {Number(o.total).toLocaleString()}</span>
                        <span className={`badge ${o.payment_status}`}>{o.payment_status}</span>
                      </div>
                    </Link>
                  );
                })}
                {!colOrders.length && <div className="empty">Nothing here.</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
