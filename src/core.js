import { copyFile } from 'node:fs/promises';

/**
 * Thrown when the requested concurrency limit is not a positive integer.
 * A dedicated error type lets callers distinguish configuration mistakes
 * from I/O failures raised by the underlying filesystem.
 */
export class ConcurrencyLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConcurrencyLimitError';
  }
}

/**
 * Validate a concurrency limit.
 *
 * We reject non-integers explicitly rather than coercing, because silently
 * flooring a float would hide a caller bug and produce surprising scheduling.
 *
 * @param {number} limit
 * @returns {number} the validated limit
 */
function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConcurrencyLimitError(
      `concurrency limit must be a positive integer, received ${String(limit)}`
    );
  }
  return limit;
}

/**
 * Copy a batch of files concurrently, bounded by a concurrency limit.
 *
 * Each job is described by `{ source, destination }`. The optional
 * `onProgress` callback is invoked after each file finishes (success or
 * failure) with `{ source, destination, bytesCopied, error }`. `bytesCopied`
 * is the size of the source file as reported by the filesystem copy, or 0 on
 * failure. `error` is `null` on success.
 *
 * The returned promise resolves with the same per-file records once every
 * job has settled. Failures do not reject the batch: a copy that fails is
 * reported through the record and through `onProgress`, so one bad file does
 * not abort the rest. Callers that want fail-fast behaviour can inspect the
 * records and throw themselves.
 *
 * @param {Array<{source: string, destination: string}>} jobs
 * @param {{ concurrency?: number, onProgress?: (record: object) => void }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function copyBatch(jobs, options = {}) {
  if (!Array.isArray(jobs)) {
    throw new TypeError('jobs must be an array');
  }

  const limit = options.concurrency === undefined ? 4 : validateLimit(options.concurrency);
  const onProgress = options.onProgress;

  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('onProgress must be a function when provided');
  }

  const results = new Array(jobs.length);
  let nextIndex = 0;

  /**
   * Pull the next unclaimed job. JavaScript is single-threaded, so the
   * read-then-increment here is atomic with respect to other workers; no
   * locking is needed to hand out distinct indices.
   */
  function claim() {
    if (nextIndex >= jobs.length) {
      return null;
    }
    const index = nextIndex;
    nextIndex += 1;
    return index;
  }

  async function worker() {
    for (;;) {
      const index = claim();
      if (index === null) {
        return;
      }

      const job = jobs[index];
      if (job === null || typeof job !== 'object') {
        throw new TypeError(`job at index ${index} must be an object`);
      }

      const { source, destination } = job;
      if (typeof source !== 'string' || typeof destination !== 'string') {
        throw new TypeError(
          `job at index ${index} must have string source and destination`
        );
      }

      let bytesCopied = 0;
      let error = null;

      try {
        await copyFile(source, destination);
        // copyFile does not report a byte count; the size of the destination
        // is the honest answer for how many bytes were written.
        const stat = await import('node:fs/promises').then((fs) => fs.stat(destination));
        bytesCopied = stat.size;
      } catch (err) {
        error = err;
      }

      const record = { source, destination, bytesCopied, error };
      results[index] = record;

      if (onProgress !== undefined) {
        onProgress(record);
      }
    }
  }

  const workerCount = Math.min(limit, jobs.length);
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}
