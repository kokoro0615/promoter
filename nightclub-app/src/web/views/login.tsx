// Sign-in view: dev-issuer login, email-link login (LINE alternative),
// plus the signed-in account panel: email binding + TOTP MFA management.
import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { Err, type Me } from '../ui.js';

export function Login({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const [subject, setSubject] = useState('dev-admin');
  const [name, setName] = useState('Admin User');
  const [err, setErr] = useState<Error | null>(null);
  const login = async () => {
    setErr(null);
    try {
      await call('POST', '/auth/dev/login', { subject, display_name: name });
      onChange();
    } catch (e) { setErr(e as Error); }
  };
  const logout = async () => {
    await call('POST', '/auth/logout', {}).catch(() => undefined);
    onChange();
  };
  return <>
    <div className="card">
      <h1>Sign in</h1>
      <p className="dim">Dev-issuer login (OIDC dev adapter). One personal session carries every membership.</p>
      <div className="grid">
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="subject" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="display name" />
        <div className="row">
          <button onClick={login}>Sign in</button>
          <button className="ghost" onClick={logout}>Sign out</button>
        </div>
        <Err e={err} />
        {me?.user_id && <>
          <p className="ok">signed in as {me.display_name}</p>
          {me.memberships?.map((m) => (
            <p className="dim" key={m.membership_id}>
              {m.store_name} — {m.display_name} ({m.permissions?.length ?? 0} permissions)
            </p>
          ))}
        </>}
      </div>
    </div>
    {!me?.user_id && <EmailLinkLogin onDone={onChange} />}
    {me?.user_id && <>
      <EmailIdentity />
      <MfaPanel />
    </>}
  </>;
}

// Email-link login: request a link for a bound address, redeem the token.
function EmailLinkLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const request = async () => {
    setErr(null);
    try {
      const r = await call<{ dev_token?: string }>(
        'POST', '/auth/email-link/request', { email });
      setSent(true); setDevToken(r.dev_token ?? '');
    } catch (e) { setErr(e as Error); }
  };
  const redeem = async () => {
    setErr(null);
    try {
      await call('POST', '/auth/email-link/redeem', { token });
      onDone();
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h2>Email link sign-in</h2>
    <p className="dim">Passwordless alternative for bound addresses.</p>
    <div className="grid">
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="email address" />
      <div className="row"><button className="ghost" onClick={request}>Send link</button></div>
      {sent && <>
        <p className="ok">If the address is registered, a link was sent.</p>
        {devToken && <p className="dim">dev token: <code>{devToken}</code></p>}
        <input value={token} onChange={(e) => setToken(e.target.value)}
          placeholder="paste token from email" />
        <div className="row"><button onClick={redeem}>Redeem</button></div>
      </>}
      <Err e={err} />
    </div>
  </div>;
}

// Bind an email address to the signed-in account via a link token.
function EmailIdentity() {
  const [email, setEmail] = useState('');
  const [devToken, setDevToken] = useState('');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const bind = async () => {
    setErr(null); setMsg('');
    try {
      const r = await call<{ dev_token?: string }>(
        'POST', '/me/email-identity/bind', { email });
      setDevToken(r.dev_token ?? ''); setMsg('verification link issued');
    } catch (e) { setErr(e as Error); }
  };
  const confirm = async () => {
    setErr(null); setMsg('');
    try {
      const r = await call<{ bound: string }>(
        'POST', '/me/email-identity/confirm', { token });
      setMsg(`bound: ${r.bound}`); setDevToken(''); setToken('');
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h2>Email identity</h2>
    <div className="grid">
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="email to bind" />
      <div className="row"><button className="ghost" onClick={bind}>Issue bind link</button></div>
      {devToken && <p className="dim">dev token: <code>{devToken}</code></p>}
      <input value={token} onChange={(e) => setToken(e.target.value)}
        placeholder="token" />
      <div className="row"><button className="ghost" onClick={confirm}>Confirm</button></div>
      {msg && <p className="ok">{msg}</p>}
      <Err e={err} />
    </div>
  </div>;
}

interface MfaCred { kind: string; status: string; recovery_remaining: number }
function MfaPanel() {
  const [creds, setCreds] = useState<MfaCred[]>([]);
  const [stepped, setStepped] = useState(false);
  const [secret, setSecret] = useState('');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    const r = await call<{ credentials: MfaCred[]; stepped_up: boolean }>(
      'GET', '/me/mfa');
    setCreds(r.credentials); setStepped(r.stepped_up);
  }, []);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  const active = creds.find((x) => x.status === 'ACTIVE');
  const pending = creds.find((x) => x.status === 'PENDING');

  const begin = async () => {
    setErr(null); setMsg(''); setCodes([]);
    try {
      const r = await call<{ secret: string; otpauth_url: string }>(
        'POST', '/me/mfa/totp/begin', {});
      setSecret(r.secret); setUrl(r.otpauth_url);
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const activate = async () => {
    setErr(null);
    try {
      const r = await call<{ recovery_codes: string[] }>(
        'POST', '/me/mfa/totp/activate', { code });
      setCodes(r.recovery_codes); setSecret(''); setUrl(''); setCode('');
      setMsg('TOTP activated — store the recovery codes safely.');
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const stepUp = async () => {
    setErr(null); setMsg('');
    try {
      await call('POST', '/me/mfa/step-up', { code });
      setCode(''); setMsg('session stepped up'); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const disable = async () => {
    setErr(null); setMsg(''); setCodes([]);
    try {
      await call('POST', '/me/mfa/totp/disable', { code });
      setCode(''); setMsg('TOTP disabled'); await refresh();
    } catch (e) { setErr(e as Error); }
  };

  return <div className="card">
    <h2>Two-factor authentication (TOTP)</h2>
    <p className="dim">
      status: {active ? 'enrolled' : pending ? 'enrollment pending' : 'not enrolled'}
      {active && <> · recovery codes left: {active.recovery_remaining}</>}
      {active && <> · step-up: {stepped ? 'fresh' : 'required for money ops'}</>}
    </p>
    {!active && !pending && (
      <div className="row"><button className="ghost" onClick={begin}>Enroll TOTP</button></div>)}
    {(pending || secret) && <div className="grid">
      <p className="dim">Add this secret to your authenticator:</p>
      <p><code>{secret}</code></p>
      {url && <p className="dim small"><code>{url}</code></p>}
      <input inputMode="numeric" value={code}
        onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
      <div className="row"><button onClick={activate}>Activate</button></div>
    </div>}
    {active && <div className="grid">
      <input inputMode="numeric" value={code}
        onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
      <div className="row">
        <button className="ghost" onClick={stepUp}>Step up session</button>
        <button className="danger" onClick={disable}>Disable TOTP</button>
      </div>
    </div>}
    {codes.length > 0 && <div>
      <h3>Recovery codes (shown once)</h3>
      <p className="mono small">{codes.join('  ')}</p>
    </div>}
    {msg && <p className="ok">{msg}</p>}
    <Err e={err} />
  </div>;
}
