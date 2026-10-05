import { connection } from 'next/server';

/**
 * Liveness check for the container or scheduler. Public and self-contained:
 * it reads no session and contacts neither Keycloak, MinIO nor Qdrant, so it
 * says only that this server process is answering requests. The body is
 * fixed and carries no version, configuration or environment detail.
 */
export async function GET() {
  // Answer at request time, never from a build-time prerender.
  await connection();
  return Response.json(
    { status: 'ok', service: 'auraplex-admin' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
