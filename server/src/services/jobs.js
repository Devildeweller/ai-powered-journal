import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Minimal in-process background queue.
 *
 * Embedding an entry or distilling memories takes a network round trip to an
 * AI provider, so those run after the HTTP response has been sent.  A single
 * Node process is enough for this app, which keeps the deployment to one
 * service with no Redis.  Durability comes from the database instead: entries
 * carry an embedding_status, and anything still 'pending' is re-queued on boot.
 */
class JobQueue {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = concurrency;
    this.pending = [];
    this.active = 0;
    this.idleWaiters = [];
  }

  add(name, task, { retries = 2 } = {}) {
    this.pending.push({ name, task, retries, attempt: 0 });
    this.#pump();
  }

  /** Resolves once every queued and running job has finished (used by tests and scripts). */
  drain() {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  #pump() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.active += 1;
      this.#run(job).finally(() => {
        this.active -= 1;
        if (this.active === 0 && this.pending.length === 0) {
          this.idleWaiters.splice(0).forEach((resolve) => resolve());
        } else {
          this.#pump();
        }
      });
    }
  }

  async #run(job) {
    for (;;) {
      try {
        await job.task();
        return;
      } catch (error) {
        job.attempt += 1;
        if (job.attempt > job.retries) {
          logger.error({ err: error, job: job.name }, 'background job failed');
          return;
        }
        logger.warn({ err: error, job: job.name, attempt: job.attempt }, 'background job failed, retrying');
        if (!env.isTest) await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** (job.attempt - 1)));
      }
    }
  }
}

export const jobs = new JobQueue({ concurrency: 2 });
