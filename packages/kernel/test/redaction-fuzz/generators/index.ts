import type { Generator } from '../row.js';
import { AUTHOR_GENERATORS } from './author.js';
import { CREDENTIALS_SEAT_GENERATORS } from './credentials-seat.js';
import { DESIGN_GENERATORS } from './design.js';
import { KERNEL_SEAT_GENERATORS } from './kernel-seat.js';
import { LONG_GENERATORS } from './long.js';
import { REAL_FORMAT_GENERATORS } from './real-formats.js';
import { STORED_GENERATORS } from './stored.js';

/** Every generator, by name: random concatenation (the kernel author's, the design's, both seats'),
 *  long lines (`long/…`), rows as earlier releases stored them (`stored/…`) and the real-format
 *  corpus (`formats/…`). A name is `<who>/<what>`. */
export const GENERATORS: Record<string, Generator> = {
  ...AUTHOR_GENERATORS,
  ...DESIGN_GENERATORS,
  ...CREDENTIALS_SEAT_GENERATORS,
  ...KERNEL_SEAT_GENERATORS,
  ...LONG_GENERATORS,
  ...STORED_GENERATORS,
  ...REAL_FORMAT_GENERATORS,
};

/** The real-format corpus: the generators whose secret places are what a format wrote (I-R5). */
export const CORPUS = Object.keys(REAL_FORMAT_GENERATORS);
