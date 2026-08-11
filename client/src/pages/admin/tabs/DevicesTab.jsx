import { useState, useEffect, useCallback } from 'react';
import { Radio, Plus, Link2, Unlink, Power, PowerOff, Trash2 } from 'lucide-react';
import api from '../../../api/client';
import { theme } from '../../../theme';
import { Modal } from '../../../components/ui/Modal';
import { Button, Badge, Select, StatusDot, Spinner, EmptyState, PageHeader } from '../../../components/ui';

const c = theme.color;

// Human "last seen" — nurses shouldn't have to read timestamps.
function lastSeen(v) {
  if (!v) return 'never connected';
  const mins = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// The system assigns a unique ID — no typing, no collisions. We show the
// generated ID so IT uses that exact code when setting up the Raspberry Pi.
function RegisterModal({ onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null); // the new device once generated
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/devices', {}); // no code → backend generates one
      setCreated(data.device);
      onDone(); // refresh the list behind the modal
    } catch (err) {
      setError(err.response?.data?.error ?? 'Could not add this speaker.');
    } finally { setBusy(false); }
  }

  function copy() {
    navigator.clipboard?.writeText(created.device_code).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  if (created) {
    return (
      <Modal title="Speaker added" onClose={onClose}>
        <p style={{ marginTop: 0, color: c.text, fontSize: 14 }}>
          This speaker’s ID is ready. Use this exact ID when setting up the Raspberry Pi.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: c.accentSoft, border: `1px solid ${c.border}`, borderRadius: theme.radius.md, padding: '16px 18px', margin: '14px 0' }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 22, fontWeight: 800, color: c.accent, letterSpacing: 1 }}>{created.device_code}</span>
          <Button size="sm" variant="ghost" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</Button>
        </div>
        <p style={{ fontSize: 13, color: c.textMuted, margin: 0 }}>
          It’ll show as <strong>Offline</strong> until the physical device is set up and connects. Then you can assign it to a baby.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button type="button" onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add a speaker" onClose={onClose}>
      <p style={{ marginTop: 0, color: c.text, fontSize: 14 }}>
        The system will assign this speaker a unique ID automatically — no need to make one up. You’ll give that ID to whoever sets up the device.
      </p>
      {error && <p style={{ color: c.danger, background: c.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={generate}>{busy ? 'Adding…' : 'Generate speaker ID'}</Button>
      </div>
    </Modal>
  );
}

function AssignModal({ device, babies, onClose, onDone }) {
  const [babyId, setBabyId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.patch(`/devices/${device.id}/assign-baby`, { baby_id: babyId }); onDone(); onClose(); }
    catch (err) { setError(err.response?.data?.error ?? 'Could not assign this speaker.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Assign speaker to a baby" onClose={onClose}>
      <form onSubmit={submit}>
        <Select
          label="Baby" searchable required value={babyId} onChange={setBabyId}
          searchPlaceholder="Search by ID or name…" emptyText="No unassigned babies"
          options={babies.map(b => ({ value: b.id, label: `${b.first_name} ${b.last_name}`, sublabel: `${b.record_number ?? ''}${b.room_number ? ` · Room ${b.room_number}` : ''}`, keywords: `${b.record_number ?? ''} ${b.first_name} ${b.last_name}` }))}
        />
        {babies.length === 0 && <p style={{ fontSize: 13, color: c.warn, marginTop: 8 }}>Every active baby already has a speaker.</p>}
        {error && <p style={{ color: c.danger, fontSize: 13, marginTop: 10 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Assigning…' : 'Assign'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({ device, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blockedCount, setBlockedCount] = useState(null); // # of playback records if the plain delete is blocked

  async function remove(force) {
    setBusy(true); setError('');
    try {
      await api.delete(`/devices/${device.id}${force ? '?force=true' : ''}`);
      onDone(); onClose();
    } catch (err) {
      const data = err.response?.data;
      if (!force && data?.playback_records) {
        setBlockedCount(data.playback_records); // move to the explicit force step
      } else {
        setError(data?.error ?? 'Could not delete this speaker.');
      }
    } finally { setBusy(false); }
  }

  // Second step: it has history — require an explicit "delete anyway" confirmation.
  if (blockedCount) {
    return (
      <Modal title="Delete the speaker and its history?" onClose={onClose}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: c.dangerSoft, color: c.danger, padding: '12px 14px', borderRadius: theme.radius.sm, fontSize: 13 }}>
          <span>
            <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{device.device_code}</strong> has <strong>{blockedCount}</strong> confirmed playback record(s).
            Continuing will <strong>permanently erase that playback history too</strong>. This cannot be undone.
          </span>
        </div>
        {error && <p style={{ color: c.danger, fontSize: 13, marginTop: 10 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="danger" disabled={busy} icon={<Trash2 size={15} />} onClick={() => remove(true)}>
            {busy ? 'Deleting…' : `Delete speaker + ${blockedCount} record(s)`}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Delete speaker" onClose={onClose}>
      <p style={{ marginTop: 0, color: c.text, fontSize: 14 }}>
        Permanently delete speaker <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{device.device_code}</strong> from the database? This cannot be undone.
      </p>
      {error && <p style={{ color: c.danger, background: c.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="danger" disabled={busy} icon={<Trash2 size={15} />} onClick={() => remove(false)}>{busy ? 'Deleting…' : 'Delete permanently'}</Button>
      </div>
    </Modal>
  );
}

const th = { padding: '10px 14px', color: c.textMuted, fontWeight: 700, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' };
const td = { padding: '12px 14px', color: c.text, fontSize: 14, verticalAlign: 'middle' };

export default function DevicesTab() {
  const [devices, setDevices] = useState([]);
  const [activeBabies, setActiveBabies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [rowError, setRowError] = useState('');

  const fetchDevices = useCallback(() => {
    api.get('/devices')
      .then(({ data }) => setDevices(data))
      .catch(() => setError('We couldn’t load the speakers.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchDevices();
    api.get('/babies', { params: { status: 'active' } }).then(({ data }) => setActiveBabies(data)).catch(() => {});
    // Poll every 5s, and keep polling even when the tab is in the background, so
    // a device going offline is reflected in near-real-time (~45s server-side)
    // without the operator having to refocus the tab. Refresh immediately on
    // refocus too, so returning to the tab never shows a stale state.
    const interval = setInterval(fetchDevices, 5000);
    const onVisible = () => { if (document.visibilityState === 'visible') fetchDevices(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [fetchDevices]);

  // Active babies that don't yet have a speaker (for the assign picker).
  const assignedBabyIds = new Set(devices.map(d => d.baby_id).filter(Boolean));
  const freeBabies = activeBabies.filter(b => !assignedBabyIds.has(b.id));

  async function unassign(device) {
    setRowError('');
    try { await api.patch(`/devices/${device.id}/assign-baby`, { baby_id: null }); fetchDevices(); }
    catch (err) { setRowError(err.response?.data?.error ?? 'Could not unassign.'); }
  }
  async function toggleActive(device) {
    setRowError('');
    try { await api.patch(`/devices/${device.id}`, { is_active: !device.is_active }); fetchDevices(); }
    catch (err) {
      const msg = err.response?.data?.error ?? 'Could not update the speaker.';
      setRowError(/assigned/i.test(msg) ? 'Unassign the baby from this speaker before deactivating it.' : msg);
    }
  }

  return (
    <div>
      <PageHeader
        title="Speakers"
        subtitle="Monitor the room speakers and assign them to babies"
        actions={<Button icon={<Plus size={16} />} onClick={() => setModal({ type: 'register' })}>Register speaker</Button>}
      />

      {error && <p style={{ color: c.danger }}>{error}</p>}
      {rowError && <p style={{ color: c.danger, marginBottom: 12 }}>{rowError}</p>}

      {loading ? <Spinner /> : devices.length === 0 ? (
        <EmptyState icon={<Radio size={34} color={c.textFaint} />} title="No speakers registered" hint="Register a speaker (Raspberry Pi) to get started." />
      ) : (
        <div style={{ background: c.cardBg, border: `1px solid ${c.border}`, borderRadius: theme.radius.lg, boxShadow: theme.shadow.md, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: c.subtleBg }}>
                  {['Speaker', 'Serving', 'Connection', 'Active', 'Actions'].map(h => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id} style={{ borderTop: `1px solid ${c.border}` }}>
                    <td style={td}>
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{d.device_code}</span>
                    </td>
                    <td style={{ ...td, color: c.textMuted }}>
                      {d.baby_id
                        ? <span><strong style={{ color: c.text }}>{d.baby_first_name} {d.baby_last_name}</strong>{d.room_number ? ` · Room ${d.room_number}` : ''}</span>
                        : <span style={{ color: c.textFaint }}>Not assigned</span>}
                    </td>
                    <td style={td}>
                      <StatusDot color={d.is_online ? c.online : c.offline} label={d.is_online ? 'Connected' : `Offline · last seen ${lastSeen(d.last_seen_at)}`} />
                    </td>
                    <td style={td}><Badge tone={d.is_active ? 'success' : 'neutral'}>{d.is_active ? 'Active' : 'Inactive'}</Badge></td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {d.baby_id
                          ? <Button size="sm" variant="ghost" icon={<Unlink size={13} />} onClick={() => unassign(d)}>Unassign</Button>
                          : <Button size="sm" variant="ghost" icon={<Link2 size={13} />} disabled={!d.is_active} onClick={() => setModal({ type: 'assign', device: d })}>Assign</Button>}
                        {d.is_active
                          ? <Button size="sm" variant="ghost" icon={<PowerOff size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => toggleActive(d)}>Deactivate</Button>
                          : <Button size="sm" variant="ghost" icon={<Power size={13} />} style={{ color: c.success, borderColor: c.successSoft }} onClick={() => toggleActive(d)}>Activate</Button>}
                        <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => setModal({ type: 'delete', device: d })}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal?.type === 'register' && <RegisterModal onClose={() => setModal(null)} onDone={fetchDevices} />}
      {modal?.type === 'assign' && <AssignModal device={modal.device} babies={freeBabies} onClose={() => setModal(null)} onDone={fetchDevices} />}
      {modal?.type === 'delete' && <DeleteModal device={modal.device} onClose={() => setModal(null)} onDone={fetchDevices} />}
    </div>
  );
}
