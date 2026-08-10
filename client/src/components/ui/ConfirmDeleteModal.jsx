import { useState } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import { theme } from '../../theme';
import { Modal } from './Modal';
import { Button } from './index';

const c = theme.color;

// Two-step permanent-delete confirmation, shared by every "Delete" action.
//
// Step 1 is the plain confirmation. If the API refuses with a 409 whose body
// carries `escalateKey` (e.g. { recordings: 3 }), we advance to Step 2 — an
// explicit "delete anyway" that re-sends the request with ?force=true. Entities
// with no force path (e.g. rooms that still hold babies) simply omit
// `escalateKey`: their 409 message is shown inline and the admin backs out.
//
// Props:
//   title          — Step 1 modal title
//   body           — Step 1 prompt (node)
//   confirmLabel   — Step 1 danger-button label
//   onDelete       — (force:boolean) => Promise; must reject (axios) on failure
//   escalateKey    — response-data field name that signals "needs force"
//   escalateTitle  — Step 2 modal title
//   escalateBody   — (count) => node : Step 2 warning
//   escalateLabel  — (count) => string : Step 2 danger-button label
//   onDone/onClose — refresh + close callbacks
export function ConfirmDeleteModal({
  title,
  body,
  confirmLabel = 'Delete permanently',
  onDelete,
  escalateKey,
  escalateTitle = 'Delete permanently?',
  escalateBody,
  escalateLabel = () => 'Delete anyway',
  onDone,
  onClose,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [escalateCount, setEscalateCount] = useState(null);
  const [escalateData, setEscalateData] = useState(null); // full 409 response body

  async function run(force) {
    setBusy(true); setError('');
    try {
      await onDelete(force);
      onDone?.();
      onClose();
    } catch (err) {
      const data = err.response?.data;
      if (!force && escalateKey && data?.[escalateKey]) {
        setEscalateCount(data[escalateKey]);
        setEscalateData(data);
      } else {
        setError(data?.error ?? 'Could not delete this item. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (escalateCount != null) {
    return (
      <Modal title={escalateTitle} onClose={onClose}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: c.dangerSoft, color: c.danger, padding: '12px 14px', borderRadius: theme.radius.sm, fontSize: 13 }}>
          <AlertTriangle size={17} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{escalateBody(escalateCount, escalateData)}</span>
        </div>
        {error && <p style={{ color: c.danger, fontSize: 13, marginTop: 10 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="danger" disabled={busy} icon={<Trash2 size={15} />} onClick={() => run(true)}>
            {busy ? 'Deleting…' : escalateLabel(escalateCount, escalateData)}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p style={{ marginTop: 0, color: c.text, fontSize: 14 }}>{body}</p>
      {error && <p style={{ color: c.danger, background: c.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="danger" disabled={busy} icon={<Trash2 size={15} />} onClick={() => run(false)}>
          {busy ? 'Deleting…' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
