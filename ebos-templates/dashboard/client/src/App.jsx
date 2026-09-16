import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { StaffProvider, useStaff, isPinTier, workAreaOf } from './StaffContext.jsx';
import { ScopeProvider } from './ScopeContext.jsx';
import Layout from './components/Layout.jsx';
import Loading from './components/Loading.jsx';
import Login from './pages/Login.jsx';
import PinLogin from './pages/PinLogin.jsx';

// Chidera, 2026-09-16: "why is my dashboard lagging... when i tap a new tab,
// why does it just stay white and blank for a while" -- every page used to
// be bundled into one ~870KB JS file loaded up front, so even opening the
// dashboard for the first time (or after a cache-busting deploy) meant
// waiting on every page's code, not just the one being viewed. Login/PinLogin
// stay eager (the very first thing almost anyone sees); everything past the
// login wall loads on demand, one small chunk per page, shown behind the
// same Loading spinner every page already uses for its own data fetch --
// so a slow network now shows the same honest "loading", never blank white.
const Orders = lazy(() => import('./pages/Orders.jsx'));
const OrderDetail = lazy(() => import('./pages/OrderDetail.jsx'));
const Bookings = lazy(() => import('./pages/Bookings.jsx'));
const Catalogue = lazy(() => import('./pages/Catalogue.jsx'));
const Branches = lazy(() => import('./pages/Branches.jsx'));
const Conversations = lazy(() => import('./pages/Conversations.jsx'));
const ConversationDetail = lazy(() => import('./pages/ConversationDetail.jsx'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase.jsx'));
const Documents = lazy(() => import('./pages/Documents.jsx'));
const Staff = lazy(() => import('./pages/Staff.jsx'));
const ActivityLog = lazy(() => import('./pages/ActivityLog.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Delivery = lazy(() => import('./pages/Delivery.jsx'));
const Voice = lazy(() => import('./pages/Voice.jsx'));
const DineIn = lazy(() => import('./pages/DineIn.jsx'));
const InHouse = lazy(() => import('./pages/InHouse.jsx'));
const Feedback = lazy(() => import('./pages/Feedback.jsx'));
const Customers = lazy(() => import('./pages/Customers.jsx'));
const Crm = lazy(() => import('./pages/Crm.jsx'));
const Pos = lazy(() => import('./pages/Pos.jsx'));

// Every path a PIN-tier (Tier 3) session is allowed to land on -- matches
// Layout.jsx's PIN_NAV exactly. Not just a nav-hiding trick: this actually
// redirects a Tier 3 session away from a URL typed or bookmarked directly,
// on top of requireFullAccessApi already refusing the underlying API calls
// server-side either way.
const PIN_ALLOWED_PREFIXES = ['/', '/orders', '/catalogue', '/conversations', '/knowledge-base', '/documents'];

// work_area === 'in_house' gets an even smaller, entirely separate set --
// matches Layout.jsx's IN_HOUSE_NAV. Deliberately excludes '/' (the main
// Orders board is the online-only kanban now) -- their home is /in-house.
// Chidera 2026-09-11: "i need a era-demo.erasystems.com.ng/in-house link
// that opend the management for the in house guest, so staffs arent
// confused."
const IN_HOUSE_ALLOWED_PREFIXES = ['/in-house', '/orders', '/dinein'];

function Protected({ children }) {
  const { staff } = useStaff();
  const location = useLocation();
  if (staff === undefined) return null; // still loading /api/me
  if (staff === null) return <Navigate to="/login" replace />;
  const workArea = workAreaOf(staff);
  if (workArea === 'in_house') {
    if (!IN_HOUSE_ALLOWED_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'))) {
      return <Navigate to="/in-house" replace />;
    }
  } else if (
    isPinTier(staff) &&
    !PIN_ALLOWED_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'))
  ) {
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  return (
    <StaffProvider>
      <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/staff-login" element={<PinLogin />} />
        <Route
          element={
            <Protected>
              <ScopeProvider>
                <Layout />
              </ScopeProvider>
            </Protected>
          }
        >
          <Route path="/" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/bookings" element={<Bookings />} />
          <Route path="/catalogue" element={<Catalogue />} />
          <Route path="/branches" element={<Branches />} />
          <Route path="/delivery" element={<Delivery />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/dinein" element={<DineIn />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/crm" element={<Crm />} />
          <Route path="/pos" element={<Pos />} />
          <Route path="/in-house" element={<InHouse />} />
          <Route path="/conversations" element={<Conversations />} />
          <Route path="/conversations/:id" element={<ConversationDetail />} />
          <Route path="/knowledge-base" element={<KnowledgeBase />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/feedback" element={<Feedback />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/activity-log" element={<ActivityLog />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
      </Suspense>
    </StaffProvider>
  );
}
