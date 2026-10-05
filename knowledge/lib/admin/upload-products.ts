import type { BusinessLine } from '@/lib/admin/upload-domain';

export interface UploadProduct {
  id: string;
  name: string;
  slug: string;
  businessLine: BusinessLine;
}

/**
 * Products that may receive uploads. This app no longer imports the website
 * catalogue: the machine records below are a snapshot of the website's
 * lib/catalog.ts (id, name, slug, category) taken when the knowledge app was
 * split out. When the website catalogue adds, renames or removes a machine,
 * update this list to match — ids and slugs feed the stored object key and the
 * Qdrant source key, so they must stay identical to the website's.
 *
 * Software and consulting have no real products yet; append their real
 * id/name/slug records here when they exist. Never add placeholder IDs or
 * slugs.
 */
const PRODUCTS: UploadProduct[] = [
  { id: '6542366', name: 'Continuous Band Sealing Machine', slug: 'continuous-band-sealing-machine', businessLine: 'packaging' },
  { id: '6470625', name: 'Flexy Applicator', slug: 'flexy-applicator', businessLine: 'labelling' },
  { id: '6470393', name: 'Semi Auto Wrap Around Labelling Machine', slug: 'semi-auto-wrap-around-labelling-machine', businessLine: 'labelling' },
  { id: '6470186', name: 'Two Side Labelling Machine', slug: 'two-side-labelling-machine', businessLine: 'labelling' },
  { id: '6467488', name: 'Custom Top Labelling Machine With Checking System', slug: 'custom-top-labelling-machine-with-checking-system', businessLine: 'labelling' },
  { id: '6464930', name: 'Two In One Wrap Around Side Labelling Machine', slug: 'two-in-one-wrap-around-side-labelling-machine', businessLine: 'labelling' },
  { id: '6464798', name: 'Print Apply Top Labelling Machine', slug: 'print-apply-top-labelling-machine', businessLine: 'labelling' },
  { id: '6463899', name: 'One Side Wrap Around Side Labelling Machine', slug: 'one-side-wrap-around-side-labelling-machine', businessLine: 'labelling' },
  { id: '6462872', name: 'Top Labelling Machine With Thermal Transfer Printer Auto Feeder', slug: 'top-labelling-machine-with-thermal-transfer-printer-auto-feeder', businessLine: 'labelling' },
  { id: '6461971', name: 'Bottom Labelling Machine', slug: 'bottom-labelling-machine', businessLine: 'labelling' },
  { id: '6461970', name: 'Print Apply Labeller', slug: 'print-apply-labeller', businessLine: 'labelling' },
  { id: '6461969', name: 'Flat Labelling Machine', slug: 'flat-labelling-machine', businessLine: 'labelling' },
  { id: '6461968', name: 'Top Labelling Machine', slug: 'top-labelling-machine', businessLine: 'labelling' },
  { id: '6461967', name: 'Top Labelling Machine With Thermal Transfer Printer Auto Feeder V2', slug: 'top-labelling-machine-with-thermal-transfer-printer-auto-feeder-v2', businessLine: 'labelling' },
  { id: '6461966', name: 'Customized Bottom Labelling Machine', slug: 'customized-bottom-labelling-machine', businessLine: 'labelling' },
  { id: '6461965', name: 'Egg Tray Labelling Machine', slug: 'egg-tray-labelling-machine', businessLine: 'labelling' },
  { id: '6461964', name: 'Three Side Labelling Machine', slug: 'three-side-labelling-machine', businessLine: 'labelling' },
  { id: '6461963', name: 'Body Neck Labelling Machine', slug: 'body-neck-labelling-machine', businessLine: 'labelling' },
  { id: '6461962', name: 'Top Labelling Machine V2', slug: 'top-labelling-machine-v2', businessLine: 'labelling' },
  { id: '6461961', name: 'Top Labelling Machine With Corner Press Device', slug: 'top-labelling-machine-with-corner-press-device', businessLine: 'labelling' },
  { id: '6461960', name: 'Front Back Labelling Machine', slug: 'front-back-labelling-machine', businessLine: 'labelling' },
  { id: '6461959', name: 'Vertical Wrap Around Labelling Machine', slug: 'vertical-wrap-around-labelling-machine', businessLine: 'labelling' },
  { id: '4788377', name: 'Two Side Labelling Machine With Corner Press', slug: 'two-side-labelling-machine-with-corner-press', businessLine: 'labelling' },
  { id: '4788373', name: 'Customized Top Labelling Machine', slug: 'customized-top-labelling-machine', businessLine: 'labelling' },
  { id: '4788368', name: 'Semi Auto Round Bottle Labelling Machine', slug: 'semi-auto-round-bottle-labelling-machine', businessLine: 'labelling' },
  { id: '4788365', name: 'Standard Top Labelling Machine', slug: 'standard-top-labelling-machine', businessLine: 'labelling' },
  { id: '4788353', name: 'AR600 3D Printer', slug: 'ar600-3d-printer', businessLine: 'automation' },
  { id: '4788352', name: 'AR320 3D Printer', slug: 'ar320-3d-printer', businessLine: 'automation' },
  { id: '4788349', name: 'AR220 3D Printer', slug: 'ar220-3d-printer', businessLine: 'automation' },
  { id: '4788387', name: 'Continuous Band Sealing Machine V2', slug: 'continuous-band-sealing-machine-v2', businessLine: 'packaging' },
];

export const UPLOAD_PRODUCTS: readonly UploadProduct[] = Object.freeze(
  PRODUCTS.map((product) => Object.freeze({ ...product })),
);

export function findUploadProduct(productId: string): UploadProduct | undefined {
  return UPLOAD_PRODUCTS.find((product) => product.id === productId);
}

export function hasUploadProducts(line: BusinessLine): boolean {
  return UPLOAD_PRODUCTS.some((product) => product.businessLine === line);
}
