# batch-file-copier-tools

Copies multiple files concurrently with a configurable concurrency limit and a per-file progress callback.

```js
import { copyBatch } from 'batch-file-copier-tools';

const records = await copyBatch(
  [
    { source: 'a.txt', destination: 'out/a.txt' },
    { source: 'b.txt', destination: 'out/b.txt' },
  ],
  {
    concurrency: 2,
    onProgress: (record) => {
      console.log(record.source, record.bytesCopied, record.error);
    },
  }
);
```

## Why this exists

`fs.copyFile` handles one file at a time. Copying a directory of files by
awaiting each copy in a loop is simple but slow when the filesystem can
overlap I/O, and firing off every copy at once exhausts file descriptors on
large batches. This library sits in between: it runs at most `concurrency`
copies at a time, defaulting to 4, and reports each file as it finishes.

The deliberate trade-off is that a failed copy does not reject the batch. The
returned promise resolves with one record per job, and each record carries its
own `error` (or `null`). That makes it straightforward to copy a directory
where a few entries are unreadable without losing the rest, at the cost of a
caller who genuinely wants fail-fast having to inspect the records and throw.

## API

### `copyBatch(jobs, options?)`

- `jobs`: array of `{ source: string, destination: string }`.
- `options.concurrency`: positive integer, default `4`.
- `options.onProgress`: function called once per completed file with the same
  record object that appears in the result.

Returns a promise for an array of records in the same order as `jobs`. Each
record is `{ source, destination, bytesCopied, error }`. `bytesCopied` is the
size of the destination file on success and `0` on failure. `error` is `null`
on success and the thrown `Error` on failure.

### `ConcurrencyLimitError`

Thrown synchronously by `copyBatch` when `concurrency` is not a positive
integer. It is exported so callers can catch configuration mistakes separately
from filesystem errors.

## The awkward edge

`copyBatch` rejects with a `TypeError` for malformed input (a non-array
`jobs`, a job without string paths, a non-function `onProgress`) before any
copy starts, but it does *not* reject for a copy that fails mid-batch. Those
failures appear only in the records and the progress callback. If you need to
know whether the whole batch succeeded, check `records.every((r) => r.error === null)`.
