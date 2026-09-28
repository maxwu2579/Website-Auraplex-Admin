import { UploadContractError } from '@/lib/admin/upload-errors';

type Environment = NodeJS.ProcessEnv;

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
}

export interface KeycloakConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

function required(
  env: Environment,
  integration: string,
  names: readonly string[],
): Record<string, string> {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new UploadContractError(
      503,
      'BACKEND_NOT_CONFIGURED',
      `${integration} is not configured (${missing.join(', ')})`,
    );
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!.trim()]));
}

function httpUrl(value: string, name: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new UploadContractError(
      503,
      'BACKEND_NOT_CONFIGURED',
      `${name} must be a valid HTTP(S) URL`,
    );
  }
}

export function getMinioConfig(env: Environment = process.env): MinioConfig {
  const values = required(env, 'MinIO', [
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
  ]);
  return {
    endpoint: httpUrl(values.MINIO_ENDPOINT, 'MINIO_ENDPOINT'),
    accessKey: values.MINIO_ACCESS_KEY,
    secretKey: values.MINIO_SECRET_KEY,
    region: env.MINIO_REGION?.trim() || 'us-east-1',
  };
}

// Collections are not configured here: they are routed per ingest line by
// qdrantCollectionForSourceKey(). QDRANT_COLLECTION is no longer read.
export function getQdrantConfig(env: Environment = process.env): QdrantConfig {
  const values = required(env, 'Qdrant', ['QDRANT_URL']);
  return {
    url: httpUrl(values.QDRANT_URL, 'QDRANT_URL'),
    apiKey: env.QDRANT_API_KEY?.trim() || undefined,
  };
}

export function tryGetQdrantConfig(
  env: Environment = process.env,
): QdrantConfig | null {
  if (!env.QDRANT_URL?.trim()) return null;
  return getQdrantConfig(env);
}

export function getKeycloakConfig(
  env: Environment = process.env,
): KeycloakConfig {
  const values = required(env, 'Keycloak', [
    'AUTH_SECRET',
    'KEYCLOAK_ISSUER',
    'KEYCLOAK_CLIENT_ID',
    'KEYCLOAK_CLIENT_SECRET',
  ]);
  return {
    issuer: httpUrl(values.KEYCLOAK_ISSUER, 'KEYCLOAK_ISSUER'),
    clientId: values.KEYCLOAK_CLIENT_ID,
    clientSecret: values.KEYCLOAK_CLIENT_SECRET,
  };
}

export function tryGetKeycloakConfig(
  env: Environment = process.env,
): KeycloakConfig | null {
  const configured = [
    env.AUTH_SECRET,
    env.KEYCLOAK_ISSUER,
    env.KEYCLOAK_CLIENT_ID,
    env.KEYCLOAK_CLIENT_SECRET,
  ].some((value) => Boolean(value?.trim()));
  return configured ? getKeycloakConfig(env) : null;
}
