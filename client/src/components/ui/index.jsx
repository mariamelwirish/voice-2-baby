// Shared UI primitives, all driven by theme.js. Import from here:
//   import { Button, Card, Badge, Field, StatusDot, Spinner, PageHeader } from '../components/ui';
import { theme } from '../../theme';

export { Select } from './Select';
export { ThemeToggle } from './ThemeToggle';
export { Modal } from './Modal';
export { Logo } from './Logo';

const c = theme.color;

/* ---------------------------------- Button --------------------------------- */
// variant: 'primary' | 'ghost' | 'danger' | 'subtle'
// size:    'sm' | 'md'
export function Button({ variant = 'primary', size = 'md', icon, children, style, disabled, ...rest }) {
  const pad = size === 'sm' ? '6px 12px' : '10px 18px';
  const fontSize = size === 'sm' ? 13 : 14;

  const variants = {
    primary: { background: c.accent, color: '#fff', border: '1px solid transparent' },
    danger:  { background: c.danger, color: '#fff', border: '1px solid transparent' },
    ghost:   { background: c.cardBg, color: c.text, border: `1.5px solid ${c.border}` },
    subtle:  { background: c.subtleBg, color: c.text, border: '1px solid transparent' },
  };

  return (
    <button
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        padding: pad, fontSize, fontWeight: 700, fontFamily: theme.font.family,
        borderRadius: theme.radius.sm, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1, transition: 'filter .15s, background .15s',
        whiteSpace: 'nowrap', lineHeight: 1.2,
        ...variants[variant], ...style,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.filter = 'brightness(0.95)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
      {...rest}
    >
      {icon}{children}
    </button>
  );
}

/* ----------------------------------- Card ---------------------------------- */
export function Card({ children, style, padded = true, ...rest }) {
  return (
    <div
      style={{
        background: c.cardBg, border: `1px solid ${c.border}`,
        borderRadius: theme.radius.lg, boxShadow: theme.shadow.md,
        padding: padded ? 20 : 0, ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ---------------------------------- Badge ---------------------------------- */
// tone: 'success' | 'warn' | 'danger' | 'info' | 'accent' | 'neutral'
export function Badge({ tone = 'neutral', icon, children, style }) {
  const tones = {
    success: { bg: c.successSoft, fg: c.success },
    warn:    { bg: c.warnSoft,    fg: c.warn },
    danger:  { bg: c.dangerSoft,  fg: c.danger },
    info:    { bg: c.infoSoft,    fg: c.info },
    accent:  { bg: c.accentSoft,  fg: c.accent },
    neutral: { bg: c.subtleBg,    fg: c.textMuted },
  };
  const { bg, fg } = tones[tone] ?? tones.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 12, fontWeight: 700, padding: '3px 11px', borderRadius: theme.radius.pill,
      background: bg, color: fg, whiteSpace: 'nowrap', ...style,
    }}>
      {icon}{children}
    </span>
  );
}

/* -------------------------------- StatusDot -------------------------------- */
// A live online/offline (or generic colored) dot with a soft halo + label.
export function StatusDot({ color = c.online, label, style }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: c.text, ...style }}>
      <span style={{ width: 9, height: 9, borderRadius: theme.radius.pill, background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)`, flexShrink: 0 }} />
      {label}
    </span>
  );
}

/* ---------------------------------- Field ---------------------------------- */
// Labeled input/select/textarea wrapper. Pass `as="select"|"textarea"` or children for select options.
export function Field({ label, hint, error, as = 'input', children, leftIcon, style, ...rest }) {
  const base = {
    display: 'block', width: '100%', padding: leftIcon ? '10px 12px 10px 36px' : '10px 12px',
    marginTop: 5, fontSize: 14, fontFamily: theme.font.family, color: c.text,
    background: c.cardBg, borderRadius: theme.radius.sm,
    border: `1.5px solid ${error ? c.danger : c.border}`, outline: 'none',
  };
  const control = as === 'select'
    ? <select style={base} {...rest}>{children}</select>
    : as === 'textarea'
    ? <textarea style={{ ...base, resize: 'vertical' }} {...rest} />
    : <input style={base} {...rest} />;

  return (
    <label style={{ display: 'block', ...style }}>
      {label && <span style={{ fontSize: 13, fontWeight: 700, color: c.text }}>{label}</span>}
      <span style={{ position: 'relative', display: 'block' }}>
        {leftIcon && (
          <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-30%)', pointerEvents: 'none' }}>
            {leftIcon}
          </span>
        )}
        {control}
      </span>
      {hint && !error && <span style={{ fontSize: 12, color: c.textMuted, marginTop: 4, display: 'block' }}>{hint}</span>}
      {error && <span style={{ fontSize: 12, color: c.danger, marginTop: 4, display: 'block' }}>{error}</span>}
    </label>
  );
}

/* ------------------------------- PageHeader -------------------------------- */
export function PageHeader({ title, subtitle, actions, style }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 22, ...style }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: c.text }}>{title}</h1>
        {subtitle && <p style={{ margin: '4px 0 0', color: c.textMuted, fontSize: 14 }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

/* --------------------------------- Spinner --------------------------------- */
export function Spinner({ label = 'Loading…', style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: c.textMuted, fontSize: 14, padding: '12px 0', ...style }}>
      <span style={{
        width: 16, height: 16, borderRadius: '50%',
        border: `2.5px solid ${c.border}`, borderTopColor: c.accent,
        display: 'inline-block', animation: 'rr-spin 0.7s linear infinite',
      }} />
      {label}
    </div>
  );
}

/* -------------------------------- EmptyState ------------------------------- */
export function EmptyState({ icon, title, hint, action, style }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: c.textMuted, ...style }}>
      {icon && <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}>{icon}</div>}
      <div style={{ fontWeight: 700, color: c.text, fontSize: 15 }}>{title}</div>
      {hint && <div style={{ fontSize: 14, marginTop: 4 }}>{hint}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
