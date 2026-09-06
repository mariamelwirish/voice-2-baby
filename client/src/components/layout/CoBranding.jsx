import { useState } from 'react';
import { theme } from '../../theme';

// VCU branding.
//
// Drop the official VCU logo PNG here and it appears everywhere automatically:
//   client/public/logos/vcu.png
// (Optionally also client/public/logos/vcu-health.png — it shows if present.)
// Until the file is added, a small neutral text placeholder is shown instead.

// Renders an <img> if the file exists; otherwise a quiet text fallback.
function LogoImg({ src, alt, height, fallbackText }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return fallbackText
      ? <span style={{ fontSize: 13, fontWeight: 800, color: theme.color.textMuted }}>{fallbackText}</span>
      : null;
  }
  return (
    <img
      src={src}
      alt={alt}
      style={{ height, width: 'auto', display: 'block', objectFit: 'contain' }}
      onError={() => setFailed(true)}
    />
  );
}

// Full footer band — used at the bottom of every page.
export function CoBrandingFooter({ style }) {
  const c = theme.color;
  return (
    <footer style={{
      borderTop: `1px solid ${c.chromeBorder}`, marginTop: 40, padding: '24px 16px',
      background: c.chromeBg, ...style,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
          <LogoImg src="/logos/vcu.png" alt="Virginia Commonwealth University" height={44} fallbackText="VCU Health NICU" />
          <LogoImg src="/logos/vcu-health.png" alt="VCU Health" height={40} />
        </div>
        <div style={{ fontSize: 12, color: c.textMuted }}>
          Voice2Baby · VCU Health NICU
        </div>
      </div>
    </footer>
  );
}

// Compact logo for the top bar / auth header.
export function CoBrandingInline({ style }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, ...style }}>
      <LogoImg src="/logos/vcu.png" alt="VCU" height={26} fallbackText="VCU Health" />
    </div>
  );
}
