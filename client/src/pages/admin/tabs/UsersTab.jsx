import { useState, useEffect, useCallback } from 'react';
import {
  UserPlus, Mail, CheckCircle2, AlertTriangle, Activity, Baby as BabyIcon,
  Users as UsersIcon, Stethoscope, Clock, Trash2, Pencil, Unlink, Plus,
} from 'lucide-react';
import api from '../../../api/client';
import { theme } from '../../../theme';
import { Modal } from '../../../components/ui/Modal';
import { ConfirmDeleteModal } from '../../../components/ui/ConfirmDeleteModal';
import { Button, Badge, Field, Select, Spinner, EmptyState, PageHeader } from '../../../components/ui';

const c = theme.color;

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// Account status → friendly badge.
function AccountBadge({ user }) {
  if (!user.invite_used) return <Badge tone="warn">Invite pending</Badge>;
  if (!user.is_active) return <Badge tone="neutral">Deactivated</Badge>;
  return <Badge tone="success">Active</Badge>;
}

/* ----------------------- SES-aware result note ----------------------- */
function emailProbablyFailed(message = '') {
  return /email/i.test(message) && /(fail|not sent|couldn|could not)/i.test(message);
}
function ResultNote({ result }) {
  if (!result) return null;
  const { ok, message } = result;
  const softEmailFail = ok && emailProbablyFailed(message);
  const tone = !ok ? { bg: c.dangerSoft, fg: c.danger, Icon: AlertTriangle }
    : softEmailFail ? { bg: c.warnSoft, fg: c.warn, Icon: AlertTriangle }
    : { bg: c.successSoft, fg: c.success, Icon: CheckCircle2 };
  const text = softEmailFail
    ? 'Account created — but we couldn’t send the invite email automatically. Use “Resend invite” once email is set up, or share their login details directly.'
    : message;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: tone.bg, color: tone.fg, padding: '10px 14px', borderRadius: theme.radius.sm, fontSize: 13, margin: '14px 0 0' }}>
      <tone.Icon size={17} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{text}</span>
    </div>
  );
}

/* ------------------------------ Modals ------------------------------- */
function AddNurseModal({ onClose, onDone }) {
  const [fields, setFields] = useState({ first_name: '', last_name: '', email: '' });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const set = (k) => (e) => setFields(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setLoading(true); setResult(null);
    try {
      const { data } = await api.post('/admin/nurses', fields);
      setResult({ ok: true, message: data.message });
      setFields({ first_name: '', last_name: '', email: '' });
      onDone?.();
    } catch (err) {
      setResult({ ok: false, message: err.response?.data?.error ?? 'Failed to create nurse.' });
    } finally { setLoading(false); }
  }

  return (
    <Modal title="Add a nurse" onClose={onClose}>
      <form onSubmit={submit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="First name" value={fields.first_name} onChange={set('first_name')} required />
          <Field label="Last name" value={fields.last_name} onChange={set('last_name')} required />
        </div>
        <Field label="Email" type="email" value={fields.email} onChange={set('email')} required style={{ marginTop: 12 }} />
        <ResultNote result={result} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="submit" disabled={loading} icon={<UserPlus size={16} />}>{loading ? 'Creating…' : 'Create & invite'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AddParentModal({ onClose, onDone }) {
  const [babies, setBabies] = useState([]);
  const [fields, setFields] = useState({ first_name: '', last_name: '', email: '', baby_id: '', relationship: 'primary' });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/babies', { params: { status: 'active' } }).then(({ data }) => setBabies(data)).catch(() => {});
  }, []);
  const set = (k) => (e) => setFields(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setLoading(true); setResult(null);
    try {
      const { data } = await api.post('/admin/parents', fields);
      setResult({ ok: true, message: data.message });
      setFields({ first_name: '', last_name: '', email: '', baby_id: '', relationship: 'primary' });
      onDone?.();
    } catch (err) {
      setResult({ ok: false, message: err.response?.data?.error ?? 'Failed to add parent.' });
    } finally { setLoading(false); }
  }

  return (
    <Modal title="Add a parent" onClose={onClose}>
      <form onSubmit={submit}>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: c.textMuted }}>
          If the parent already has an account, just their email and the baby are needed. A name is required only for brand-new accounts.
        </p>
        <Field label="Email" type="email" value={fields.email} onChange={set('email')} required />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
          <Field label="First name" hint="New accounts only" value={fields.first_name} onChange={set('first_name')} />
          <Field label="Last name" hint="New accounts only" value={fields.last_name} onChange={set('last_name')} />
        </div>
        <Select
          label="Baby" searchable required value={fields.baby_id}
          onChange={(v) => setFields(f => ({ ...f, baby_id: v }))}
          searchPlaceholder="Search by ID or name…" emptyText="No babies found" style={{ marginTop: 12 }}
          options={babies.map(b => ({ value: b.id, label: `${b.first_name} ${b.last_name}`, sublabel: b.record_number, keywords: `${b.record_number ?? ''} ${b.first_name} ${b.last_name}` }))}
        />
        <Select
          label="Relationship" value={fields.relationship}
          onChange={(v) => setFields(f => ({ ...f, relationship: v }))} style={{ marginTop: 12 }}
          options={[{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }]}
        />
        <ResultNote result={result} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="submit" disabled={loading} icon={<UserPlus size={16} />}>{loading ? 'Adding…' : 'Add parent'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResendInviteModal({ email, onClose }) {
  const [value, setValue] = useState(email ?? '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setLoading(true); setResult(null);
    try {
      const { data } = await api.post('/admin/resend-invite', { email: value });
      setResult({ ok: true, message: data.message });
    } catch (err) {
      setResult({ ok: false, message: err.response?.data?.error ?? 'Failed to resend invite.' });
    } finally { setLoading(false); }
  }

  return (
    <Modal title="Resend invite" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Account email" type="email" value={value} onChange={e => setValue(e.target.value)} required />
        <ResultNote result={result} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="submit" disabled={loading} icon={<Mail size={16} />}>{loading ? 'Sending…' : 'Resend invite'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Edit a parent's baby links. The one firm rule: a parent must always keep at
// least one baby, so the last remaining link cannot be unlinked (the backend
// enforces this too). Use this to fix a baby linked by mistake.
function EditParentModal({ parent, onClose, onDone }) {
  const [babies, setBabies] = useState(parent.babies ?? []);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const isLast = babies.length <= 1;

  // Link-another-baby state
  const [allBabies, setAllBabies] = useState([]);
  const [linkBabyId, setLinkBabyId] = useState('');
  const [linkRel, setLinkRel] = useState('primary');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    api.get('/babies', { params: { status: 'active' } }).then(({ data }) => setAllBabies(data)).catch(() => {});
  }, []);

  // Active babies this parent isn't linked to yet.
  const linkedIds = new Set(babies.map(b => b.baby_id));
  const availableBabies = allBabies.filter(b => !linkedIds.has(b.id));

  async function unlink(babyId) {
    if (isLast) return;
    setBusyId(babyId); setError('');
    try {
      await api.delete(`/admin/parents/${parent.id}/babies/${babyId}`);
      setBabies(prev => prev.filter(b => b.baby_id !== babyId));
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.error ?? 'Could not unlink this baby.');
    } finally { setBusyId(null); }
  }

  async function link(e) {
    e.preventDefault();
    if (!linkBabyId) { setLinkError('Choose a baby to link.'); return; }
    setLinking(true); setLinkError('');
    try {
      // Reuse the existing "link an existing parent to a baby" path (by email).
      await api.post('/admin/parents', { email: parent.email, baby_id: linkBabyId, relationship: linkRel });
      const baby = allBabies.find(b => b.id === linkBabyId);
      if (baby) {
        setBabies(prev => [...prev, {
          baby_id: baby.id, record_number: baby.record_number,
          first_name: baby.first_name, last_name: baby.last_name,
          relationship: linkRel, status: baby.status,
        }]);
      }
      setLinkBabyId(''); setLinkRel('primary');
      onDone?.();
    } catch (err) {
      setLinkError(err.response?.data?.error ?? 'Could not link this baby.');
    } finally { setLinking(false); }
  }

  return (
    <Modal title={`Edit ${parent.first_name} ${parent.last_name}`} onClose={onClose} maxWidth={520}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: c.textMuted }}>
        {parent.hospital_id} · {parent.email}
      </p>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: c.textMuted }}>
        Linked babies. Unlink one that was added by mistake — a parent must stay linked to at least one baby, so the last one can’t be removed.
      </p>
      {error && <p style={{ color: c.danger, background: c.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13 }}>{error}</p>}
      {babies.length === 0 ? (
        <EmptyState icon={<BabyIcon size={30} color={c.textFaint} />} title="No linked babies" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {babies.map(b => (
            <div key={b.baby_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: `1px solid ${c.border}`, borderRadius: theme.radius.md, padding: '10px 12px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, minWidth: 0 }}>
                <BabyIcon size={15} color={c.accent} />
                <strong style={{ color: c.text }}>{b.first_name} {b.last_name}</strong>
                <span style={{ color: c.textMuted }}>{b.record_number}</span>
                <Badge tone={b.relationship === 'primary' ? 'accent' : 'neutral'}>{b.relationship}</Badge>
              </span>
              <Button
                size="sm" variant="ghost" icon={<Unlink size={13} />}
                style={{ color: isLast ? c.textFaint : c.danger, borderColor: isLast ? c.border : c.dangerSoft }}
                disabled={isLast || busyId === b.baby_id}
                title={isLast ? 'A parent must stay linked to at least one baby.' : undefined}
                onClick={() => unlink(b.baby_id)}
              >
                {busyId === b.baby_id ? 'Unlinking…' : 'Unlink'}
              </Button>
            </div>
          ))}
        </div>
      )}
      {isLast && babies.length === 1 && (
        <p style={{ margin: '12px 0 0', fontSize: 12, color: c.textMuted }}>
          This is the parent’s only baby. Link another baby first if you need to remove this one.
        </p>
      )}

      {/* Link another baby */}
      <form onSubmit={link} style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${c.border}` }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: c.text, marginBottom: 10 }}>Link another baby</div>
        <Select
          label="Baby" searchable value={linkBabyId} onChange={setLinkBabyId}
          placeholder="Select a baby…" searchPlaceholder="Search by ID or name…" emptyText="No other active babies"
          options={availableBabies.map(b => ({ value: b.id, label: `${b.first_name} ${b.last_name}`, sublabel: `${b.record_number ?? ''}${b.room_number ? ` · Room ${b.room_number}` : ''}`, keywords: `${b.record_number ?? ''} ${b.first_name} ${b.last_name}` }))}
        />
        <Select
          label="Relationship" value={linkRel} onChange={setLinkRel} style={{ marginTop: 12 }}
          options={[{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }]}
        />
        {linkError && <p style={{ color: c.danger, fontSize: 13, marginTop: 10 }}>{linkError}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <Button type="submit" disabled={linking || !linkBabyId} icon={<Plus size={16} />}>{linking ? 'Linking…' : 'Link baby'}</Button>
        </div>
      </form>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

// What a nurse's action means, in plain language.
const ACTION_LABEL = {
  scheduled: 'Scheduled a message',
  rejected: 'Declined a message',
  played: 'Played a message',
  pending_review: 'Returned a message to review',
  cancelled: 'Cancelled a message',
};
const ACTION_TONE = { scheduled: 'info', rejected: 'danger', played: 'success', pending_review: 'warn', cancelled: 'neutral' };

function NurseActivityModal({ nurse, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/admin/nurses/${nurse.id}/activity`)
      .then(({ data }) => setData(data))
      .catch(() => setError('Couldn’t load this nurse’s activity.'));
  }, [nurse.id]);

  return (
    <Modal title={`${nurse.first_name} ${nurse.last_name} — activity`} onClose={onClose} maxWidth={620}>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: c.textMuted }}>
        {nurse.hospital_id} · {nurse.email}
      </p>
      {error && <p style={{ color: c.danger }}>{error}</p>}
      {!data && !error && <Spinner label="Loading activity…" />}
      {data && data.activity.length === 0 && (
        <EmptyState icon={<Activity size={30} color={c.textFaint} />} title="No activity yet" hint="This nurse hasn’t reviewed or played any messages." />
      )}
      {data && data.activity.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
          {data.activity.map(a => (
            <div key={a.id} style={{ border: `1px solid ${c.border}`, borderRadius: theme.radius.md, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Badge tone={ACTION_TONE[a.to_status] ?? 'neutral'}>{ACTION_LABEL[a.to_status] ?? a.to_status}</Badge>
                <span style={{ fontSize: 12, color: c.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={12} /> {fmtDateTime(a.changed_at)}
                </span>
              </div>
              <div style={{ fontSize: 14, color: c.text, marginTop: 8 }}>
                “{a.recording_title}” for <strong>{a.baby_first_name} {a.baby_last_name}</strong>
                {a.record_number && <span style={{ color: c.textMuted }}> ({a.record_number})</span>}
              </div>
              {a.note && <div style={{ fontSize: 13, color: c.textMuted, marginTop: 4 }}>Note: {a.note}</div>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------ Rosters ------------------------------ */
const th = { padding: '10px 14px', color: c.textMuted, fontWeight: 700, fontSize: 12, textAlign: 'left', whiteSpace: 'nowrap' };
const td = { padding: '12px 14px', color: c.text, fontSize: 14, verticalAlign: 'middle' };

function TableWrap({ children }) {
  return (
    <div style={{ background: c.cardBg, border: `1px solid ${c.border}`, borderRadius: theme.radius.lg, boxShadow: theme.shadow.md, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table>
      </div>
    </div>
  );
}

export function NursesTab() {
  const [nurses, setNurses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // { type, nurse? }

  const fetchNurses = useCallback(() => {
    setLoading(true);
    api.get('/admin/nurses').then(({ data }) => setNurses(data)).catch(() => setError('Couldn’t load nurses.')).finally(() => setLoading(false));
  }, []);
  useEffect(() => { fetchNurses(); }, [fetchNurses]);

  return (
    <div>
      <PageHeader
        title="Nurses"
        subtitle="The care team and what each nurse has done"
        actions={<Button icon={<UserPlus size={16} />} onClick={() => setModal({ type: 'add' })}>Add nurse</Button>}
      />
      {error && <p style={{ color: c.danger }}>{error}</p>}
      {loading ? <Spinner /> : nurses.length === 0 ? (
        <EmptyState icon={<Stethoscope size={34} color={c.textFaint} />} title="No nurses yet" hint="Add a nurse to get started." />
      ) : (
        <TableWrap>
          <thead>
            <tr style={{ background: c.subtleBg }}>
              {['Name', 'ID', 'Email', 'Status', 'Work done', 'Last active', ''].map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {nurses.map(n => (
              <tr key={n.id} style={{ borderTop: `1px solid ${c.border}` }}>
                <td style={{ ...td, fontWeight: 700 }}>{n.first_name} {n.last_name}</td>
                <td style={{ ...td, color: c.textMuted }}>{n.hospital_id}</td>
                <td style={{ ...td, color: c.textMuted }}>{n.email}</td>
                <td style={td}><AccountBadge user={n} /></td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <Badge tone="info">{Number(n.scheduled_count)} scheduled</Badge>
                    <Badge tone="success">{Number(n.played_count)} played</Badge>
                    <Badge tone="danger">{Number(n.rejected_count)} declined</Badge>
                  </div>
                </td>
                <td style={{ ...td, color: c.textMuted }}>{n.last_action_at ? fmtDate(n.last_action_at) : '—'}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="ghost" icon={<Activity size={13} />} onClick={() => setModal({ type: 'activity', nurse: n })}>Activity</Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => setModal({ type: 'delete', nurse: n })}>Delete</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal?.type === 'add' && <AddNurseModal onClose={() => setModal(null)} onDone={fetchNurses} />}
      {modal?.type === 'activity' && <NurseActivityModal nurse={modal.nurse} onClose={() => setModal(null)} />}
      {modal?.type === 'delete' && (
        <ConfirmDeleteModal
          title="Delete nurse"
          body={<>Permanently delete <strong>{modal.nurse.first_name} {modal.nurse.last_name}</strong> ({modal.nurse.hospital_id})? This removes their account for good and cannot be undone.</>}
          onDelete={(force) => api.delete(`/admin/nurses/${modal.nurse.id}${force ? '?force=true' : ''}`)}
          escalateKey="activity_records"
          escalateTitle="Delete the nurse and their activity log?"
          escalateBody={(n) => <><strong>{modal.nurse.first_name} {modal.nurse.last_name}</strong> has <strong>{n}</strong> recorded action(s) in the system’s history. Continuing will <strong>permanently erase that activity log</strong>. This cannot be undone.</>}
          escalateLabel={(n) => `Delete nurse + ${n} record(s)`}
          onClose={() => setModal(null)}
          onDone={fetchNurses}
        />
      )}
    </div>
  );
}

export function ParentsTab() {
  const [parents, setParents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // { type, email? }

  const fetchParents = useCallback(() => {
    setLoading(true);
    api.get('/admin/parents').then(({ data }) => setParents(data)).catch(() => setError('Couldn’t load parents.')).finally(() => setLoading(false));
  }, []);
  useEffect(() => { fetchParents(); }, [fetchParents]);

  return (
    <div>
      <PageHeader
        title="Parents"
        subtitle="Families and which baby each parent is linked to"
        actions={<Button icon={<UserPlus size={16} />} onClick={() => setModal({ type: 'add' })}>Add parent</Button>}
      />
      {error && <p style={{ color: c.danger }}>{error}</p>}
      {loading ? <Spinner /> : parents.length === 0 ? (
        <EmptyState icon={<UsersIcon size={34} color={c.textFaint} />} title="No parents yet" hint="Add a parent and link them to a baby." />
      ) : (
        <TableWrap>
          <thead>
            <tr style={{ background: c.subtleBg }}>
              {['Name', 'ID', 'Email', 'Linked babies', 'Status', ''].map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {parents.map(p => (
              <tr key={p.id} style={{ borderTop: `1px solid ${c.border}` }}>
                <td style={{ ...td, fontWeight: 700 }}>{p.first_name} {p.last_name}</td>
                <td style={{ ...td, color: c.textMuted }}>{p.hospital_id}</td>
                <td style={{ ...td, color: c.textMuted }}>{p.email}</td>
                <td style={td}>
                  {p.babies.length === 0 ? <span style={{ color: c.textFaint }}>Not linked</span> : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {p.babies.map(b => (
                        <span key={b.baby_id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          <BabyIcon size={13} color={c.accent} />
                          <span style={{ fontWeight: 600 }}>{b.first_name} {b.last_name}</span>
                          <span style={{ color: c.textMuted }}>{b.record_number}</span>
                          <Badge tone={b.relationship === 'primary' ? 'accent' : 'neutral'}>{b.relationship}</Badge>
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td style={td}><AccountBadge user={p} /></td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setModal({ type: 'edit', parent: p })}>Edit</Button>
                    {!p.invite_used && (
                      <Button size="sm" variant="ghost" icon={<Mail size={13} />} onClick={() => setModal({ type: 'resend', email: p.email })}>Resend invite</Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={() => setModal({ type: 'delete', parent: p })}>Delete</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal?.type === 'add' && <AddParentModal onClose={() => setModal(null)} onDone={fetchParents} />}
      {modal?.type === 'edit' && <EditParentModal parent={modal.parent} onClose={() => setModal(null)} onDone={fetchParents} />}
      {modal?.type === 'resend' && <ResendInviteModal email={modal.email} onClose={() => setModal(null)} />}
      {modal?.type === 'delete' && (
        <ConfirmDeleteModal
          title="Delete parent"
          body={<>Permanently delete <strong>{modal.parent.first_name} {modal.parent.last_name}</strong> ({modal.parent.hospital_id})? This removes their account and unlinks them from any babies. This cannot be undone.</>}
          onDelete={(force) => api.delete(`/admin/parents/${modal.parent.id}${force ? '?force=true' : ''}`)}
          escalateKey="recordings"
          escalateTitle="Delete the parent and all their messages?"
          escalateBody={(n) => <><strong>{modal.parent.first_name} {modal.parent.last_name}</strong> has sent <strong>{n}</strong> recording(s). Continuing will <strong>permanently erase those messages and their history</strong>. This cannot be undone.</>}
          escalateLabel={(n) => `Delete parent + ${n} recording(s)`}
          onClose={() => setModal(null)}
          onDone={fetchParents}
        />
      )}
    </div>
  );
}

