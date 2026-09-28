/**
 * Auraplex machine catalog — public API.
 *
 * Data comes from `lib/catalog.generated.ts`, which is produced by
 * `scripts/build-catalog.ts` reading source-of-truth files
 * (MACHINE_MAPPING.json + manifest.json + filesystem). Regenerate with
 * `pnpm catalog` after adding new photography.
 *
 * This module adds the decorative layer that doesn't belong in generated data:
 *   - human-written category summaries
 *   - the featured-slug allowlist
 *   - placeholder fields (speed/price/specs) ready to be filled when real
 *     data arrives — pages render an honest "On request" fallback meanwhile.
 */

import { MACHINES_RAW, type RawMachine } from './catalog.generated';

export type Category = 'labelling' | 'packaging' | 'automation';

export type Machine = RawMachine & {
  featured: boolean;
  /** Canonical English name, preserved when `name` is localized so that
   *  name-parsing logic (machineTags, regexes) stays locale-independent.
   *  Undefined on the canonical (English) records; set by localizeMachine. */
  nameEn?: string;
  summary: string;
  /** Throughput (units/min). Null until real numbers are supplied. */
  speed: number | null;
  /** Monthly quote in RM (where the sales team chooses to publish one).
   *  Null = "Quote on request" per Auraplex's standard sales process. */
  monthlyPrice: number | null;
  /** Long-form specs. Empty until supplied. */
  specs: { label: string; value: string; unit?: string }[];
};

const CATEGORY_SUMMARY: Record<Category, string> = {
  labelling:
    'Precision applicator engineered for ASEAN container shapes. Local installation and parts support.',
  packaging:
    'Continuous-operation sealing built for Malaysian production lines. Local installation and parts support.',
  automation:
    'AR-series additive manufacturing for prototyping, fixtures and short-run production.',
};

// Hand-picked feature flags — surfaced on the homepage and category heroes.
const FEATURED_SLUGS = new Set([
  'flexy-applicator',
  'semi-auto-wrap-around-labelling-machine',
  'print-apply-top-labelling-machine',
  'customized-top-labelling-machine',
  'continuous-band-sealing-machine',
]);

/**
 * Real per-machine copy + specs, verified from the live Auraplex site
 * (autolabellermalaysia.com — the "Auto Labeller Malaysia" trading site),
 * fetched 2026-07. Only machines whose live application copy could be
 * CONFIDENTLY matched to our slug are listed here; every other machine falls
 * back to the honest category summary rather than inventing copy. The site
 * publishes no numeric labelling specs (speed/dimensions), so only the 3D
 * printers — which list real feature sets — carry `specs`.
 */
const MACHINE_DETAILS: Record<
  string,
  { summary?: string; specs?: { label: string; value: string; unit?: string }[] }
> = {
  'top-labelling-machine': {
    summary: 'To apply a label on the top flat surface of a unit box or corrugated carton.',
  },
  'standard-top-labelling-machine': {
    summary:
      'To apply a label on the top flat surface of a unit box — used for hologram labels, ice-cream lids and pouches.',
  },
  'top-labelling-machine-with-corner-press-device': {
    summary:
      'A top labelling machine with a corner-press device — applies an anti-counterfeit security label that presses neatly over a corner.',
  },
  'two-side-labelling-machine-with-corner-press': {
    summary:
      'To apply a front-side corner label on a unit box or corrugated carton, pressed around the corner.',
  },
  'customized-top-labelling-machine': {
    summary:
      "A customized top labelling machine for uneven-surface products on a customer's production line.",
  },
  'bottom-labelling-machine': {
    summary: 'Applies a label to the bottom of products — a customized bottom-labelling solution.',
  },
  'customized-bottom-labelling-machine': {
    summary: 'Custom-made bottom labelling — e.g. for vegetable packaging.',
  },
  'egg-tray-labelling-machine': {
    summary: 'To apply a label on egg trays — configurable for 4, 6, 10, 15 or 30-egg trays.',
  },
  'three-side-labelling-machine': {
    summary: 'To apply a three-sided label on a square or rectangular container.',
  },
  'front-back-labelling-machine': {
    summary: 'To apply front and back labels on an oval or rectangular container.',
  },
  'body-neck-labelling-machine': {
    summary: 'To apply a body label and a neck label on a round bottle with a tapered neck.',
  },
  'semi-auto-round-bottle-labelling-machine': {
    summary: 'To apply a wrap-around label on a round-shape container.',
  },
  'vertical-wrap-around-labelling-machine': {
    summary: 'A semi-automatic machine to apply a wrap-around label on round bottles.',
  },
  'continuous-band-sealing-machine': {
    summary: 'Suitable to seal any light-weight plastic packaging on a continuous band.',
  },
  'continuous-band-sealing-machine-v2': {
    summary: 'Suitable to seal any light-weight plastic packaging on a continuous band.',
  },
  'ar600-3d-printer': {
    summary:
      'Locally built and supported 3D printer with HEPA filtration, automatic bed levelling, power-failure resume, a colour touchscreen and a filament run-out alarm.',
    specs: [
      { label: 'Bed levelling', value: 'Automatic (BLTouch)' },
      { label: 'Filtration', value: 'HEPA' },
      { label: 'Power-failure resume', value: 'Yes (LLRP)' },
      { label: 'Display', value: 'Colour touchscreen + USB' },
      { label: 'Filament', value: 'Run-out alarm + auto feed' },
    ],
  },
  'ar320-3d-printer': {
    summary:
      'Locally built and supported 3D printer with HEPA filtration, automatic bed levelling, power-failure resume, a colour touchscreen and a filament run-out alarm.',
    specs: [
      { label: 'Bed levelling', value: 'Automatic (BLTouch)' },
      { label: 'Filtration', value: 'HEPA' },
      { label: 'Power-failure resume', value: 'Yes (LLRP)' },
      { label: 'Display', value: 'Colour touchscreen + USB' },
      { label: 'Filament', value: 'Run-out alarm + auto feed' },
    ],
  },
  'ar220-3d-printer': {
    summary:
      'Locally built and supported 3D printer with a pause function, heated nozzle and cooling fan, and automatic filament feed.',
    specs: [
      { label: 'Pause / resume', value: 'Yes' },
      { label: 'Hot end', value: 'Heated nozzle + cooling fan' },
      { label: 'Filament', value: 'Auto feed' },
    ],
  },
};

/**
 * Clean cover renders imported from the original Auraplex CAD/render archive
 * (D:\WORK\Auraplex → public/products/real, via scripts/import-workimages.mjs).
 * These are watermark-free and higher quality than the scraped site images, so
 * where present they OVERRIDE both the cover and the gallery. Two of these
 * slugs (vertical-wrap-around, top-labelling-machine-v2,
 * custom-top-...-checking-system) previously had NO photo — this promotes them
 * out of the "photography pending" state. Only machines confidently identified
 * from the renders are listed; the rest keep their existing images / pending
 * state (no mismatched photos).
 */
const REAL_IMAGES: Record<string, string> = {
  'flexy-applicator': '/products/real/flexy-applicator.webp',
  'two-side-labelling-machine': '/products/real/two-side-labelling-machine.webp',
  'two-in-one-wrap-around-side-labelling-machine':
    '/products/real/two-in-one-wrap-around-side-labelling-machine.webp',
  'ar600-3d-printer': '/products/real/ar600-3d-printer.webp',
  'ar320-3d-printer': '/products/real/ar320-3d-printer.webp',
  'ar220-3d-printer': '/products/real/ar220-3d-printer.webp',
  'bottom-labelling-machine': '/products/real/bottom-labelling-machine.webp',
  'standard-top-labelling-machine': '/products/real/standard-top-labelling-machine.webp',
  'semi-auto-round-bottle-labelling-machine':
    '/products/real/semi-auto-round-bottle-labelling-machine.webp',
  'top-labelling-machine': '/products/real/top-labelling-machine.webp',
  'vertical-wrap-around-labelling-machine':
    '/products/real/vertical-wrap-around-labelling-machine.webp',
  'top-labelling-machine-v2': '/products/real/top-labelling-machine-v2.webp',
  'custom-top-labelling-machine-with-checking-system':
    '/products/real/custom-top-labelling-machine-with-checking-system.webp',
  // Front & back = a dual-head two-sided labeller (the "LEGACY" render).
  'front-back-labelling-machine': '/products/real/front-back-labelling-machine.webp',
  // v2 is the same machine as the original Continuous Band Sealing — reuse its photo.
  'continuous-band-sealing-machine-v2': '/products/Continuous_Band_Sealing_Machine_6.png',
  // Representative real renders for the last three (closest archive match).
  'three-side-labelling-machine': '/products/real/three-side-labelling-machine.webp',
  'top-labelling-machine-with-corner-press-device':
    '/products/real/top-labelling-machine-with-corner-press-device.webp',
  'body-neck-labelling-machine': '/products/real/body-neck-labelling-machine.webp',
};

export const MACHINES: Machine[] = MACHINES_RAW.map((m) => {
  const real = REAL_IMAGES[m.slug];
  return {
    ...m,
    image: real ?? m.image,
    gallery: real ? [real] : m.gallery,
    featured: FEATURED_SLUGS.has(m.slug),
    summary: MACHINE_DETAILS[m.slug]?.summary ?? CATEGORY_SUMMARY[m.category],
    speed: null,
    monthlyPrice: null,
    specs: MACHINE_DETAILS[m.slug]?.specs ?? [],
  };
});

export function getMachine(slug: string): Machine | null {
  return MACHINES.find((m) => m.slug === slug) ?? null;
}

export function getMachinesByCategory(category?: Category): Machine[] {
  if (!category) return MACHINES;
  return MACHINES.filter((m) => m.category === category);
}

/** Machines with a verified cover image — surface these first in grids. */
export function getMachinesWithCover(): Machine[] {
  return MACHINES.filter((m) => m.image !== null);
}

export function getFeaturedMachines(): Machine[] {
  return MACHINES.filter((m) => m.featured && m.image !== null);
}

/** Pretty category label for UI. */
export function categoryLabel(category: Category): string {
  return category === 'labelling'
    ? 'Labelling'
    : category === 'packaging'
      ? 'Packaging'
      : 'Automation';
}

/**
 * Auto-derive feature tags from a machine's name. Names follow a stable
 * vocabulary on auraplex.com.my, so token-matching is reliable. Limited to
 * the 3 most-informative tags per machine to keep cards scannable.
 */
export function machineTags(m: Machine): string[] {
  // Always parse the canonical English name — tag regexes match English tokens
  // and must keep working when `m.name` has been localized.
  const n = (m.nameEn ?? m.name).toLowerCase();
  const tags: string[] = [];

  // Application style (mutually-exclusive — pick the most specific match)
  if (/print\s*[&\s]?\s*apply/.test(n)) tags.push('Print & Apply');
  else if (/wrap[\s-]?around/.test(n)) tags.push('Wrap-Around');
  else if (/flat/.test(n)) tags.push('Flat');

  // Position
  if (/two[\s-]?in[\s-]?one/.test(n)) tags.push('2-in-1');
  else if (/two[\s-]?side/.test(n)) tags.push('Two-Side');
  else if (/three[\s-]?side/.test(n)) tags.push('Three-Side');
  else if (/front[\s-]?[&\s]?[\s-]?back/.test(n)) tags.push('Front & Back');
  else if (/body[\s-]?[&\s]?[\s-]?neck/.test(n)) tags.push('Body & Neck');
  else if (/\btop\b/.test(n)) tags.push('Top');
  else if (/\bbottom\b/.test(n)) tags.push('Bottom');
  else if (/vertical/.test(n)) tags.push('Vertical');

  // Capability
  if (/checking|vision/.test(n)) tags.push('Vision');
  else if (/thermal\s*transfer/.test(n)) tags.push('Thermal Transfer');
  else if (/corner\s*press/.test(n)) tags.push('Corner Press');
  else if (/round\s*bottle/.test(n)) tags.push('Round Bottle');
  else if (/egg\s*tray/.test(n)) tags.push('Egg Tray');
  else if (/auto\s*feeder/.test(n)) tags.push('Auto Feeder');

  // Automation
  if (/semi[\s-]?auto/.test(n)) tags.push('Semi-Auto');

  // Custom flag — never first, treated as a modifier
  if (/customi[sz]ed|custom/.test(n) && !tags.includes('Vision')) {
    tags.push('Custom');
  }

  // Versioning
  const vMatch = n.match(/\bv(\d+)\b/);
  if (vMatch) tags.push(`v${vMatch[1]}`);

  return tags.slice(0, 3);
}

/** Counts per category (and total) — for filter UI. */
export function categoryCounts(): {
  all: number;
  labelling: number;
  packaging: number;
  automation: number;
} {
  return {
    all: MACHINES.length,
    labelling: MACHINES.filter((m) => m.category === 'labelling').length,
    packaging: MACHINES.filter((m) => m.category === 'packaging').length,
    automation: MACHINES.filter((m) => m.category === 'automation').length,
  };
}
