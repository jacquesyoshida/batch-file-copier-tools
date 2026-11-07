// Public entry point for batch-file-copier-tools.
// Re-exports the core API so consumers only need to import from one place.
export { copyBatch, ConcurrencyLimitError } from './core.js';
