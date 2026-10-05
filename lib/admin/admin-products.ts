import type { BusinessLine } from '@/lib/admin/upload-domain';

export interface AdminProduct {
  id: string;
  slug: string;
  name: string;
  businessLine: BusinessLine;
}

/**
 * Admin-owned product list: committed static data, independent of the public
 * website catalogue. IDs and slugs are a storage contract (the slug is the
 * second object-key segment), so never regenerate, rename or normalize them.
 * Software and consulting have no real products yet; append their real
 * id/slug/name records here when they exist. Never add placeholder IDs or
 * slugs.
 */
export const ADMIN_PRODUCTS: readonly AdminProduct[] = Object.freeze([
  { id: '6542366', slug: 'continuous-band-sealing-machine', name: 'Continuous Band Sealing Machine', businessLine: 'packaging' },
  { id: '6470625', slug: 'flexy-applicator', name: 'Flexy Applicator', businessLine: 'labelling' },
  { id: '6470393', slug: 'semi-auto-wrap-around-labelling-machine', name: 'Semi Auto Wrap Around Labelling Machine', businessLine: 'labelling' },
  { id: '6470186', slug: 'two-side-labelling-machine', name: 'Two Side Labelling Machine', businessLine: 'labelling' },
  { id: '6467488', slug: 'custom-top-labelling-machine-with-checking-system', name: 'Custom Top Labelling Machine With Checking System', businessLine: 'labelling' },
  { id: '6464930', slug: 'two-in-one-wrap-around-side-labelling-machine', name: 'Two In One Wrap Around Side Labelling Machine', businessLine: 'labelling' },
  { id: '6464798', slug: 'print-apply-top-labelling-machine', name: 'Print Apply Top Labelling Machine', businessLine: 'labelling' },
  { id: '6463899', slug: 'one-side-wrap-around-side-labelling-machine', name: 'One Side Wrap Around Side Labelling Machine', businessLine: 'labelling' },
  { id: '6462872', slug: 'top-labelling-machine-with-thermal-transfer-printer-auto-feeder', name: 'Top Labelling Machine With Thermal Transfer Printer Auto Feeder', businessLine: 'labelling' },
  { id: '6461971', slug: 'bottom-labelling-machine', name: 'Bottom Labelling Machine', businessLine: 'labelling' },
  { id: '6461970', slug: 'print-apply-labeller', name: 'Print Apply Labeller', businessLine: 'labelling' },
  { id: '6461969', slug: 'flat-labelling-machine', name: 'Flat Labelling Machine', businessLine: 'labelling' },
  { id: '6461968', slug: 'top-labelling-machine', name: 'Top Labelling Machine', businessLine: 'labelling' },
  { id: '6461967', slug: 'top-labelling-machine-with-thermal-transfer-printer-auto-feeder-v2', name: 'Top Labelling Machine With Thermal Transfer Printer Auto Feeder V2', businessLine: 'labelling' },
  { id: '6461966', slug: 'customized-bottom-labelling-machine', name: 'Customized Bottom Labelling Machine', businessLine: 'labelling' },
  { id: '6461965', slug: 'egg-tray-labelling-machine', name: 'Egg Tray Labelling Machine', businessLine: 'labelling' },
  { id: '6461964', slug: 'three-side-labelling-machine', name: 'Three Side Labelling Machine', businessLine: 'labelling' },
  { id: '6461963', slug: 'body-neck-labelling-machine', name: 'Body Neck Labelling Machine', businessLine: 'labelling' },
  { id: '6461962', slug: 'top-labelling-machine-v2', name: 'Top Labelling Machine V2', businessLine: 'labelling' },
  { id: '6461961', slug: 'top-labelling-machine-with-corner-press-device', name: 'Top Labelling Machine With Corner Press Device', businessLine: 'labelling' },
  { id: '6461960', slug: 'front-back-labelling-machine', name: 'Front Back Labelling Machine', businessLine: 'labelling' },
  { id: '6461959', slug: 'vertical-wrap-around-labelling-machine', name: 'Vertical Wrap Around Labelling Machine', businessLine: 'labelling' },
  { id: '4788377', slug: 'two-side-labelling-machine-with-corner-press', name: 'Two Side Labelling Machine With Corner Press', businessLine: 'labelling' },
  { id: '4788373', slug: 'customized-top-labelling-machine', name: 'Customized Top Labelling Machine', businessLine: 'labelling' },
  { id: '4788368', slug: 'semi-auto-round-bottle-labelling-machine', name: 'Semi Auto Round Bottle Labelling Machine', businessLine: 'labelling' },
  { id: '4788365', slug: 'standard-top-labelling-machine', name: 'Standard Top Labelling Machine', businessLine: 'labelling' },
  { id: '4788353', slug: 'ar600-3d-printer', name: 'AR600 3D Printer', businessLine: 'automation' },
  { id: '4788352', slug: 'ar320-3d-printer', name: 'AR320 3D Printer', businessLine: 'automation' },
  { id: '4788349', slug: 'ar220-3d-printer', name: 'AR220 3D Printer', businessLine: 'automation' },
  { id: '4788387', slug: 'continuous-band-sealing-machine-v2', name: 'Continuous Band Sealing Machine V2', businessLine: 'packaging' },
]);
