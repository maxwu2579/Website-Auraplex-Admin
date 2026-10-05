import { UploadPanel } from '@/components/admin/upload-panel';
import { UPLOAD_PRODUCTS } from '@/lib/admin/upload-products';
import { authenticateAdminRequest, canViewAllUploads } from '@/lib/admin/server/authorization';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { getServerUploadMaxMb } from '@/lib/admin/server/upload-limit';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';

async function AuthorizedUploadPage() {
  // Keep Keycloak/session validation on the request path, never at build time.
  await connection();
  let canDelete = false;
  try {
    canDelete = canViewAllUploads(await authenticateAdminRequest());
  } catch (error) {
    if (error instanceof UploadContractError && error.status === 401) {
      redirect('/api/auth/signin/keycloak?callbackUrl=/admin/upload');
    }
    if (error instanceof UploadContractError && error.status === 403) notFound();
    throw error;
  }
  return <UploadPanel products={[...UPLOAD_PRODUCTS]} canDelete={canDelete} serverMaxUploadMb={getServerUploadMaxMb()} />;
}

export default function AdminUploadPage() {
  // The fallback contains no product/admin data. Authentication completes on
  // the server before the client upload workspace is constructed.
  return <Suspense fallback={null}><AuthorizedUploadPage /></Suspense>;
}
