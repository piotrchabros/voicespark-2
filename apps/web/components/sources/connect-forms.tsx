'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface ConsentView {
  title: string;
  items: string[];
}

interface Props {
  consent: { gmail: ConsentView; microsoft: ConsentView; imap: ConsentView };
}

const IMAP_ERRORS: Record<string, string> = {
  imap_auth_failed: 'The mail server rejected the username or app password.',
  imap_connection_failed: 'Could not reach the mail server. Check the host, port and TLS mode.',
};

function Consent({ view }: { view: ConsentView }) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <h3 className="mb-2 font-medium">{view.title}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {view.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function DateRange({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-3 sm:flex-row">
      <legend className="mb-1 text-sm font-medium">Date range (optional, default is full history)</legend>
      <div className="flex flex-1 flex-col gap-1">
        <Label htmlFor="range-from">From</Label>
        <Input id="range-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <Label htmlFor="range-to">To</Label>
        <Input id="range-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
    </fieldset>
  );
}

export function ConnectForms({ consent }: Props) {
  const router = useRouter();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [tlsMode, setTlsMode] = useState<'tls' | 'starttls'>('tls');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const dateRange = from || to ? { dateRange: { from: from || null, to: to || null } } : {};

  async function connectOAuth(provider: 'gmail' | 'microsoft') {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sources/connect/${provider}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dateRange),
      });
      if (!res.ok) throw new Error('connect_failed');
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
      window.location.assign(authorizeUrl);
    } catch {
      setError('Could not start the connection. Try again.');
      setPending(false);
    }
  }

  async function connectImap(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/sources/imap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, port: Number(port), tlsMode, username, password, ...dateRange }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        setError(IMAP_ERRORS[body?.error?.code ?? ''] ?? 'Could not connect this mailbox. Check the details and try again.');
        setPending(false);
        return;
      }
      const { source } = (await res.json()) as { source: { id: string } };
      setPassword('');
      router.push(`/sources/${source.id}`);
    } catch {
      setError('Network error. Try again.');
      setPending(false);
    }
  }

  return (
    <Tabs defaultValue="gmail" onValueChange={() => setError(null)}>
      <TabsList className="h-auto flex-wrap">
        <TabsTrigger value="gmail">Gmail</TabsTrigger>
        <TabsTrigger value="microsoft">Microsoft 365 / Outlook</TabsTrigger>
        <TabsTrigger value="imap">IMAP</TabsTrigger>
      </TabsList>
      {(['gmail', 'microsoft'] as const).map((provider) => (
        <TabsContent key={provider} value={provider} className="flex flex-col gap-4">
          <Consent view={consent[provider]} />
          <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button disabled={pending} onClick={() => connectOAuth(provider)} className="sm:self-start">
            {provider === 'gmail' ? 'Connect Gmail' : 'Connect Microsoft'}
          </Button>
        </TabsContent>
      ))}
      <TabsContent value="imap">
        <form onSubmit={connectImap} className="flex flex-col gap-4">
          <Consent view={consent.imap} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="imap-host">Host</Label>
            <Input id="imap-host" required value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.example.com" />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="imap-port">Port</Label>
              <Input id="imap-port" type="number" required min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="imap-tls">TLS mode</Label>
              <Select value={tlsMode} onValueChange={(v) => setTlsMode(v as 'tls' | 'starttls')}>
                <SelectTrigger id="imap-tls" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tls">TLS</SelectItem>
                  <SelectItem value="starttls">STARTTLS</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="imap-user">Username</Label>
            <Input id="imap-user" required autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="imap-password">App password</Label>
            <Input id="imap-password" type="password" required autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="sm:self-start">
            Connect mailbox
          </Button>
        </form>
      </TabsContent>
    </Tabs>
  );
}
