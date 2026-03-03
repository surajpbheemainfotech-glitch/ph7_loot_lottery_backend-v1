import cron from "node-cron";
import {
  updatePoolStatus,
  deleteExpirePool,
  addNewPools,
} from "../../helper/cron.helper/pool-maintainace.js";
import { declareResultsJob } from "../../helper/cron.helper/result.js";

export const startPoolCron = async() => {
  cron.schedule(
    "*/5 * * * *", 
    async () => {
      const start = Date.now();
      console.log(" Pool cron started...");

      try {
        const expired = await updatePoolStatus();
        console.log(` Pools expired: ${expired}`);
      } catch (err) {
        console.error("updatePoolStatus failed:", err.message);
      }

      try {
        const resultSummary = await declareResultsJob();
        console.log("Results job:", resultSummary);
      } catch (err) {
        console.error(" declareResultsJob failed:", err.message);
      }

      try {
        const deleted = await deleteExpirePool();
        console.log(` Expired pools deleted: ${deleted}`);
      } catch (err) {
        console.error("deleteExpirePool failed:", err.message);
      }

      try {
        const added = await addNewPools();
        console.log(`New pools added: ${added}`);
      } catch (err) {
        console.error("addNewPools failed:", err.message);
      }

      console.log(`Pool cron finished in ${Date.now() - start}ms\n`);
    },
    {
      timezone: "Asia/Kolkata",
    }
  );
};