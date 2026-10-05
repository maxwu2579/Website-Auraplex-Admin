import { ADMIN_PRODUCTS, type AdminProduct } from '@/lib/admin/admin-products';
import type { BusinessLine } from '@/lib/admin/upload-domain';

export type UploadProduct = AdminProduct;

/**
 * Products that may receive uploads, sourced only from the Admin-owned
 * dataset in `admin-products.ts`.
 */
export const UPLOAD_PRODUCTS: readonly UploadProduct[] = ADMIN_PRODUCTS;

export function findUploadProduct(productId: string): UploadProduct | undefined {
  return UPLOAD_PRODUCTS.find((product) => product.id === productId);
}

export function hasUploadProducts(line: BusinessLine): boolean {
  return UPLOAD_PRODUCTS.some((product) => product.businessLine === line);
}
