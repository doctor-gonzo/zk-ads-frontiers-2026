// Run-folder bookkeeping (run.json) and the lifecycle of paid Venice jobs.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, isDefiniteFailure } from './venice.mjs';

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Written beside the target and renamed into place, so a failed write (a full
// disk, say) never leaves a truncated file behind.
export function writeJson(path, value, { mode } = {}) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readRun(dir) {
  const path = join(dir, 'run.json');
  return existsSync(path) ? readJson(path) : {};
}

export function updateRun(dir, patch) {
  writeJson(join(dir, 'run.json'), { ...readRun(dir), ...patch });
}

// Runs one paid job (`kind` 'video' or 'audio'), recording each state in
// run.json under `key`. A job that was queued (paid) but never downloaded is
// resumed rather than bought again, even if a different model is requested.
// Only answers about the job itself mark it failed; key, account and network
// problems leave it queued so the next run can still collect it.
export async function runPaidJob({ venice, dir, key, kind, spec, build, save, resumeCommand, announce, note, progress = () => {} }) {
  const recorded = readRun(dir)[key];
  let job = recorded?.status === 'queued' && recorded.queue_id ? recorded : null;
  if (job) {
    announce(
      job.model === spec.id
        ? `resuming ${job.model} job ${job.queue_id}, already paid for with the settings and hero it was queued with…`
        : `resuming the paid ${job.model} job ${job.queue_id} instead of starting ${spec.id}; run this step again afterwards for a new one…`,
    );
  } else {
    const { body, quote, summary, record } = build();
    const usd = await venice.quote(kind, quote);
    announce(`${spec.id} ${summary} (quoted $${usd.toFixed(2)})…`);
    const queued = await venice.queue(kind, body);
    job = { model: spec.id, privacy: spec.model_spec?.privacy, status: 'queued', queue_id: queued.queue_id, download_url: queued.download_url ?? null, usd, ...record };
    updateRun(dir, { [key]: job });
    if (resumeCommand) note(`Paid and queued. If this gets interrupted, collect it later with: ${resumeCommand}`);
  }
  let result;
  try {
    result = await venice.waitFor(kind, {
      model: job.model,
      queueId: job.queue_id,
      downloadUrl: job.download_url ?? undefined,
      onProgress: progress,
      onRetry: (error) => note(`…still waiting after: ${describe(error)}`),
    });
  } catch (error) {
    if (isDefiniteFailure(error)) {
      updateRun(dir, { [key]: { ...job, status: 'failed', error: error.message } });
    } else if (resumeCommand) {
      error.message += ` The job is still paid for; resume it with: ${resumeCommand}`;
    }
    throw error;
  }
  const file = save(result, job);
  // Recorded before cleanup, so an interruption here cannot strand a saved file.
  updateRun(dir, { [key]: { ...job, status: 'done', file } });
  try {
    await venice.complete(kind, { model: job.model, queueId: job.queue_id });
  } catch (error) {
    note(`Note: Venice did not confirm deleting its copy (${describe(error)}).`);
  }
  return { job, file };
}
