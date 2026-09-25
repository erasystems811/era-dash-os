import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const StaffContext = createContext(null);

// The Push API needs the VAPID public key as raw bytes, not the base64url
// string the server hands back -- same conversion rider-pwa/src/App.jsx
// already uses.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Chidera, 2026-09-23: "make the dashboard pwa so staff can get push
// notification or something" -- registers the service worker and
// subscribes to real push, replacing/supplementing real WhatsApp staff
// alerts (see engine/push-notify.js's pushToStaff and flow.js's
// notifyStaff). Best-effort and silent on purpose, unlike rider-pwa's own
// version (which blocks going on duty over a denied/unsupported push --
// Chidera's own call there, "make allow notification a prerequisite"):
// there's no equivalent hard gate for staff, and nagging every login with
// a permission prompt would be worse than just falling back to WhatsApp
// server-side (flow.js's notifyStaff already does that) for anyone who
// never grants it.
async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const { publicKey } = await api.get('/push-public-key');
    if (!publicKey) return; // this deployment hasn't got VAPID keys set up yet
    const registration = await navigator.serviceWorker.register('/sw.js');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api.post('/push-subscribe', { subscription: subscription.toJSON() });
  } catch (err) {
    console.error('Push subscription failed:', err);
  }
}

export function StaffProvider({ children }) {
  const [staff, setStaff] = useState(undefined); // undefined = still loading

  useEffect(() => {
    api
      .get('/me')
      .then((d) => setStaff(d.staff))
      .catch(() => setStaff(null));
  }, []);

  useEffect(() => {
    if (staff?.id) subscribeToPush();
  }, [staff?.id]);

  async function login(email, password) {
    const { staff } = await api.post('/login', { email, password });
    setStaff(staff);
  }

  // Tier 3 login: pick a branch, pick a name, enter the 4-digit PIN. Sets
  // the same staff shape as the email/password login above -- everything
  // downstream (canEdit, isPinTier, the nav) just reads staff.role/
  // branch_id/auth_type, regardless of which flow set it.
  async function loginWithPin(branchId, staffId, pin) {
    const { staff } = await api.post('/pin-login', { branch_id: branchId, staff_id: staffId, pin });
    setStaff(staff);
  }

  async function logout() {
    await api.post('/logout');
    setStaff(null);
  }

  return <StaffContext.Provider value={{ staff, login, loginWithPin, logout }}>{children}</StaffContext.Provider>;
}

export function useStaff() {
  return useContext(StaffContext);
}

export function canEdit(staff) {
  return staff?.role === 'owner' || staff?.role === 'manager';
}

// Branch-lock, not edit-permission -- orthogonal to canEdit above (a branch
// manager can edit within their branch; an owner can edit everywhere; both
// are still "can edit"). null means "all branches" -- true for every login
// today, and for an owner/admin even once other staff start getting
// locked. Used only by the dashboard's scope switcher to decide whether to
// show one at all, never to gate a feature.
export function visibleBranchId(staff) {
  return staff?.branch_id || null;
}

// Tier 3: name+PIN login, always branch-locked, always the restricted
// 5-tab view -- see Layout.jsx's nav split and App.jsx's route guard.
// Mirrors lib/auth.js's server-side isPinTier; intentionally duplicated
// rather than shared, same as canEdit/visibleBranchId above -- different
// runtimes, not meant to be the same module.
export function isPinTier(staff) {
  return staff?.auth_type === 'pin';
}

// null (owner/manager, or any staff account from before this existed) means
// unrestricted -- same null-means-everything idiom as visibleBranchId
// above. 'online'/'in_house' split floor/counter staff into two
// non-overlapping worlds once a business has dine-in on, see Layout.jsx's
// nav split and lib/auth.js's server-side scopeToWorkArea.
export function workAreaOf(staff) {
  return staff?.work_area || null;
}
