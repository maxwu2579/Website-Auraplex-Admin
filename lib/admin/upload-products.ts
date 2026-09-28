import { MACHINES } from '@/lib/catalog';
import type { BusinessLine } from '@/lib/admin/upload-domain';

export interface UploadProduct {
  id: string;
  name: string;
  slug: string;
  businessLine: BusinessLine;
}

/**
 * Products that may receive uploads. Physical machines come from the website
 * catalogue. Software and consulting have no real catalogue products yet;
 * append their real id/name/slug records here when they exist. Never add
 * placeholder IDs or slugs.
 */
export const UPLOAD_PRODUCTS: readonly UploadProduct[] = Object.freeze(
  MACHINES.map(({ id, name, slug, category }) => ({
    id,
    name,
    slug,
    businessLine: category,
  })),
);

export function findUploadProduct(productId: string): UploadProduct | undefined {
  return UPLOAD_PRODUCTS.find((product) => product.id === productId);
}

export function hasUploadProducts(line: BusinessLine): boolean {
  return UPLOAD_PRODUCTS.some((product) => product.businessLine === line);
}
