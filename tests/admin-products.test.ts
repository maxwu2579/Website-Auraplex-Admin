import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_PRODUCTS } from '../lib/admin/admin-products';
import { buildUploadObjectKey } from '../lib/admin/object-key';
import { QDRANT_COLLECTIONS, qdrantCollectionForSourceKey } from '../lib/admin/server/qdrant';
import {
  BUSINESS_LINES,
  BUSINESS_TO_INGEST_LINE,
  ingestLineForBusinessLine,
} from '../lib/admin/upload-domain';
import { UploadContractError } from '../lib/admin/upload-errors';
import { findUploadProduct, hasUploadProducts, UPLOAD_PRODUCTS } from '../lib/admin/upload-products';
import {
  buildUploadObjectLocation,
  resolveUploadMedia,
  resolveUploadProduct,
} from '../lib/admin/upload-validation';

/**
 * Frozen contract snapshot of the products Admin Upload served while it still
 * read the public website catalogue: [id, slug, name, businessLine, object key
 * for `manual.pdf`]. IDs and slugs feed stored object keys, so a diff here is
 * a storage-contract change, not a data refresh.
 */
const EXPECTED_PRODUCTS = [
  ['6542366', 'continuous-band-sealing-machine', 'Continuous Band Sealing Machine', 'packaging', 'machines/continuous-band-sealing-machine/manual.pdf'],
  ['6470625', 'flexy-applicator', 'Flexy Applicator', 'labelling', 'machines/flexy-applicator/manual.pdf'],
  ['6470393', 'semi-auto-wrap-around-labelling-machine', 'Semi Auto Wrap Around Labelling Machine', 'labelling', 'machines/semi-auto-wrap-around-labelling-machine/manual.pdf'],
  ['6470186', 'two-side-labelling-machine', 'Two Side Labelling Machine', 'labelling', 'machines/two-side-labelling-machine/manual.pdf'],
  ['6467488', 'custom-top-labelling-machine-with-checking-system', 'Custom Top Labelling Machine With Checking System', 'labelling', 'machines/custom-top-labelling-machine-with-checking-system/manual.pdf'],
  ['6464930', 'two-in-one-wrap-around-side-labelling-machine', 'Two In One Wrap Around Side Labelling Machine', 'labelling', 'machines/two-in-one-wrap-around-side-labelling-machine/manual.pdf'],
  ['6464798', 'print-apply-top-labelling-machine', 'Print Apply Top Labelling Machine', 'labelling', 'machines/print-apply-top-labelling-machine/manual.pdf'],
  ['6463899', 'one-side-wrap-around-side-labelling-machine', 'One Side Wrap Around Side Labelling Machine', 'labelling', 'machines/one-side-wrap-around-side-labelling-machine/manual.pdf'],
  ['6462872', 'top-labelling-machine-with-thermal-transfer-printer-auto-feeder', 'Top Labelling Machine With Thermal Transfer Printer Auto Feeder', 'labelling', 'machines/top-labelling-machine-with-thermal-transfer-printer-auto-feeder/manual.pdf'],
  ['6461971', 'bottom-labelling-machine', 'Bottom Labelling Machine', 'labelling', 'machines/bottom-labelling-machine/manual.pdf'],
  ['6461970', 'print-apply-labeller', 'Print Apply Labeller', 'labelling', 'machines/print-apply-labeller/manual.pdf'],
  ['6461969', 'flat-labelling-machine', 'Flat Labelling Machine', 'labelling', 'machines/flat-labelling-machine/manual.pdf'],
  ['6461968', 'top-labelling-machine', 'Top Labelling Machine', 'labelling', 'machines/top-labelling-machine/manual.pdf'],
  ['6461967', 'top-labelling-machine-with-thermal-transfer-printer-auto-feeder-v2', 'Top Labelling Machine With Thermal Transfer Printer Auto Feeder V2', 'labelling', 'machines/top-labelling-machine-with-thermal-transfer-printer-auto-feeder-v2/manual.pdf'],
  ['6461966', 'customized-bottom-labelling-machine', 'Customized Bottom Labelling Machine', 'labelling', 'machines/customized-bottom-labelling-machine/manual.pdf'],
  ['6461965', 'egg-tray-labelling-machine', 'Egg Tray Labelling Machine', 'labelling', 'machines/egg-tray-labelling-machine/manual.pdf'],
  ['6461964', 'three-side-labelling-machine', 'Three Side Labelling Machine', 'labelling', 'machines/three-side-labelling-machine/manual.pdf'],
  ['6461963', 'body-neck-labelling-machine', 'Body Neck Labelling Machine', 'labelling', 'machines/body-neck-labelling-machine/manual.pdf'],
  ['6461962', 'top-labelling-machine-v2', 'Top Labelling Machine V2', 'labelling', 'machines/top-labelling-machine-v2/manual.pdf'],
  ['6461961', 'top-labelling-machine-with-corner-press-device', 'Top Labelling Machine With Corner Press Device', 'labelling', 'machines/top-labelling-machine-with-corner-press-device/manual.pdf'],
  ['6461960', 'front-back-labelling-machine', 'Front Back Labelling Machine', 'labelling', 'machines/front-back-labelling-machine/manual.pdf'],
  ['6461959', 'vertical-wrap-around-labelling-machine', 'Vertical Wrap Around Labelling Machine', 'labelling', 'machines/vertical-wrap-around-labelling-machine/manual.pdf'],
  ['4788377', 'two-side-labelling-machine-with-corner-press', 'Two Side Labelling Machine With Corner Press', 'labelling', 'machines/two-side-labelling-machine-with-corner-press/manual.pdf'],
  ['4788373', 'customized-top-labelling-machine', 'Customized Top Labelling Machine', 'labelling', 'machines/customized-top-labelling-machine/manual.pdf'],
  ['4788368', 'semi-auto-round-bottle-labelling-machine', 'Semi Auto Round Bottle Labelling Machine', 'labelling', 'machines/semi-auto-round-bottle-labelling-machine/manual.pdf'],
  ['4788365', 'standard-top-labelling-machine', 'Standard Top Labelling Machine', 'labelling', 'machines/standard-top-labelling-machine/manual.pdf'],
  ['4788353', 'ar600-3d-printer', 'AR600 3D Printer', 'automation', 'machines/ar600-3d-printer/manual.pdf'],
  ['4788352', 'ar320-3d-printer', 'AR320 3D Printer', 'automation', 'machines/ar320-3d-printer/manual.pdf'],
  ['4788349', 'ar220-3d-printer', 'AR220 3D Printer', 'automation', 'machines/ar220-3d-printer/manual.pdf'],
  ['4788387', 'continuous-band-sealing-machine-v2', 'Continuous Band Sealing Machine V2', 'packaging', 'machines/continuous-band-sealing-machine-v2/manual.pdf'],
] as const;

test('preserves exactly the 30 Admin products with unchanged id, slug, name and business line', () => {
  assert.equal(ADMIN_PRODUCTS.length, 30);
  assert.deepEqual(
    ADMIN_PRODUCTS.map(({ id, slug, name, businessLine }) => [id, slug, name, businessLine]),
    EXPECTED_PRODUCTS.map(([id, slug, name, businessLine]) => [id, slug, name, businessLine]),
  );
  for (const product of ADMIN_PRODUCTS) {
    assert.deepEqual(Object.keys(product).sort(), ['businessLine', 'id', 'name', 'slug']);
  }
});

test('Admin product IDs and slugs are unique', () => {
  assert.equal(new Set(ADMIN_PRODUCTS.map((product) => product.id)).size, 30);
  assert.equal(new Set(ADMIN_PRODUCTS.map((product) => product.slug)).size, 30);
});

test('keeps the 25 labelling / 2 packaging / 3 automation distribution with no software or consulting products', () => {
  const counts = Object.fromEntries(
    BUSINESS_LINES.map((line) => [
      line,
      ADMIN_PRODUCTS.filter((product) => product.businessLine === line).length,
    ]),
  );
  assert.deepEqual(counts, {
    labelling: 25,
    packaging: 2,
    automation: 3,
    software: 0,
    consulting: 0,
  });
});

test('upload products are exactly the Admin dataset', () => {
  assert.deepEqual([...UPLOAD_PRODUCTS], [...ADMIN_PRODUCTS]);
});

test('business line to ingest line and Qdrant collection mappings are unchanged', () => {
  assert.deepEqual({ ...BUSINESS_TO_INGEST_LINE }, {
    labelling: 'machines',
    packaging: 'machines',
    automation: 'machines',
    software: 'software',
    consulting: 'consulting',
  });
  assert.deepEqual({ ...QDRANT_COLLECTIONS }, {
    machines: 'auraplex_machines',
    software: 'auraplex_software',
    consulting: 'auraplex_consulting',
  });
});

test('every Admin product generates the same object key, source key and collection as before', () => {
  const media = resolveUploadMedia('application/pdf', 'manual.pdf');
  for (const [id, slug, , businessLine, expectedKey] of EXPECTED_PRODUCTS) {
    const product = findUploadProduct(id);
    assert.ok(product, id);
    const ingestLine = ingestLineForBusinessLine(product.businessLine);
    assert.equal(ingestLine, 'machines');
    assert.equal(
      buildUploadObjectKey({ ingestLine, productSlug: product.slug, safeFilename: 'manual.pdf' }),
      expectedKey,
    );
    assert.equal(expectedKey, `machines/${slug}/manual.pdf`);

    const location = buildUploadObjectLocation({
      ingestLine,
      productSlug: product.slug,
      safeFilename: 'manual.pdf',
      media,
    });
    assert.deepEqual(location, {
      bucket: 'auraplex-raw-pdf',
      key: expectedKey,
      sourceKey: `auraplex-raw-pdf/${expectedKey}`,
    });
    assert.equal(qdrantCollectionForSourceKey(location.sourceKey), 'auraplex_machines');
    assert.equal(product.businessLine, businessLine);
  }
});

test('upload validation accepts every real product ID with its slug and business line', () => {
  for (const [id, slug, name, businessLine] of EXPECTED_PRODUCTS) {
    assert.deepEqual(resolveUploadProduct(id, businessLine), { id, slug, name, businessLine });
  }
});

test('software and consulting stay selectable business lines without fake products', () => {
  for (const line of ['software', 'consulting'] as const) {
    assert.ok(BUSINESS_LINES.includes(line));
    assert.equal(hasUploadProducts(line), false);
    for (const [id] of EXPECTED_PRODUCTS) {
      assert.throws(() => resolveUploadProduct(id, line), (error: unknown) => {
        assert.ok(error instanceof UploadContractError);
        assert.equal(error.code, 'INVALID_PRODUCT');
        assert.equal(error.status, 400);
        return true;
      });
    }
  }
});
