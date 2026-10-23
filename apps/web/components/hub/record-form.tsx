'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { hubApiError, KIND_LABELS, STATUS_LABELS, type HubKind, type HubRecord, type ProjectStatus } from './labels';
import { SimilarWarning, type SimilarRecord } from './similar-warning';

// Limits mirror data-model.md and contracts/http-api.md; the server stays authoritative.
const NAME_MAX = 200;
const ROLE_MAX = 200;
const PHONE_MAX = 50;
const PHONE_RE = /^[0-9+()\-.\s/x]*$/;
const EMAIL_MAX = 320;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const INDUSTRY_MAX = 200;
const DESCRIPTION_MAX = 2000;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailError(address: string): string | null {
  if (!address) return 'Enter an email address.';
  if (address.length > EMAIL_MAX) return `Email must be at most ${EMAIL_MAX} characters.`;
  if (!EMAIL_RE.test(address)) return 'Enter a valid email address.';
  return null;
}

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase();
}

export function domainError(domain: string): string | null {
  if (!domain) return 'Enter a domain.';
  if (domain.startsWith('www.')) return 'Enter the domain without "www.".';
  if (!DOMAIN_RE.test(domain)) return 'Enter a valid domain, for example example.com.';
  return null;
}

function websiteError(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? null
      : 'Website must start with http:// or https://.';
  } catch {
    return 'Enter a valid website address.';
  }
}

interface ValueItem {
  id?: string;
  value: string;
  origin?: 'user' | 'email';
}

// Multi-value input: local list on create; on edit each add/remove goes straight to the API.
function MultiValueField({
  label,
  listLabel,
  addLabel,
  items,
  validate,
  normalize,
  onAdd,
  onRemove,
  busy,
}: {
  label: string;
  listLabel: string;
  addLabel: string;
  items: ValueItem[];
  validate: (v: string) => string | null;
  normalize: (v: string) => string;
  onAdd: (value: string) => Promise<boolean>;
  onRemove: (item: ValueItem) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = `hub-${label.toLowerCase().replace(/\s+/g, '-')}`;

  async function add() {
    const value = normalize(draft);
    if (!value) return;
    const err = validate(value) ?? (items.some((i) => i.value === value) ? 'Already added.' : null);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    if (await onAdd(value)) setDraft('');
  }

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={inputId}>{label}</Label>
      {items.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={listLabel}>
          {items.map((item) => (
            <li key={item.id ?? item.value} className="flex items-center gap-1">
              <Badge variant="secondary">{item.value}</Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Remove ${item.value}`}
                onClick={() => void onRemove(item)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draft}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button type="button" variant="outline" disabled={busy} onClick={() => void add()}>
          {addLabel}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const orNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

export function RecordForm({
  kind,
  record,
  onSaved,
}: {
  kind: HubKind;
  record?: HubRecord;
  onSaved?: (record: HubRecord) => void;
}) {
  const router = useRouter();
  const editing = Boolean(record);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState(record?.name ?? '');
  const [roleTitle, setRoleTitle] = useState(record?.roleTitle ?? '');
  const [phone, setPhone] = useState(record?.phone ?? '');
  const [website, setWebsite] = useState(record?.website ?? '');
  const [industry, setIndustry] = useState(record?.industry ?? '');
  const [status, setStatus] = useState<ProjectStatus>(record?.status ?? 'planned');
  const [startDate, setStartDate] = useState(record?.startDate ?? '');
  const [endDate, setEndDate] = useState(record?.endDate ?? '');
  const [description, setDescription] = useState(record?.description ?? '');
  const [emails, setEmails] = useState<ValueItem[]>(
    (record?.emails ?? []).map((e) => ({ id: e.id, value: e.address, origin: e.origin })),
  );
  const [domains, setDomains] = useState<ValueItem[]>(
    (record?.domains ?? []).map((d) => ({ id: d.id, value: d.domain, origin: d.origin })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [similar, setSimilar] = useState<SimilarRecord[]>([]);
  const [pending, setPending] = useState(false);

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    const n = name.trim();
    if (n.length < 1) e.name = 'Name is required.';
    else if (n.length > NAME_MAX) e.name = `Name must be at most ${NAME_MAX} characters.`;
    if (kind === 'people') {
      if (roleTitle.length > ROLE_MAX) e.roleTitle = `Role must be at most ${ROLE_MAX} characters.`;
      if (phone.length > PHONE_MAX) e.phone = `Phone must be at most ${PHONE_MAX} characters.`;
      else if (!PHONE_RE.test(phone))
        e.phone = 'Phone may contain digits, + ( ) - . / x and spaces only.';
    }
    if (kind === 'companies') {
      const w = websiteError(website.trim());
      if (w) e.website = w;
      if (industry.length > INDUSTRY_MAX)
        e.industry = `Industry must be at most ${INDUSTRY_MAX} characters.`;
    }
    if (kind === 'projects' && startDate && endDate && endDate < startDate) {
      e.endDate = 'End date must not be before the start date.';
    }
    if (description.length > DESCRIPTION_MAX) {
      e.description = `Description must be at most ${DESCRIPTION_MAX} characters.`;
    }
    return e;
  }

  // Edit mode: contact values are saved one by one through their own routes.
  async function addValue(path: 'emails' | 'domains', value: string): Promise<boolean> {
    const setList = path === 'emails' ? setEmails : setDomains;
    if (!record) {
      setList((l) => [...l, { value }]);
      return true;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/hub/${kind}/${record.id}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(path === 'emails' ? { address: value } : { domain: value }),
      });
      if (!res.ok) {
        toast.error(await hubApiError(res));
        return false;
      }
      const body = (await res.json()) as {
        email?: { id: string };
        domain?: { id: string };
        id?: string;
      };
      setList((l) => [
        ...l,
        { id: body.email?.id ?? body.domain?.id ?? body.id, value, origin: 'user' },
      ]);
      return true;
    } catch {
      toast.error('Network error. Try again.');
      return false;
    } finally {
      setPending(false);
    }
  }

  async function removeValue(path: 'emails' | 'domains', item: ValueItem): Promise<void> {
    const setList = path === 'emails' ? setEmails : setDomains;
    if (!record || !item.id) {
      setList((l) => l.filter((i) => i !== item));
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/hub/${kind}/${record.id}/${path}/${item.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) toast.error(await hubApiError(res));
      else setList((l) => l.filter((i) => i !== item));
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  function fields(): Record<string, unknown> {
    const body: Record<string, unknown> = { name: name.trim(), description: orNull(description) };
    if (kind === 'people') {
      body.roleTitle = orNull(roleTitle);
      body.phone = orNull(phone);
    } else if (kind === 'companies') {
      body.website = orNull(website);
      body.industry = orNull(industry);
    } else {
      body.status = status;
      body.startDate = startDate || null;
      body.endDate = endDate || null;
    }
    return body;
  }

  // PATCH sends only changed fields: every patched field becomes user-owned (ownerFields).
  function changedFields(all: Record<string, unknown>): Record<string, unknown> {
    if (!record) return all;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(all)) {
      const before = (record as unknown as Record<string, unknown>)[k] ?? null;
      if (v !== before) out[k] = v;
    }
    return out;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = changedFields(fields());
    if (editing && Object.keys(body).length === 0) {
      toast.success('No changes to save.');
      return;
    }
    if (!editing) {
      if (kind === 'people') body.emails = emails.map((i) => i.value);
      if (kind === 'companies') body.domains = domains.map((i) => i.value);
    }
    setPending(true);
    setSimilar([]);
    setFormError(null);
    try {
      const res = await fetch(editing ? `/api/hub/${kind}/${record!.id}` : `/api/hub/${kind}`, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setFormError(await hubApiError(res));
        return;
      }
      const data = (await res.json()) as {
        record: HubRecord;
        similar?: SimilarRecord[];
        redactedValues?: number;
      };
      toast.success(editing ? 'Saved.' : `Created ${KIND_LABELS[kind].singular}.`);
      if (data.redactedValues) {
        toast.info(`${data.redactedValues} sensitive value(s) were redacted before saving.`);
      }
      setSimilar(data.similar ?? []);
      onSaved?.(data.record);
      if (!editing) {
        // Stay on the form when similar records exist, so the warning can be read first.
        if ((data.similar ?? []).length > 0) setCreatedId(data.record.id);
        else router.push(`/hub/${kind}/${data.record.id}`);
      } else router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Field id="hub-name" label="Name" error={errors.name}>
        <Input
          id="hub-name"
          value={name}
          maxLength={NAME_MAX}
          required
          aria-invalid={errors.name ? true : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      {kind === 'people' ? (
        <>
          <Field id="hub-role-title" label="Role or title" error={errors.roleTitle}>
            <Input
              id="hub-role-title"
              value={roleTitle}
              maxLength={ROLE_MAX}
              onChange={(e) => setRoleTitle(e.target.value)}
            />
          </Field>
          <Field id="hub-phone" label="Phone" error={errors.phone}>
            <Input
              id="hub-phone"
              type="tel"
              value={phone}
              maxLength={PHONE_MAX}
              aria-invalid={errors.phone ? true : undefined}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <MultiValueField
            label="Email address"
            listLabel="Added emails"
            addLabel="Add email"
            items={emails}
            validate={emailError}
            normalize={normalizeEmail}
            busy={pending}
            onAdd={(v) => addValue('emails', v)}
            onRemove={(i) => removeValue('emails', i)}
          />
        </>
      ) : null}

      {kind === 'companies' ? (
        <>
          <Field id="hub-website" label="Website" error={errors.website}>
            <Input
              id="hub-website"
              value={website}
              aria-invalid={errors.website ? true : undefined}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </Field>
          <Field id="hub-industry" label="Industry" error={errors.industry}>
            <Input
              id="hub-industry"
              value={industry}
              maxLength={INDUSTRY_MAX}
              onChange={(e) => setIndustry(e.target.value)}
            />
          </Field>
          <MultiValueField
            label="Domain"
            listLabel="Added domains"
            addLabel="Add domain"
            items={domains}
            validate={domainError}
            normalize={normalizeDomain}
            busy={pending}
            onAdd={(v) => addValue('domains', v)}
            onRemove={(i) => removeValue('domains', i)}
          />
        </>
      ) : null}

      {kind === 'projects' ? (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor="hub-status">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
              <SelectTrigger id="hub-status" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(STATUS_LABELS) as ProjectStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-4">
            <Field id="hub-start-date" label="Start date">
              <Input
                id="hub-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
            <Field id="hub-end-date" label="End date" error={errors.endDate}>
              <Input
                id="hub-end-date"
                type="date"
                value={endDate}
                min={startDate || undefined}
                aria-invalid={errors.endDate ? true : undefined}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
          </div>
        </>
      ) : null}

      <Field id="hub-description" label="Description" error={errors.description}>
        <textarea
          id="hub-description"
          value={description}
          maxLength={DESCRIPTION_MAX}
          rows={5}
          aria-invalid={errors.description ? true : undefined}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </Field>

      <SimilarWarning kind={kind} similar={similar} currentId={record?.id} />

      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || createdId !== null}>
          Save
        </Button>
        {createdId ? (
          <Link href={`/hub/${kind}/${createdId}`} className="text-sm underline">
            Continue to the {KIND_LABELS[kind].singular}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
