import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Ban, RotateCcw, DoorOpen, Trash2 } from 'lucide-react';
import api from '../../../api/client';
import { Modal } from '../../../components/ui/Modal';
import { ConfirmDeleteModal } from '../../../components/ui/ConfirmDeleteModal';
import { theme } from '../../../theme';
import { Button, Badge, Field, Spinner, EmptyState, PageHeader } from '../../../components/ui';

const c = theme.color;

function RoomForm({ initial, onSubmit, loading, error }) {
  const [roomNumber, setRoomNumber] = useState(initial?.room_number ?? '');
  const [capacity, setCapacity]     = useState(initial?.capacity ?? 1);

  function handleSubmit(e) {
    e.preventDefault();
    const body = {};
    if (roomNumber !== (initial?.room_number ?? '')) body.room_number = roomNumber;
    if (capacity   !== (initial?.capacity   ?? 1))  body.capacity = Number(capacity);
    if (!initial) { body.room_number = roomNumber; body.capacity = Number(capacity); }
    onSubmit(body);
  }

  return (
    <form onSubmit={handleSubmit}>
      <Field label="Room number" type="text" value={roomNumber} onChange={e => setRoomNumber(e.target.value)} required placeholder="e.g. 2A" style={{ marginBottom: 14 }} />
      <Field label="Capacity" type="number" value={capacity} min={1} onChange={e => setCapacity(e.target.value)} required hint="1 for a single room, 2 for a twin room" style={{ marginBottom: 14 }} />
      {error && <p style={{ color: c.danger, fontSize: 13, marginBottom: 12 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="submit" disabled={loading}>{loading ? 'Saving…' : initial ? 'Save changes' : 'Add room'}</Button>
      </div>
    </form>
  );
}

export default function RoomsTab() {
  const [rooms, setRooms]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [modal, setModal]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const fetchRooms = useCallback(() => {
    setLoading(true);
    api.get('/rooms')
      .then(({ data }) => setRooms(data))
      .catch(() => setError('We couldn’t load the rooms. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchRooms(); }, [fetchRooms]);

  function closeModal() { setModal(null); setFormError(''); }

  async function handleAdd(body) {
    setSaving(true); setFormError('');
    try { await api.post('/rooms', body); fetchRooms(); closeModal(); }
    catch (err) { setFormError(err.response?.data?.error ?? 'Failed to create room.'); }
    finally { setSaving(false); }
  }

  async function handleEdit(body) {
    setSaving(true); setFormError('');
    try { await api.patch(`/rooms/${modal.room.id}`, body); fetchRooms(); closeModal(); }
    catch (err) { setFormError(err.response?.data?.error ?? 'Failed to update room.'); }
    finally { setSaving(false); }
  }

  async function handleDeactivate() {
    setSaving(true); setFormError('');
    try { await api.patch(`/rooms/${modal.room.id}/deactivate`); fetchRooms(); closeModal(); }
    catch (err) {
      const data = err.response?.data;
      if (data?.babies?.length) {
        const names = data.babies.map(b => `${b.first_name} ${b.last_name}`).join(', ');
        setFormError(`${data.error} Active babies: ${names}.`);
      } else {
        setFormError(data?.error ?? 'Failed to deactivate room.');
      }
    } finally { setSaving(false); }
  }

  async function handleReactivate(room) {
    try { await api.patch(`/rooms/${room.id}/reactivate`); fetchRooms(); }
    catch (err) { setError(err.response?.data?.error ?? 'Failed to reactivate room.'); }
  }

  const th = { padding: '10px 14px', color: c.textMuted, fontWeight: 700, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' };
  const td = { padding: '12px 14px', color: c.text, fontSize: 14, verticalAlign: 'middle' };

  return (
    <div>
      <PageHeader
        title="Rooms"
        subtitle="Manage NICU rooms and their capacity"
        actions={<Button icon={<Plus size={16} />} onClick={() => setModal({ type: 'add' })}>Add room</Button>}
      />

      {error && <p style={{ color: c.danger }}>{error}</p>}

      {loading ? (
        <Spinner />
      ) : rooms.length === 0 ? (
        <EmptyState icon={<DoorOpen size={34} color={c.textFaint} />} title="No rooms yet" hint="Add a room to get started." />
      ) : (
        <div style={{ background: c.cardBg, border: `1px solid ${c.border}`, borderRadius: theme.radius.lg, boxShadow: theme.shadow.md, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: c.subtleBg }}>
                  {['Room', 'Capacity', 'Occupied', 'Status', 'Actions'].map(h => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rooms.map(room => (
                  <tr key={room.id} style={{ borderTop: `1px solid ${c.border}` }}>
                    <td style={{ ...td, fontWeight: 700 }}>Room {room.room_number}</td>
                    <td style={{ ...td, color: c.textMuted }}>{room.capacity}</td>
                    <td style={{ ...td, color: c.textMuted }}>{room.occupied}</td>
                    <td style={td}><Badge tone={room.is_active ? 'success' : 'neutral'}>{room.is_active ? 'Active' : 'Inactive'}</Badge></td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setModal({ type: 'edit', room })}>Edit</Button>
                        {room.is_active ? (
                          <Button size="sm" variant="ghost" icon={<Ban size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => setModal({ type: 'deactivate', room })}>Deactivate</Button>
                        ) : (
                          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} style={{ color: c.success, borderColor: c.successSoft }} onClick={() => handleReactivate(room)}>Reactivate</Button>
                        )}
                        <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => setModal({ type: 'delete', room })}>Delete</Button>
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
        <Modal title="Add room" onClose={closeModal}>
          <RoomForm onSubmit={handleAdd} loading={saving} error={formError} />
        </Modal>
      )}
      {modal?.type === 'edit' && (
        <Modal title={`Edit Room ${modal.room.room_number}`} onClose={closeModal}>
          <RoomForm initial={modal.room} onSubmit={handleEdit} loading={saving} error={formError} />
        </Modal>
      )}
      {modal?.type === 'deactivate' && (
        <Modal title="Deactivate room" onClose={closeModal}>
          <p style={{ color: c.text, marginTop: 0, fontSize: 14 }}>
            Deactivate <strong>Room {modal.room.room_number}</strong>? It must have no active babies first.
          </p>
          {formError && <p style={{ color: c.danger, fontSize: 13 }}>{formError}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={closeModal}>Cancel</Button>
            <Button variant="danger" onClick={handleDeactivate} disabled={saving}>{saving ? 'Deactivating…' : 'Deactivate'}</Button>
          </div>
        </Modal>
      )}
      {modal?.type === 'delete' && (
        <ConfirmDeleteModal
          title="Delete room"
          body={<>Permanently delete <strong>Room {modal.room.room_number}</strong>? This cannot be undone. A room with any babies still linked to it can’t be deleted — move or delete those babies first.</>}
          onDelete={() => api.delete(`/rooms/${modal.room.id}`)}
          onClose={closeModal}
          onDone={fetchRooms}
        />
      )}
    </div>
  );
}
