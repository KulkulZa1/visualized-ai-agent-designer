// Shared by the tests of src/evolve. Not a test file.
import { aggregate, type EvalResult, type TaskResult } from "@/evolve/measure";

/** RRSI's test helper `_ev`: an evaluation of tasks of weight 1 with these rewards, every trial costing `tokens`. */
export function evalOf(job: string, rewardsByTask: Record<string, number[]>, k: number, tokens = 1000): EvalResult {
  const perTask: Record<string, TaskResult> = {};
  for (const [id, rewards] of Object.entries(rewardsByTask)) {
    perTask[id] = { rewards: [...rewards], weights: rewards.map(() => 1), tokens: rewards.map(() => tokens), missing: 0 };
  }
  return aggregate(job, k, perTask);
}

/** Ten tasks t0..t9 of two trials each, the first `passing` of which pass both: S = passing / 10. */
export function tenTasks(job: string, passing: number, tokens = 1000): EvalResult {
  const rewards: Record<string, number[]> = {};
  for (let i = 0; i < 10; i++) rewards[`t${i}`] = i < passing ? [1, 1] : [0, 0];
  return evalOf(job, rewards, 2, tokens);
}
