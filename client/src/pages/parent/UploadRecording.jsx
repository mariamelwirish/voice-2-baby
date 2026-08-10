import { useState, useRef, useEffect } from 'react';
import { UploadCloud, Music, Mic, Square, RotateCcw, Trash2, Send } from 'lucide-react';
import api from '../../api/client';
import { Modal } from '../../components/ui/Modal';
import { theme } from '../../theme';
import { Button, Field } from '../../components/ui';

const c = theme.color;

// Pick a recording container the browser actually supports. Chrome/Firefox do
// webm/opus; Safari does mp4. We keep the blob's audio/* MIME so the server's
// multer audio-only filter accepts it and music-metadata can read the duration.
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
}

// Extension for the uploaded filename, derived from the blob MIME.
function extFor(mime = '') {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'audio';
}

const fmtElapsed = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function UploadRecording({ baby, onClose, onUploaded }) {
  const [mode, setMode] = useState('record'); // 'record' | 'upload'
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Upload mode
  const [file, setFile] = useState(null);

  // Record mode
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [recordedUrl, setRecordedUrl] = useState(''); // object URL for playback

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  // Release the mic + any timers/object URLs when the modal unmounts.
  useEffect(() => () => {
    stopTracks();
    if (timerRef.current) clearInterval(timerRef.current);
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
  }, [recordedUrl]);

  function stopTracks() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
        stopTracks();
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } catch (err) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Please allow microphone access and try again.'
          : 'We couldn’t start recording. Check that a microphone is connected.'
      );
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  // Clear the current take so the parent can record again from scratch.
  function resetRecording() {
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedBlob(null);
    setRecordedUrl('');
    setElapsed(0);
    setError('');
  }

  const hasAudio = mode === 'record' ? !!recordedBlob : !!file;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (mode === 'record' && recording) { setError('Please stop the recording before sending.'); return; }
    if (!hasAudio) {
      setError(mode === 'record' ? 'Please record a message first.' : 'Please choose an audio file to send.');
      return;
    }

    const formData = new FormData();
    if (mode === 'record') {
      const ext = extFor(recordedBlob.type);
      formData.append('audio', recordedBlob, `message-${Date.now()}.${ext}`);
    } else {
      formData.append('audio', file);
    }
    formData.append('baby_id', baby.id);
    formData.append('title', title.trim());
    formData.append('description', description.trim());

    setLoading(true);
    try {
      await api.post('/recordings', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      onUploaded();
    } catch (err) {
      setError(err.response?.data?.error ?? 'We couldn’t send your message. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // Switching modes clears the other mode's pending audio to avoid confusion.
  function switchMode(next) {
    if (next === mode) return;
    if (recording) stopRecording();
    resetRecording();
    setFile(null);
    setError('');
    setMode(next);
  }

  const tabStyle = (active) => ({
    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '10px 12px', borderRadius: theme.radius.sm, cursor: 'pointer', fontSize: 14,
    fontWeight: active ? 800 : 600,
    border: `1.5px solid ${active ? c.accent : c.border}`,
    background: active ? c.accentSoft : c.cardBg,
    color: active ? c.accent : c.textMuted,
  });

  return (
    <Modal title={`New message for ${baby.first_name}`} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {/* Mode toggle: record on the spot, or upload a file */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <button type="button" style={tabStyle(mode === 'record')} onClick={() => switchMode('record')}>
            <Mic size={16} /> Record now
          </button>
          <button type="button" style={tabStyle(mode === 'upload')} onClick={() => switchMode('upload')}>
            <UploadCloud size={16} /> Upload a file
          </button>
        </div>

        <Field label="Title" type="text" value={title} onChange={e => setTitle(e.target.value)} required placeholder="e.g. Goodnight song" style={{ marginBottom: 14 }} />
        <Field as="textarea" label="Description" value={description} onChange={e => setDescription(e.target.value)} required rows={3} placeholder="A short note about your message" style={{ marginBottom: 16 }} />

        <span style={{ fontSize: 13, fontWeight: 700, color: c.text }}>Audio</span>

        {/* ---------------------------- RECORD MODE ---------------------------- */}
        {mode === 'record' && (
          <div style={{ marginTop: 6, marginBottom: 18, padding: 18, borderRadius: theme.radius.md, border: `1.5px solid ${c.border}`, background: c.subtleBg }}>
            {!recordedBlob ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                {recording ? (
                  <>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: c.danger, fontWeight: 800, fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ width: 12, height: 12, borderRadius: '50%', background: c.danger, animation: 'rr-pulse 1s ease-in-out infinite' }} />
                      {fmtElapsed(elapsed)}
                    </div>
                    <Button type="button" variant="danger" icon={<Square size={15} />} onClick={stopRecording}>Stop recording</Button>
                  </>
                ) : (
                  <>
                    <div style={{ width: 56, height: 56, borderRadius: '50%', background: c.accentSoft, color: c.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Mic size={26} />
                    </div>
                    <div style={{ fontSize: 13, color: c.textMuted, textAlign: 'center' }}>Tap to record your voice message.</div>
                    <Button type="button" icon={<Mic size={16} />} onClick={startRecording}>Start recording</Button>
                  </>
                )}
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: c.textMuted, marginBottom: 8 }}>Have a listen before you send it:</div>
                <audio controls src={recordedUrl} style={{ width: '100%' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <Button type="button" variant="ghost" icon={<RotateCcw size={15} />} onClick={resetRecording}>Re-record</Button>
                  <Button type="button" variant="ghost" icon={<Trash2 size={15} />} style={{ color: c.danger, borderColor: c.dangerSoft }} onClick={resetRecording}>Delete</Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------------------- UPLOAD MODE ---------------------------- */}
        {mode === 'upload' && (
          <label style={{
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, marginBottom: 18,
            padding: '16px', borderRadius: theme.radius.md, border: `1.5px dashed ${c.borderStrong}`,
            background: c.subtleBg, cursor: 'pointer',
          }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: c.accentSoft, color: c.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {file ? <Music size={20} /> : <UploadCloud size={20} />}
            </div>
            <div style={{ minWidth: 0 }}>
              {file ? (
                <>
                  <div style={{ fontWeight: 700, color: c.text, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                  <div style={{ fontSize: 12, color: c.textMuted }}>{(file.size / 1024 / 1024).toFixed(2)} MB · tap to change</div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, color: c.text, fontSize: 14 }}>Choose an audio file</div>
                  <div style={{ fontSize: 12, color: c.textMuted }}>A voice recording from your device</div>
                </>
              )}
            </div>
            <input type="file" accept="audio/*" onChange={e => setFile(e.target.files[0] ?? null)} style={{ display: 'none' }} />
          </label>
        )}

        {error && (
          <p style={{ color: c.danger, background: c.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13, margin: '0 0 14px' }}>{error}</p>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={loading || !hasAudio || recording} icon={<Send size={16} />}>{loading ? 'Sending…' : 'Send message'}</Button>
        </div>
      </form>
    </Modal>
  );
}
