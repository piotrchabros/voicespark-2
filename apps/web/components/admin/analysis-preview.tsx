'use client';

import { useEffect, useRef, useState } from 'react';
import { DocMarkdown } from '@/components/profiles/doc-markdown';
import { adminSend, apiErrorMessage, type ApiError } from '@/components/admin/version-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// Preview of a definition version's analysis prompt (FR-004). Render shows the assembled system and user
// messages without a model call; run starts a real model call on built-in synthetic samples and polls for the
// result. Neither touches user data.

const POLL_MS = 2000;

type RunStatus = 'queued' | 'running' | 'done' | 'failed';

interface RunResult {
  status: RunStatus;
  markdown: string | null;
  problems: string[];
}

function previewErrorMessage(body: ApiError | null): string {
  if (body?.error?.code === 'rate_limited') {
    return 'Too many preview requests. Wait a while and try again.';
  }
  return apiErrorMessage(body);
}

export function AnalysisPreview({
  definitionId,
  versionId,
}: {
  definitionId: string;
  versionId: string;
}) {
  const base = `/api/admin/definitions/${definitionId}/versions/${versionId}`;
  const [rendered, setRendered] = useState<{ system: string; user: string } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll the run every 2 s until it is done or failed; stop on unmount or when a new run starts.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    async function poll() {
      const r = await adminSend(`${base}/preview-run/${encodeURIComponent(jobId!)}`, 'GET');
      if (cancelled) return;
      if (!r.ok) {
        setRunError(previewErrorMessage(r.error));
        return;
      }
      const result = r.data as RunResult;
      setRun(result);
      if (result.status === 'queued' || result.status === 'running') {
        timer.current = setTimeout(poll, POLL_MS);
      }
    }
    timer.current = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [base, jobId]);

  async function render() {
    setRendering(true);
    setRenderError(null);
    const r = await adminSend(`${base}/preview`, 'POST', { kind: 'generate' });
    setRendering(false);
    if (!r.ok) {
      setRenderError(previewErrorMessage(r.error));
      return;
    }
    setRendered(r.data as { system: string; user: string });
  }

  async function startRun() {
    setStarting(true);
    setRunError(null);
    setRun(null);
    setJobId(null);
    const r = await adminSend(`${base}/preview-run`, 'POST');
    setStarting(false);
    if (!r.ok) {
      setRunError(previewErrorMessage(r.error));
      return;
    }
    setRun({ status: 'queued', markdown: null, problems: [] });
    setJobId((r.data as { jobId: string }).jobId);
  }

  const running = run !== null && (run.status === 'queued' || run.status === 'running');

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Rendered prompt</h3>
          <Button size="sm" variant="outline" disabled={rendering} onClick={render}>
            {rendered ? 'Render again' : 'Render prompt'}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          The messages sent to the model, built from this version and the sample fixture. No model
          call is made.
        </p>
        {renderError ? <p className="text-sm text-destructive">{renderError}</p> : null}
        {rendered ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">System</span>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-xs">
                {rendered.system}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">User</span>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-xs">
                {rendered.user}
              </pre>
            </div>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-medium">
            Test run
            {run ? (
              <Badge variant={run.status === 'failed' ? 'destructive' : 'outline'}>
                {run.status}
              </Badge>
            ) : null}
          </h3>
          <Button size="sm" variant="outline" disabled={starting || running} onClick={startRun}>
            {running ? 'Running...' : 'Run on sample texts'}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Runs the model on built-in synthetic samples. Nothing is saved.
        </p>
        {runError ? <p className="text-sm text-destructive">{runError}</p> : null}
        {run && run.problems.length > 0 ? (
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Problems</span>
            <ul className="flex flex-wrap gap-2">
              {run.problems.map((p) => (
                <li key={p}>
                  <code className="break-all">{p}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {run?.status === 'done' && run.markdown !== null ? (
          <div className="rounded-md border p-3">
            <DocMarkdown markdown={run.markdown} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
