import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Pencil, ArrowRightLeft, LogOut, RotateCcw, Baby as BabyIcon, AudioLines, Trash2 } from 'lucide-react';
import api from '../../../api/client';
import { Modal } from '../../../components/ui/Modal';
import { ConfirmDeleteModal } from '../../../components/ui/ConfirmDeleteModal';
import { theme } from '../../../theme';
import { Button, Badge, Field, Select, Spinner, EmptyState, PageHeader } from '../../../components/ui';

const c = theme.color;

// Formats a DB date string (ISO or YYYY-MM-DD) to just the date part for <input type="date">
const toDateInput = (val) => (val ? val.slice(0, 10) : '');
const fmtDate = (val) => (val ? new Date(val).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

// Searchable room picker — type a room number to filter suggestions.
function RoomSelect({ value, onChange, rooms, required }) {
  return (
    <Select
      searchable
      required={required}
      value={value}
      onChange={onChange}
      placeholder="Select a room…"
      searchPlaceholder="Search by room number…"
      emptyText="No rooms found"
      options={rooms.map(r => ({
        value: r.id,
        label: `Room ${r.room_number}`,
        sublabel: `${r.occupied}/${r.capacity} occupied`,
        keywords: String(r.room_number),
      }))}
    />
  );
}

// Shared form for Add and Edit. Edit omits admission_date (not patchable).
function BabyForm({ initial, activeRooms, onSubmit, loading, error }) {
  const isEdit = !!initial;
  const [f, setF] = useState({
    first_name:     initial?.first_name     ?? '',
    last_name:      initial?.last_name      ?? '',
    date_of_birth:  toDateInput(initial?.date_of_birth)  ?? '',
    gender:         initial?.gender         ?? 'male',
    room_id:        initial?.room_id        ?? '',
    admission_date: toDateInput(initial?.admission_date) ?? '',
  });

  const set = (key) => (e) => setF(prev => ({ ...prev, [key]: e.target.value }));
  const setVal = (key) => (v) => setF(prev => ({ ...prev, [key]: v })); // for custom Select (passes value)

  function handleSubmit(e) {
    e.preventDefault();
    if (isEdit) {
      const body = {};
      if (f.first_name    !== initial.first_name)                 body.first_name    = f.first_name;
      if (f.last_name     !== initial.last_name)                  body.last_name     = f.last_name;
      if (f.date_of_birth !== toDateInput(initial.date_of_birth)) body.date_of_birth = f.date_of_birth;
      if (f.gender        !== initial.gender)                     body.gender        = f.gender;
      if (f.room_id       !== initial.room_id)                    body.room_id       = f.room_id;
      onSubmit(body);
    } else {
      onSubmit(f);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
        <Field label="First name" type="text" value={f.first_name} onChange={set('first_name')} required />
        <Field label="Last name" type="text" value={f.last_name} onChange={set('last_name')} required />
        <Field label="Date of birth" type="date" value={f.date_of_birth} onChange={set('date_of_birth')} required />
        <Select
          label="Gender"
          value={f.gender}
          onChange={setVal('gender')}
          options={[
            { value: 'male', label: 'Male' },
            { value: 'female', label: 'Female' },
            { value: 'other', label: 'Other' },
          ]}
        />
        <div style={{ gridColumn: '1 / -1' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: c.text }}>Room</span>
          <RoomSelect value={f.room_id} onChange={setVal('room_id')} rooms={activeRooms} required />
        </div>
        {!isEdit && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Admission date" type="date" value={f.admission_date} onChange={set('admission_date')} required />
          </div>
        )}
      </div>
      {error && <p style={{ color: c.danger, fontSize: 13, marginBottom: 12 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="submit" disabled={loading}>{loading ? 'Saving…' : isEdit ? 'Save changes' : 'Add baby'}</Button>
      </div>
    </form>
  );
}

function RoomPickerModal({ title, onSubmit, onClose, loading, error }) {
  const [availableRooms, setAvailableRooms] = useState([]);
  const [roomId, setRoomId] = useState('');

  useEffect(() => {
    api.get('/rooms/available').then(({ data }) => setAvailableRooms(data)).catch(() => {});
  }, []);

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(roomId); }}>
        <div style={{ marginBottom: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: c.text }}>Select room</span>
          <RoomSelect value={roomId} onChange={setRoomId} rooms={availableRooms} required />
          {availableRooms.length === 0 && (
            <p style={{ fontSize: 13, color: c.warn, marginTop: 6 }}>No rooms with available capacity.</p>
          )}
        </div>
        {error && <p style={{ color: c.danger, fontSize: 13, marginBottom: 10 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={loading}>{loading ? 'Saving…' : 'Confirm'}</Button>
        </div>
      </form>
    </Modal>
  );
}

const FILTERS = ['all', 'active', 'discharged'];

export default function BabiesTab() {
  const navigate = useNavigate();
  const [babies, setBabies]     = useState([]);
  const [filter, setFilter]     = useState('active');
  const [search, setSearch]     = useState('');       // raw input (by ID / record_number)
  const [debounced, setDebounced] = useState('');     // debounced value actually sent to the API
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [modal, setModal]       = useState(null);
  const [saving, setSaving]     = useState(false);
  const [formError, setFormError] = useState('');
  const [activeRooms, setActiveRooms] = useState([]);

  // Debounce the search box so we don't hit the API on every keystroke
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  const fetchBabies = useCallback(() => {
    setLoading(true);
    const params = {};
    if (filter !== 'all') params.status = filter;
    if (debounced) params.search = debounced;   // backend matches record_number (the B-##### ID)
    api.get('/babies', { params })
      .then(({ data }) => setBabies(data))
      .catch(() => setError('We couldn’t load the babies. Please try again.'))
      .finally(() => setLoading(false));
  }, [filter, debounced]);

  useEffect(() => { fetchBabies(); }, [fetchBabies]);

  useEffect(() => {
    if (modal?.type === 'add' || modal?.type === 'edit') {
      api.get('/rooms', { params: { active: 'true' } })
        .then(({ data }) => setActiveRooms(data))
        .catch(() => {});
    }
  }, [modal?.type]);

  function closeModal() { setModal(null); setFormError(''); }

  async function runAction(fn, fallbackMsg) {
    setSaving(true); setFormError('');
    try { await fn(); fetchBabies(); closeModal(); }
    catch (err) { setFormError(err.response?.data?.error ?? fallbackMsg); }
    finally { setSaving(false); }
  }

  const handleAdd      = (body)   => runAction(() => api.post('/babies', body), 'Failed to add baby.');
  const handleEdit     = (body)   => { if (Object.keys(body).length === 0) return closeModal(); return runAction(() => api.patch(`/babies/${modal.baby.id}`, body), 'Failed to update baby.'); };
  const handleDischarge= ()       => runAction(() => api.patch(`/babies/${modal.baby.id}/discharge`), 'Failed to discharge baby.');
  const handleReadmit  = (roomId) => runAction(() => api.patch(`/babies/${modal.baby.id}/readmit`, { room_id: roomId }), 'Failed to readmit baby.');
  const handleReassign = (roomId) => runAction(() => api.patch(`/babies/${modal.baby.id}/reassign-room`, { room_id: roomId }), 'Failed to reassign room.');

  const th = { padding: '10px 14px', color: c.textMuted, fontWeight: 700, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' };
  const td = { padding: '12px 14px', color: c.text, fontSize: 14, verticalAlign: 'middle' };

  return (
    <div>
      <PageHeader
        title="Babies"
        subtitle="Manage babies, rooms, and admissions"
        actions={<Button icon={<Plus size={16} />} onClick={() => setModal({ type: 'add' })}>Add baby</Button>}
      />

      {/* Toolbar: search-by-ID + status filter */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 340 }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <Search size={16} color={c.textMuted} />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by ID (e.g. B-00042)"
            aria-label="Search babies by ID"
            style={{
              width: '100%', padding: '10px 12px 10px 38px', fontSize: 14,
              borderRadius: theme.radius.sm, border: `1.5px solid ${c.border}`,
              background: c.cardBg, color: c.text, outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {FILTERS.map(f => {
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '7px 16px', borderRadius: theme.radius.pill,
                  border: `1.5px solid ${active ? c.accent : c.border}`,
                  background: active ? c.accentSoft : c.cardBg,
                  color: active ? c.accent : c.textMuted,
                  cursor: 'pointer', fontSize: 13, fontWeight: active ? 800 : 600,
                }}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            );
          })}
        </div>
      </div>

      {error && <p style={{ color: c.danger }}>{error}</p>}

      {loading ? (
        <Spinner />
      ) : babies.length === 0 ? (
        <EmptyState
          icon={<BabyIcon size={34} color={c.textFaint} />}
          title={debounced ? `No babies match “${debounced}”` : 'No babies here yet'}
          hint={debounced ? 'Try a different ID, or clear the search.' : 'Add a baby to get started.'}
        />
      ) : (
        <div style={{ background: c.cardBg, border: `1px solid ${c.border}`, borderRadius: theme.radius.lg, boxShadow: theme.shadow.md, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: c.subtleBg }}>
                  {['Name', 'ID', 'DOB', 'Gender', 'Room', 'Status', 'Admitted', 'Actions'].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {babies.map(baby => (
                  <tr key={baby.id} style={{ borderTop: `1px solid ${c.border}` }}>
                    <td style={{ ...td, fontWeight: 700 }}>{baby.first_name} {baby.last_name}</td>
                    <td style={{ ...td, color: c.textMuted, fontVariantNumeric: 'tabular-nums' }}>{baby.record_number ?? '—'}</td>
                    <td style={{ ...td, color: c.textMuted }}>{fmtDate(baby.date_of_birth)}</td>
                    <td style={{ ...td, color: c.textMuted, textTransform: 'capitalize' }}>{baby.gender}</td>
                    <td style={{ ...td, color: c.textMuted }}>{baby.room_number ? `Room ${baby.room_number}` : '—'}</td>
                    <td style={td}><Badge tone={baby.status === 'active' ? 'success' : 'neutral'}>{baby.status === 'active' ? 'Active' : 'Discharged'}</Badge></td>
                    <td style={{ ...td, color: c.textMuted }}>{fmtDate(baby.admission_date)}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Button size="sm" variant="ghost" icon={<AudioLines size={13} />} onClick={() => navigate(`/admin/babies/${baby.id}/recordings`)}>Recordings</Button>
                        {baby.status === 'active' ? (
                          <>
                            <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setModal({ type: 'edit', baby })}>Edit</Button>
                            <Button size="sm" variant="ghost" icon={<ArrowRightLeft size={13} />} onClick={() => setModal({ type: 'reassign', baby })}>Move</Button>
                            <Button size="sm" variant="ghost" icon={<LogOut size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => setModal({ type: 'discharge', baby })}>Discharge</Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} style={{ color: c.success, borderColor: c.successSoft }} onClick={() => setModal({ type: 'readmit', baby })}>Readmit</Button>
                        )}
                        <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => setModal({ type: 'delete', baby })}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal?.type === 'add' && (
        <Modal title="Add baby" onClose={closeModal}>
          <BabyForm activeRooms={activeRooms} onSubmit={handleAdd} loading={saving} error={formError} />
        </Modal>
      )}
      {modal?.type === 'edit' && (
        <Modal title={`Edit ${modal.baby.first_name} ${modal.baby.last_name}`} onClose={closeModal}>
          <BabyForm initial={modal.baby} activeRooms={activeRooms} onSubmit={handleEdit} loading={saving} error={formError} />
        </Modal>
      )}
      {modal?.type === 'discharge' && (
        <Modal title="Discharge baby" onClose={closeModal}>
          <p style={{ marginTop: 0, color: c.text, fontSize: 14 }}>
            Discharge <strong>{modal.baby.first_name} {modal.baby.last_name}</strong>? This will cancel all pending and scheduled recordings.
          </p>
          {formError && <p style={{ color: c.danger, fontSize: 13 }}>{formError}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={closeModal}>Cancel</Button>
            <Button variant="danger" onClick={handleDischarge} disabled={saving}>{saving ? 'Discharging…' : 'Discharge'}</Button>
          </div>
        </Modal>
      )}
      {modal?.type === 'readmit' && (
        <RoomPickerModal title={`Readmit ${modal.baby.first_name} ${modal.baby.last_name}`} onSubmit={handleReadmit} onClose={closeModal} loading={saving} error={formError} />
      )}
      {modal?.type === 'reassign' && (
        <RoomPickerModal title={`Move ${modal.baby.first_name} ${modal.baby.last_name} to a new room`} onSubmit={handleReassign} onClose={closeModal} loading={saving} error={formError} />
      )}
      {modal?.type === 'delete' && (
        <ConfirmDeleteModal
          title="Delete baby"
          body={<>Permanently delete <strong>{modal.baby.first_name} {modal.baby.last_name}</strong> ({modal.baby.record_number})? This removes every recording tied to this baby. A parent linked only to this baby is deleted too; a parent who also has another baby is kept and just unlinked. This cannot be undone.</>}
          onDelete={(force) => api.delete(`/babies/${modal.baby.id}${force ? '?force=true' : ''}`)}
          escalateKey="requires_force"
          escalateTitle="Delete the baby and its data?"
          escalateBody={(_n, data) => (
            <>Deleting <strong>{modal.baby.first_name} {modal.baby.last_name}</strong> will <strong>permanently erase</strong> <strong>{data?.recordings ?? 0}</strong> recording(s)
              {data?.parents ? <> and <strong>{data.parents}</strong> parent account(s) linked only to this baby</> : null}
              {data?.unlinked_parents ? <>. {data.unlinked_parents} parent(s) with other babies will be kept and unlinked</> : null}. This cannot be undone.</>
          )}
          escalateLabel={(_n, data) => `Delete baby${data?.recordings ? ` + ${data.recordings} recording(s)` : ''}${data?.parents ? ` + ${data.parents} parent(s)` : ''}`}
          onClose={closeModal}
          onDone={fetchBabies}
        />
      )}
    </div>
  );
}
