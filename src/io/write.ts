import type { Gps, Photo } from '../types';
import { mapLimit, message, sameGps } from '../util';
import { writeGps } from './gps';

export interface WriteResult {
  failed: number;
}

interface WriteJob {
  photo: Photo;
  target: Gps;
  sequence: number;
}

const queues = new Map<string, Promise<void>>();
const latestSequence = new Map<string, number>();
let nextSequence = 0;

async function writeOne(job: WriteJob): Promise<void> {
  const { photo, target, sequence } = job;
  const previous = queues.get(photo.id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    // A newer move was committed while this one was queued. Its write will
    // follow in the per-file queue, so do not install this stale position.
    if (latestSequence.get(photo.id) !== sequence) return;

    await writeGps(photo.handle, target);
    photo.origGps = { ...target };
    photo.writeError = undefined;
  });

  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(photo.id, tail);

  try {
    await run;
  } finally {
    if (queues.get(photo.id) === tail) queues.delete(photo.id);
  }
}

export async function writePhotos(
  photos: Photo[],
  onProgress?: (done: number, total: number) => void,
): Promise<WriteResult> {
  const sequence = ++nextSequence;
  const jobs: WriteJob[] = [];

  // Snapshot the target positions now. A drag can continue while this batch is
  // being written; later files must not pick up positions from a newer drag.
  for (const photo of photos) {
    if (photo.kind !== 'jpeg' || !photo.gps) continue;
    latestSequence.set(photo.id, sequence);
    jobs.push({
      photo,
      target: { ...photo.gps },
      sequence,
    });
  }

  let done = 0;
  let failed = 0;

  await mapLimit(jobs, 8, async (job) => {
    try {
      await writeOne(job);
    } catch (error) {
      failed += 1;
      job.photo.writeError = message(error);
      if (sameGps(job.photo.gps, job.target)) {
        job.photo.gps = job.photo.origGps ? { ...job.photo.origGps } : null;
      }
    } finally {
      done += 1;
      onProgress?.(done, jobs.length);
    }
  });

  return { failed };
}
