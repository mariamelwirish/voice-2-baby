import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { Baby, DoorOpen, Users, Radio, Stethoscope } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { theme } from '../../theme';
import { AppTopBar } from '../../components/layout/AppTopBar';
import { CoBrandingFooter } from '../../components/layout/CoBranding';
import BabiesTab from './tabs/BabiesTab';
import RoomsTab from './tabs/RoomsTab';
import { NursesTab, ParentsTab } from './tabs/UsersTab';
import DevicesTab from './tabs/DevicesTab';
import AdminBabyRecordings from './AdminBabyRecordings';

const TABS = [
  { to: '/admin/babies',  label: 'Babies',   icon: Baby },
  { to: '/admin/rooms',   label: 'Rooms',    icon: DoorOpen },
  { to: '/admin/devices', label: 'Speakers', icon: Radio },
  { to: '/admin/nurses',  label: 'Nurses',   icon: Stethoscope },
  { to: '/admin/parents', label: 'Parents',  icon: Users },
];

function TabLink({ to, label, icon: Icon }) {
  const c = theme.color;
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '10px 16px', textDecoration: 'none', fontSize: 14,
        fontWeight: isActive ? 800 : 600,
        color: isActive ? c.accent : c.textMuted,
        borderBottom: `2.5px solid ${isActive ? c.accent : 'transparent'}`,
        transition: 'color .15s',
      })}
    >
      <Icon size={17} />
      {label}
    </NavLink>
  );
}

export default function AdminLayout() {
  const { user } = useAuth();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppTopBar
        roleLabel="Administrator"
        userName={user.first_name}
      />

      <div style={{ flex: 1, width: '100%', maxWidth: 1280, margin: '0 auto', padding: '0 24px' }}>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.color.border}`, marginBottom: 28, overflowX: 'auto' }}>
          {TABS.map(t => <TabLink key={t.to} {...t} />)}
        </div>

        <Routes>
          <Route index element={<Navigate to="/admin/babies" replace />} />
          <Route path="babies"  element={<BabiesTab />} />
          <Route path="babies/:babyId/recordings" element={<AdminBabyRecordings />} />
          <Route path="rooms"   element={<RoomsTab />} />
          <Route path="devices" element={<DevicesTab />} />
          <Route path="nurses"  element={<NursesTab />} />
          <Route path="parents" element={<ParentsTab />} />
          <Route path="users"   element={<Navigate to="/admin/nurses" replace />} />
        </Routes>
      </div>
      <CoBrandingFooter />
    </div>
  );
}
