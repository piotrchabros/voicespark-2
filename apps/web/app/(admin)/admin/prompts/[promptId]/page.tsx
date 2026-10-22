import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PROMPT_EFFORTS } from '@voicespark/db';
import { loadEnv } from '@voicespark/core/env';
import { AppError } from '@voicespark/core/errors';
import { familyFor, PROMPT_VARIABLES } from '@voicespark/core/prompting';
import * as prompts from '@voicespark/core/services/prompts';
import { Forbidden } from '@/components/admin/forbidden';
import {
  CreateDraftButton,
  PromptEditor,
  PromptPreview,
  VariableHelp,
} from '@/components/admin/prompt-editor';
import { VersionPanel } from '@/components/admin/version-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function AdminPromptDetailPage({
  params,
}: {
  params: Promise<{ promptId: string }>;
}) {
  const admin = await requireAdminPage();
  if (!admin) return <Forbidden />;
  const { promptId } = await params;

  let data: Awaited<ReturnType<typeof prompts.adminGet>>;
  try {
    data = await prompts.adminGet(promptId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }
  const { prompt, versions } = data;
  const draft = versions.find((v) => v.status === 'draft') ?? null;
  const active = versions.find((v) => v.id === prompt.activeVersion?.id) ?? null;
  const spec = PROMPT_VARIABLES[familyFor(prompt.key)];
  const models = [...loadEnv().LLM_ALLOWED_MODELS];

  // Preview targets the draft first, then the active version.
  const previewVersions = [draft, active]
    .filter((v) => v !== null)
    .map((v) => ({ id: v.id, label: `v${v.versionNumber} (${v.status})` }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/admin/prompts" className="text-sm underline">
          All prompts
        </Link>
        <h1 className="font-mono text-xl font-semibold break-all sm:text-2xl">{prompt.key}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{prompt.isSystem ? 'system' : 'custom'}</Badge>
          <span className="text-muted-foreground">
            {prompt.activeVersion
              ? `Active v${prompt.activeVersion.versionNumber} on ${prompt.activeVersion.model}`
              : 'Not published yet'}
          </span>
        </div>
        {prompt.description ? <p className="text-sm break-words">{prompt.description}</p> : null}
      </div>

      {draft ? (
        <PromptEditor
          key={draft.id}
          promptId={prompt.id}
          draft={{
            id: draft.id,
            versionNumber: draft.versionNumber,
            systemTemplate: draft.systemTemplate,
            userTemplate: draft.userTemplate,
            model: draft.model,
            effort: draft.effort,
            maxTokens: draft.maxTokens,
            changeNote: draft.changeNote,
          }}
          models={models}
          efforts={PROMPT_EFFORTS}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>No draft</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              Create a draft to edit the templates and model settings.
            </p>
            <CreateDraftButton promptId={prompt.id} />
          </CardContent>
        </Card>
      )}

      {active && active.id !== draft?.id ? (
        <Card>
          <CardHeader>
            <CardTitle>Active version v{active.versionNumber}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              {active.model}, effort {active.effort}, max {active.maxTokens} tokens
              {active.changeNote ? ` - ${active.changeNote}` : ''}
            </p>
            <div className="flex flex-col gap-1">
              <p className="font-medium">System template</p>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                {active.systemTemplate}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <p className="font-medium">User template</p>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                {active.userTemplate}
              </pre>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <VariableHelp promptKey={prompt.key} spec={spec} />

      <PromptPreview
        promptId={prompt.id}
        versions={previewVersions}
        supportsRevision={spec.sections.includes('isRevision')}
      />

      <VersionPanel
        kind="prompts"
        entityId={prompt.id}
        versions={versions.map((v) => ({
          id: v.id,
          versionNumber: v.versionNumber,
          status: v.status,
        }))}
      />
    </div>
  );
}
