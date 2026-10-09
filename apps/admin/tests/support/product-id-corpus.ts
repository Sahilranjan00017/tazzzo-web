/** Shared product-id corpus: canonical grammar ^TZP-[A-Za-z0-9-]{1,40}$ (full match, no case normalisation). */
export const VALID_PRODUCT_IDS: readonly string[] = [
  'TZP-1',
  'TZP-MED-3',
  'TZP-l001',
  'TZP-Med-3',
  'TZP-A-B',
  'TZP--1',
  `TZP-${'a'.repeat(40)}`,
  `TZP-${'Z9-'.repeat(13)}x`,
]

export const INVALID_PRODUCT_IDS: readonly string[] = [
  'TZP-',
  `TZP-${'a'.repeat(41)}`,
  'TZP-a_b',
  'TZP-a b',
  'tzp-1',
  'Tzp-1',
  'TZP-1/../x',
  'TZP-%41',
  'TZP-1\n',
  'TZP-1\r\n',
  '\nTZP-1',
  ' TZP-1',
  'TZP-1 ',
  'TZP-١٢٣', // Arabic-Indic digits
  'TZP-１２３', // fullwidth digits
  'TZP-é',
  '',
]
