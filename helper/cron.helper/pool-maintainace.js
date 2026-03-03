import { db } from "../../config/db.js";
import { makeUniqueSlug } from "../pool.helper/slugGenerator.js";

export const updatePoolStatus = async () => {
  try {
    const [result] = await db.execute(`
      UPDATE pools
      SET status = 'expired'
      WHERE expire_at < NOW()
      AND status != 'expired'
    `);

    console.log(`Pools expired status updated: ${result.affectedRows}`);
    return result.affectedRows;

  } catch (error) {
    console.error(" Pool expire update error:", error);
    return 0;
  }
}

export const deleteExpirePool = async () => {

  try {
    const [result] = await db.execute(
      "DELETE FROM pools WHERE status = ?",
      ["expired"]
    );

    if (result.affectedRows === 0) {
      console.log("message: No expired pools found to delete")
    }

    console.log(` Expired pools deleted: ${result.affectedRows}`);
    return result.affectedRows;

  } catch (error) {
    console.error(" Pool delete error:", error);
    return 0;
  }
}

export const addNewPools = async () => {
  try {
    const [templates] = await db.execute(`SELECT * FROM pool_templates`);

    if (!templates.length) return 0;

    let insertedCount = 0;

    for (const template of templates) {
      const slug = await makeUniqueSlug(template.title);

      // NOTE: slug uniqueness check (optional but ok)
      const [existing] = await db.execute(`SELECT id FROM pools WHERE slug = ?`, [slug]);
      if (existing.length > 0) continue;


      const startAt = new Date();


      const expireAt =
        template.expire_at ? new Date(template.expire_at) : new Date(startAt.getTime() + 5 * 60 * 1000);

      await db.execute(
        `INSERT INTO pools
          (title, price, jackpot, imageurl, slug, status, start_at, expire_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          template.title,
          template.price,
          template.jackpot,
          template.imageurl,
          slug,
          template.status ?? "active",
          startAt,
          expireAt,
        ]
      );

      insertedCount++;
    }

    return insertedCount;
  } catch (error) {
    return 0;
  }
};