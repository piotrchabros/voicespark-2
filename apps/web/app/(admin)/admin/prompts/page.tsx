import Link from 'next/link';
import { PROMPT_EFFORTS } from '@voicespark/db';
import { loadEnv } from '@voicespark/core/env';
import { PROMPT_VARIABLES } from '@voicespark/core/prompting';
import * as prompts from '@voicespark/core/services/prompts';
import { Forbidden } from '@/components/admin/forbidden';
import { NewPromptForm, VariableHelp } from '@/components/admin/prompt-editor';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

type PromptItem = Awaited<ReturnType<typeof prompts.adminList>>[number];

function PromptTable({ items }: { items: PromptItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">None yet.</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Active version</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Draft</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="max-w-64 whitespace-normal">
                <Link href={`/admin/prompts/${p.id}`} className="font-mono break-all underline">
                  {p.key}
                </Link>
                {p.description ? (
                  <p className="text-xs text-muted-foreground break-words">{p.description}</p>
                ) : null}
              </TableCell>
              <TableCell>
                {p.activeVersion ? `v${p.activeVersion.versionNumber}` : 'Not published'}
              </TableCell>
              <TableCell className="font-mono text-xs">{p.activeVersion?.model ?? '-'}</TableCell>
              <TableCell>
                {p.draftVersionId ? <Badge variant="outline">draft</Badge> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default async function AdminPromptsPage() {
  const admin = await requireAdminPage();
  if (!admin) return <Forbidden />;

  const items = await prompts.adminList();
  const env = loadEnv();
  const models = [...env.LLM_ALLOWED_MODELS];
  const defaultModel = models.includes(env.LLM_PROFILE_MODEL)
    ? env.LLM_PROFILE_MODEL
    : (models[0] ?? '');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Prompts</h1>
        <p className="text-sm text-muted-foreground">
          Published versions apply to the next generation. System prompts cannot be deleted.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>System prompts</CardTitle>
        </CardHeader>
        <CardContent>
          <PromptTable items={items.filter((p) => p.isSystem)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom prompts</CardTitle>
        </CardHeader>
        <CardContent>
          <PromptTable items={items.filter((p) => !p.isSystem)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New custom prompt</CardTitle>
          <CardDescription>Created as a draft; publish it from its page.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewPromptForm models={models} efforts={PROMPT_EFFORTS} defaultModel={defaultModel} />
        </CardContent>
      </Card>

      <VariableHelp promptKey="custom.*" spec={PROMPT_VARIABLES.custom} />
    </div>
  );
}
