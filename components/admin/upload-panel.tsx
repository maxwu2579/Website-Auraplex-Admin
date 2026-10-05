'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  Database,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/primitives/button';
import { FileDropzone, ProductSelector, RecentUploadsPanel, UploadQueue, type ProductOption, type QueuedFile } from '@/components/admin/upload-panel-parts';
import type { BusinessLine } from '@/lib/admin/upload-domain';
import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  effectiveClientUploadMaxMb,
  UPLOAD_HEADERS,
  uploadMediaForExtension,
  type RecentUpload,
  type RecentUploadsResponse,
  type UploadApiResponse,
} from '@/lib/admin/upload-contract';
import { canRetryUpload, queueStatusAfterResponse } from '@/lib/admin/upload-ui-state';
import { logoutFromKeycloak } from '@/app/admin/upload/actions';

const ACCEPTED_EXTENSIONS = new Set(ACCEPTED_UPLOAD_EXTENSIONS);
const SESSION_EXPIRED =
  'Your admin session has expired (30 minutes idle or 12 hours after sign-in). Reload the page to sign in again.';

type Props = {
  products: ProductOption[];
  canDelete: boolean;
  serverMaxUploadMb: number;
};

function extensionOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

function newFileId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadRecentUploads(): Promise<{
  uploads: RecentUpload[];
  notice: string;
}> {
  try {
    const response = await fetch('/api/admin/uploads', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body = (await response.json()) as RecentUploadsResponse | UploadApiResponse;
    if (!response.ok || !body.ok || !('uploads' in body)) {
      return {
        uploads: [],
        notice: response.status === 401 ? SESSION_EXPIRED : 'error' in body ? body.error : 'Upload status is unavailable',
      };
    }
    return {
      uploads: body.uploads,
      notice: body.qdrantAvailable
        ? 'MinIO and Qdrant evidence loaded.'
        : 'MinIO loaded; Qdrant is not configured, so processed evidence is unavailable.',
    };
  } catch {
    return { uploads: [], notice: 'Backend status connection is unavailable.' };
  }
}

export function UploadPanel({ products, canDelete, serverMaxUploadMb }: Props) {
  const uiMaxUploadMb = effectiveClientUploadMaxMb(serverMaxUploadMb);
  const uiMaxUploadBytes = uiMaxUploadMb * 1024 * 1024;
  const activeUpload = useRef<AbortController | null>(null);
  const [businessLine, setBusinessLine] = useState<BusinessLine | ''>('');
  const [productId, setProductId] = useState('');
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [recentUploads, setRecentUploads] = useState<RecentUpload[]>([]);
  const [recentNotice, setRecentNotice] = useState('Checking backend connection…');
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // All five business lines are shown even when the Admin dataset has no products
  // for a line yet; product selection stays mandatory for every upload.
  const filteredProducts = useMemo(
    () => products.filter((product) => product.businessLine === businessLine),
    [businessLine, products],
  );

  const selectedProduct = filteredProducts.find((product) => product.id === productId);
  const uploadCandidates = files.filter(
    (item) => item.status === 'ready' || canRetryUpload(item.status),
  );
  const canPrepareUpload = Boolean(
    businessLine && selectedProduct && uploadCandidates.length > 0 && !uploading,
  );

  const refreshRecentUploads = useCallback(async () => {
    const result = await loadRecentUploads();
    setRecentUploads(result.uploads);
    setRecentNotice(result.notice);
  }, []);

  useEffect(() => {
    let active = true;
    void loadRecentUploads().then((result) => {
      if (!active) return;
      setRecentUploads(result.uploads);
      setRecentNotice(result.notice);
    });
    return () => { active = false; activeUpload.current?.abort(); };
  }, []);

  function changeBusinessLine(value: BusinessLine | '') {
    setBusinessLine(value);
    setProductId('');
  }

  function addFiles(incoming: FileList | File[]) {
    const accepted: QueuedFile[] = [];
    const rejected: string[] = [];

    for (const file of Array.from(incoming)) {
      const extension = extensionOf(file.name);
      if (!ACCEPTED_EXTENSIONS.has(extension)) {
        rejected.push(`${file.name}: unsupported file type`);
        continue;
      }
      if (file.size === 0) {
        rejected.push(`${file.name}: empty file`);
        continue;
      }
      if (file.size > uiMaxUploadBytes) {
        rejected.push(`${file.name}: exceeds ${uiMaxUploadMb} MB`);
        continue;
      }

      accepted.push({
        id: newFileId(),
        file,
        extension,
        ingestion: uploadMediaForExtension(extension)?.ingestionCapability ?? 'deferred',
        status: 'ready',
      });
    }

    setFiles((current) => {
      const known = new Set(current.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`));
      return [
        ...current,
        ...accepted.filter(({ file }) => !known.has(`${file.name}:${file.size}:${file.lastModified}`)),
      ];
    });
    setNotice(rejected.length > 0 ? rejected.join('. ') : null);
  }

  function removeFile(id: string) {
    setFiles((current) => current.filter((item) => item.id !== id));
  }

  function updateFile(id: string, update: Partial<QueuedFile>) {
    setFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, ...update } : item)),
    );
  }

  async function uploadFiles() {
    if (!businessLine || !selectedProduct || !canPrepareUpload) return;
    setUploading(true);
    setNotice(null);

    try {
      const csrfResponse = await fetch('/api/admin/csrf', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const csrfBody = (await csrfResponse.json()) as {
        ok: boolean;
        csrfToken?: string;
        error?: string;
      };
      if (!csrfResponse.ok || !csrfBody.ok || !csrfBody.csrfToken) {
        const message = csrfResponse.status === 401
          ? SESSION_EXPIRED
          : csrfBody.error || 'Authentication or CSRF setup is unavailable';
        setNotice(message);
        setFiles((current) =>
          current.map((item) =>
            item.status === 'ready' || item.status === 'failed'
              ? { ...item, status: 'failed', error: message }
              : item,
          ),
        );
        return;
      }

      for (const item of uploadCandidates) {
        updateFile(item.id, { status: 'uploading', error: undefined });
        const controller = new AbortController();
        activeUpload.current = controller;
        try {
          const media = uploadMediaForExtension(item.extension);
          if (!media) throw new Error('Unsupported upload type');
          const response = await fetch('/api/admin/uploads', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: {
              'Content-Type': media.canonicalMimeType,
              [UPLOAD_HEADERS.productLine]: businessLine,
              [UPLOAD_HEADERS.productId]: selectedProduct.id,
              [UPLOAD_HEADERS.filename]: encodeURIComponent(item.file.name),
              [UPLOAD_HEADERS.csrfToken]: csrfBody.csrfToken,
            },
            body: item.file,
            signal: controller.signal,
          });
          const body = (await response.json()) as UploadApiResponse;
          const status = queueStatusAfterResponse(body);
          const error = body.ok ? undefined : response.status === 401 ? SESSION_EXPIRED : body.error;
          updateFile(item.id, { status, error });
          if (!response.ok || !body.ok) {
            setNotice(error ?? 'Upload failed');
          }
        } catch (error) {
          const message = controller.signal.aborted
            ? 'Upload cancelled; you can retry'
            : error instanceof Error ? error.message : 'Upload failed';
          updateFile(item.id, { status: 'failed', error: message });
          setNotice(message);
        } finally {
          if (activeUpload.current === controller) activeUpload.current = null;
        }
      }
      await refreshRecentUploads();
    } finally {
      setUploading(false);
    }
  }

  async function deleteStoredUpload(upload: RecentUpload) {
    if (!canDelete || !window.confirm(`Delete ${upload.filename} from storage and search?`)) return;
    setDeletingKey(`${upload.bucket}/${upload.key}`);
    setNotice(null);
    try {
      const csrfResponse = await fetch('/api/admin/csrf', { cache: 'no-store', credentials: 'same-origin' });
      const csrfBody = await csrfResponse.json() as { csrfToken?: string; error?: string };
      if (csrfResponse.status === 401) throw new Error(SESSION_EXPIRED);
      if (!csrfResponse.ok || !csrfBody.csrfToken) throw new Error(csrfBody.error || 'Authentication unavailable');
      const response = await fetch('/api/admin/uploads', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', [UPLOAD_HEADERS.csrfToken]: csrfBody.csrfToken },
        body: JSON.stringify({ bucket: upload.bucket, key: upload.key }),
      });
      const body = await response.json() as { ok: boolean; error?: string };
      if (response.status === 401) throw new Error(SESSION_EXPIRED);
      if (!response.ok || !body.ok) throw new Error(body.error || 'Delete failed');
      await refreshRecentUploads();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setDeletingKey(null);
    }
  }

  return (
    <div className="min-h-screen bg-[color:var(--color-ink)]">
      <header className="border-b border-[color:var(--color-neutral-700)] bg-[color:var(--color-neutral-800)]/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-6 px-5 py-4 sm:px-8 lg:px-12">
          <div className="flex min-w-0 items-center gap-4">
            <div className="grid h-10 w-10 shrink-0 place-items-center border border-[color:var(--color-signal)] text-[color:var(--color-signal)]">
              <Database aria-hidden="true" className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-display text-xl font-semibold">Auraplex Admin</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-neutral-400)]">
                Knowledge base operations
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="font-mono text-xs uppercase tracking-wider">Keycloak boundary prepared</p>
              <p className="text-xs text-[color:var(--color-neutral-400)]">Runtime configuration required</p>
            </div>
            <form action={logoutFromKeycloak}>
              <button type="submit" aria-label="Sign out of Auraplex and Keycloak" className="grid h-10 w-10 place-items-center border border-[color:var(--color-neutral-700)] text-[color:var(--color-neutral-400)] hover:border-[color:var(--color-signal)] hover:text-[color:var(--color-signal)]">
                <LogOut aria-hidden="true" className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1500px] px-5 py-10 sm:px-8 lg:px-12 lg:py-14">
        <div className="mb-10 flex flex-col justify-between gap-5 border-b border-[color:var(--color-neutral-700)] pb-8 lg:flex-row lg:items-end">
          <div>
            <div className="mb-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-signal)]">
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              Restricted workspace
            </div>
            <h1 className="max-w-4xl font-display text-4xl font-semibold leading-[1.05] sm:text-5xl lg:text-6xl">
              Upload source material
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-[color:var(--color-neutral-300)] sm:text-base">
              Attach product metadata, queue source files, and track ingestion without direct MinIO access.
            </p>
          </div>
          <div className="flex items-center gap-3 border border-[color:var(--color-warning)]/50 bg-[color:var(--color-warning)]/10 px-4 py-3 text-sm text-[color:var(--color-warning)]">
            <Clock3 aria-hidden="true" className="h-4 w-4 shrink-0" />
            Integration layer ready — runtime configuration required
          </div>
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
          <section aria-labelledby="upload-heading" className="border border-[color:var(--color-neutral-700)] bg-[color:var(--color-neutral-800)]/55">
            <div className="flex items-center justify-between border-b border-[color:var(--color-neutral-700)] px-5 py-4 sm:px-6">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-signal)]">Step 01</p>
                <h2 id="upload-heading" className="mt-1 font-display text-2xl font-semibold">Prepare upload</h2>
              </div>
              <span className="font-mono text-xs text-[color:var(--color-neutral-400)]">{uiMaxUploadMb} MB max / file</span>
            </div>

            <div className="space-y-7 p-5 sm:p-6">
              <ProductSelector
                businessLine={businessLine}
                productId={productId}
                products={products}
                filteredProducts={filteredProducts}
                selectedProduct={selectedProduct}
                onBusinessLineChange={changeBusinessLine}
                onProductChange={setProductId}
              />

              <FileDropzone onFiles={addFiles} />

              {notice && (
                <div role="alert" className="flex gap-3 border border-[color:var(--color-danger)]/50 bg-[color:var(--color-danger)]/10 p-4 text-sm text-[color:var(--color-danger)]">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{notice}</span>
                </div>
              )}

              <UploadQueue
                files={files}
                uploading={uploading}
                onClear={() => setFiles([])}
                onRetry={(id) => updateFile(id, { status: 'ready', error: undefined })}
                onRemove={removeFile}
              />

              <div className="flex flex-col gap-3 border-t border-[color:var(--color-neutral-700)] pt-6 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-[color:var(--color-neutral-400)]">
                  Files upload sequentially. The UI shows only real request states; no percentage is estimated.
                </p>
                {uploading && (
                  <button type="button" onClick={() => activeUpload.current?.abort()} className="text-xs text-[color:var(--color-warning)]">Cancel current upload</button>
                )}
                <Button
                  type="button"
                  disabled={!canPrepareUpload}
                  onClick={() => void uploadFiles()}
                  className="shrink-0"
                >
                  {uploading ? 'Uploading…' : `Upload ${uploadCandidates.length || ''} file${uploadCandidates.length === 1 ? '' : 's'}`}
                  <ChevronRight aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </section>

          <RecentUploadsPanel
            uploads={recentUploads}
            notice={recentNotice}
            canDelete={canDelete}
            deletingKey={deletingKey}
            onDelete={(upload) => void deleteStoredUpload(upload)}
          />
        </div>
      </main>
    </div>
  );
}
