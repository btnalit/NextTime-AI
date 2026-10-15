/**
 * The secret-value primitives live in substrate/redaction (review of #549: the graph store applies
 * them at its write point, and the substrate may not depend on governance). Re-exported here so
 * governance/redaction stays the one import for everything above the substrate.
 */
export * from '../../substrate/redaction/secret-values.js';
