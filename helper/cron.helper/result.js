
import { db } from "../../config/db.js";
import { declareResultForPool } from "./result-declear.js";


export const declareResultsJob = async () => {
  let pools = [];

  try {
    const [rows] = await db.execute(
      `SELECT p.id, p.title, p.jackpot
       FROM pools p
       LEFT JOIN results r ON r.pool_id = p.id
       WHERE p.status = 'expired'
         AND r.id IS NULL`
    );
    pools = rows || [];
  } catch (err) {
    throw err;
  }

  if (!pools.length) {
    return { processed: 0, success: 0, skipped: 0, failed: 0 };
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const pool of pools) {
    try {
      const out = await declareResultForPool(pool);

      if (out?.skipped) {
        skipped++;
      } else {
        success++;
      }
    } catch (err) {
      failed++;
    }
  }

  return {
    processed: pools.length,
    success,
    skipped,
    failed,
  };
};