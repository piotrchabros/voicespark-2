'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface SettingItem {
  key: string;
  value: number;
  defaultValue: number;
  updatedAt: string | null;
}

const LABELS: Record<string, { title: string; help: string }> = {
  'profile.min_authored_words': {
    title: 'Minimum authored words',
    help: 'Authored words a user needs before a tone profile can be generated.',
  },
  'profile.significant_new_content_ratio': {
    title: 'Significant new content ratio',
    help: 'Growth in authored words (0 to 1) after which a profile is marked outdated.',
  },
  'draft.memory_context_limit': {
    title: 'Draft memory context limit',
    help: 'Maximum number of memory items passed to a draft.',
  },
};

function SettingRow({ item }: { item: SettingItem }) {
  const [saved, setSaved] = useState(item);
  const [text, setText] = useState(String(item.value));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = LABELS[item.key] ?? { title: item.key, help: '' };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) {
      setError('Enter a number.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: item.key, value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Could not save the setting.');
        return;
      }
      const data = (await res.json()) as { setting: SettingItem };
      setSaved(data.setting);
      setText(String(data.setting.value));
      toast.success('Setting saved');
    } catch {
      setError('Could not save the setting.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded-lg border p-4">
      <Label htmlFor={item.key} className="text-base font-medium">
        {label.title}
      </Label>
      <p className="text-muted-foreground text-sm">{label.help}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id={item.key}
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="sm:max-w-48"
          aria-invalid={error ? true : undefined}
        />
        <Button type="submit" disabled={pending || text === String(saved.value)}>
          {pending ? 'Saving...' : 'Save'}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Default {saved.defaultValue}
        {saved.updatedAt
          ? `, last changed ${new Date(saved.updatedAt).toLocaleString()}`
          : ', never changed'}
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function SettingsForm({ settings }: { settings: SettingItem[] }) {
  return (
    <div className="flex flex-col gap-4">
      {settings.map((s) => (
        <SettingRow key={s.key} item={s} />
      ))}
    </div>
  );
}
