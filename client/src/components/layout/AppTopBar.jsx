import { LogOut } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { theme } from '../../theme';
import { Logo } from '../ui/Logo';
import { ThemeToggle } from '../ui/ThemeToggle';
import { CoBrandingInline } from './CoBranding';

// Shared warm top bar for all logged-in layouts (admin / nurse / parent).
export function AppTopBar({ roleLabel, userName }) {
  const { logout } = useAuth();
  const c = theme.color;

  return (
    <header style={{
      background: c.chromeBg, borderBottom: `1px solid ${c.chromeBorder}`,
      boxShadow: theme.shadow.sm, marginBottom: 28,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12, background: c.accentSoft, color: c.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Logo size={22} strokeWidth={1.9} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: c.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Voice2Baby
            </div>
            {roleLabel && <div style={{ fontSize: 12, color: c.textMuted }}>{roleLabel}</div>}
          </div>
        </div>

        {/* VCU × VCU Health co-branding, centered */}
        <CoBrandingInline style={{ margin: '0 auto' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ThemeToggle />
          {userName && (
            <span style={{ fontSize: 14, color: c.text, fontWeight: 600, whiteSpace: 'nowrap' }}>
              Hi, {userName}
            </span>
          )}
          <button
            onClick={logout}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              background: 'none', border: `1.5px solid ${c.border}`, borderRadius: theme.radius.sm,
              padding: '7px 12px', fontSize: 13, fontWeight: 600, color: c.textMuted, cursor: 'pointer',
            }}
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
