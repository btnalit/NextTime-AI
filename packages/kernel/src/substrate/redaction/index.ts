/**
 * substrate/redaction: what counts as a secret-looking value, and the scrubs that replace one — a
 * content primitive with no policy in it, so the substrate's own write points can apply it (the
 * graph store's Fact and observed-Object properties, review of #549). When else to apply it, and
 * what a person must confirm, is governance's (governance/redaction).
 */
export * from './secret-values.js';
export * from './shown-text.js';
