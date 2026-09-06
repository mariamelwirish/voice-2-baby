import { theme } from '../../theme';
import { Card, Logo } from '../ui';
import { ThemeToggle } from '../ui/ThemeToggle';
import { CoBrandingFooter } from './CoBranding';

// Centered, warm auth card used by Login and Signup.
export function AuthShell({ title, subtitle, children, footer }) {
  const c = theme.color;
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      background: c.pageBg,
    }}>
      {/* Theme toggle, top-right */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 16px 0' }}>
        <ThemeToggle />
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 16px 24px' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          {/* Brand mark */}
          <div style={{ textAlign: 'center', marginBottom: 22 }}>
            <div style={{
              width: 60, height: 60, borderRadius: 20, background: c.accentSoft,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: c.accent, boxShadow: theme.shadow.sm,
            }}>
              <Logo size={32} strokeWidth={1.9} />
            </div>
            <h1 style={{ margin: '14px 0 0', fontSize: 20, fontWeight: 800, color: c.text }}>
              Voice2Baby
            </h1>
            <p style={{ margin: '4px 0 0', color: c.textMuted, fontSize: 14 }}>
              A gentle way to be there for your baby
            </p>
          </div>

          <Card style={{ padding: 28 }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: c.text }}>{title}</h2>
            {subtitle && <p style={{ margin: '0 0 20px', color: c.textMuted, fontSize: 14 }}>{subtitle}</p>}
            {!subtitle && <div style={{ height: 14 }} />}
            {children}
          </Card>

          {footer && <div style={{ textAlign: 'center', marginTop: 18, fontSize: 13, color: c.textMuted }}>{footer}</div>}
        </div>
      </div>

      <CoBrandingFooter style={{ marginTop: 0, background: 'transparent', borderTopColor: c.border }} />
    </div>
  );
}
