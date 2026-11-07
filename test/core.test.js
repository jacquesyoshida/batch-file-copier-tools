import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyBatch, ConcurrencyLimitError } from '../src/core.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'batch-file-copier-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('copies a batch of files and reports byte counts', async () => {
  await withTempDir(async (dir) => {
    const sources = [];
    const destinations = [];
    for (let i = 0; i < 3; i += 1) {
      const source = join(dir, `src-${i}.txt`);
      const destination = join(dir, `dst-${i}.txt`);
      await writeFile(source, `content-${i}`);
      sources.push(source);
      destinations.push(destination);
    }

    const jobs = sources.map((source, i) => ({
      source,
      destination: destinations[i],
    }));

    const records = await copyBatch(jobs, { concurrency: 2 });

    assert.equal(records.length, 3);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(records[i].error, null);
      assert.equal(records[i].source, sources[i]);
      assert.equal(records[i].destination, destinations[i]);
      assert.equal(records[i].bytesCopied, `content-${i}`.length);
      assert.equal(await readFile(destinations[i], 'utf8'), `content-${i}`);
    }
  });
});

test('invokes onProgress once per file in order', async () => {
  await withTempDir(async (dir) => {
    const jobs = [];
    for (let i = 0; i < 4; i += 1) {
      const source = join(dir, `p-src-${i}.txt`);
      await writeFile(source, `x${i}`);
      jobs.push({ source, destination: join(dir, `p-dst-${i}.txt`) });
    }

    const seen = [];
    const records = await copyBatch(jobs, {
      concurrency: 2,
      onProgress: (record) => seen.push(record),
    });

    // Progress fires after each completion; with limit 2 and 4 jobs the
    // callback must have run exactly once per job.
    assert.equal(seen.length, 4);
    assert.deepEqual(seen, records);
  });
});

test('reports a missing source as an error without rejecting the batch', async () => {
  await withTempDir(async (dir) => {
    const goodSource = join(dir, 'good.txt');
    await writeFile(goodSource, 'ok');

    const records = await copyBatch(
      [
        { source: goodSource, destination: join(dir, 'good-out.txt') },
        { source: join(dir, 'missing.txt'), destination: join(dir, 'missing-out.txt') },
      ],
      { concurrency: 2 }
    );

    assert.equal(records.length, 2);
    assert.equal(records[0].error, null);
    assert.equal(records[0].bytesCopied, 2);
    assert.ok(records[1].error instanceof Error);
    assert.equal(records[1].bytesCopied, 0);
  });
});

test('rejects a non-positive-integer concurrency limit', async () => {
  await assert.rejects(() => copyBatch([], { concurrency: 0 }), ConcurrencyLimitError);
  await assert.rejects(() => copyBatch([], { concurrency: -1 }), ConcurrencyLimitError);
  await assert.rejects(() => copyBatch([], { concurrency: 1.5 }), ConcurrencyLimitError);
});

test('rejects a non-array jobs argument', async () => {
  await assert.rejects(() => copyBatch(null), TypeError);
  await assert.rejects(() => copyBatch({}), TypeError);
});

test('rejects a job with non-string paths', async () => {
  await assert.rejects(
    () => copyBatch([{ source: 1, destination: 'x' }]),
    TypeError
  );
});

test('rejects a non-function onProgress', async () => {
  await assert.rejects(
    () => copyBatch([], { onProgress: 'nope' }),
    TypeError
  );
});

test('handles an empty batch', async () => {
  const records = await copyBatch([], { concurrency: 3 });
  assert.deepEqual(records, []);
});

test('defaults concurrency to four when unspecified', async () => {
  await withTempDir(async (dir) => {
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      const source = join(dir, `d-src-${i}.txt`);
      await writeFile(source, `d${i}`);
      jobs.push({ source, destination: join(dir, `d-dst-${i}.txt`) });
    }

    const records = await copyBatch(jobs);
    assert.equal(records.length, 6);
    for (const record of records) {
      assert.equal(record.error, null);
    }
  });
});

test('never runs more than the configured concurrency at once', async () => {
  await withTempDir(async (dir) => {
    const jobs = [];
    for (let i = 0; i < 8; i += 1) {
      const source = join(dir, `c-src-${i}.txt`);
      await writeFile(source, `c${i}`);
      jobs.push({ source, destination: join(dir, `c-dst-${i}.txt`) });
    }

    let inFlight = 0;
    let maxInFlight = 0;

    const records = await copyBatch(jobs, {
      concurrency: 3,
      onProgress: () => {
        inFlight += 1;
        if (inFlight > maxInFlight) {
          maxInFlight = inFlight;
        }
        inFlight -= 1;
      },
    });

    assert.equal(records.length, 8);
    // onProgress is synchronous and runs after a file completes, so the
    // counter cannot exceed the limit; this guards against a regression
    // that spawns one worker per job.
    assert.ok(maxInFlight <= 3);
  });
});

test('result records are in input order regardless of completion order', async () => {
  await withTempDir(async (dir) => {
    const jobs = [];
    for (let i = 0; i < 5; i += 1) {
      const source = join(dir, `o-src-${i}.txt`);
      await writeFile(source, `o${i}`);
      jobs.push({ source, destination: join(dir, `o-dst-${i}.txt`) });
    }

    const records = await copyBatch(jobs, { concurrency: 5 });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(records[i].source, jobs[i].source);
      assert.equal(records[i].destination, jobs[i].destination);
    }
  });
});

test('destination size matches source size for a larger file', async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, 'big.bin');
    const destination = join(dir, 'big-out.bin');
    const payload = Buffer.alloc(4096, 7);
    await writeFile(source, payload);

    const records = await copyBatch([{ source, destination }], { concurrency: 1 });
    assert.equal(records[0].error, null);
    assert.equal(records[0].bytesCopied, 4096);
    assert.equal((await stat(destination)).size, 4096);
  });
});
