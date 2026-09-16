import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { StaffProvider, useStaff, isPinTier, workAreaOf } from './StaffContext.jsx';
import { ScopeProvider } from './ScopeContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import PinLogin from './pages/PinLogin.jsx';
import Orders from './pages/Orders.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Bookings from './pages/Bookings.jsx';
import Catalogue from './pages/Catalogue.jsx';
import Branches from './pages/Branches.jsx';
import Conversations from './pages/Conversations.jsx';
import ConversationDetail from './pages/ConversationDetail.jsx';
import KnowledgeBase from './pages/KnowledgeBase.jsx';
import Documents from './pages/Documents.jsx';
import Staff from './pages/Staff.jsx';
import ActivityLog from './pages/ActivityLog.jsx';
import Settings from './pages/Settings.jsx';
import Delivery from './pages/Delivery.jsx';
import Voice from './pages/Voice.jsx';
import DineIn from './pages/DineIn.jsx';
import InHouse from './pages/InHouse.jsx';
import Feedback from './pages/Feedback.jsx';
import Customers from './pages/Customers.jsx';
import Pos from './pages/Pos.jsx';

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
    </StaffProvider>
  );
}
