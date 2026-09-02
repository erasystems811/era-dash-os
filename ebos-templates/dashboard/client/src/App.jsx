import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { StaffProvider, useStaff } from './StaffContext.jsx';
import { ScopeProvider } from './ScopeContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
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
import Settings from './pages/Settings.jsx';
import Delivery from './pages/Delivery.jsx';
import Voice from './pages/Voice.jsx';

function Protected({ children }) {
  const { staff } = useStaff();
  if (staff === undefined) return null; // still loading /api/me
  if (staff === null) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <StaffProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
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
          <Route path="/conversations" element={<Conversations />} />
          <Route path="/conversations/:id" element={<ConversationDetail />} />
          <Route path="/knowledge-base" element={<KnowledgeBase />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </StaffProvider>
  );
}
