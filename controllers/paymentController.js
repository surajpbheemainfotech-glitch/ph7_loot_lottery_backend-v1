import crypto from "crypto";
import { db } from "../config/db.js";
import razorpayInstance, { rzpx } from "../config/razurpayConfig.js";

export const createOrder = async (req, res) => {
  const { amount, userId, currency = "INR" } = req.body;

  try {
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const receipt = `receipt_${Date.now()}`;

    const options = {
      amount: Math.round(Number(amount) * 100),
      currency,
      receipt,
    };

    const order = await razorpayInstance.orders.create(options);

    await db.query(
      `INSERT INTO payments (user_id, razorpay_order_id, amount, currency, status, receipt)
       VALUES (?, ?, ?, ?, 'created', ?)`,
      [userId, order.id, order.amount, order.currency, receipt]
    );

    return res.json({ success: true, order, message: "Order created" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Order creation failed" });
  }
};

export const verifyPayment = async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    userId,
    package_id,
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: "Missing payment fields" });
  }

  if (!userId) return res.status(400).json({ success: false, message: "userId is required" });
  if (!package_id) return res.status(400).json({ success: false, message: "package_id is required" });

  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    await db.query(`UPDATE payments SET status='failed' WHERE razorpay_order_id=?`, [
      razorpay_order_id,
    ]);

    return res.status(400).json({ success: false, message: "Invalid signature" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [payRows] = await conn.execute(
      `SELECT id, amount, status FROM payments WHERE razorpay_order_id = ? FOR UPDATE`,
      [razorpay_order_id]
    );

    if (!payRows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Order not found in DB" });
    }

    const payment = payRows[0];

    if (payment.status === "paid") {
      await conn.commit();
      return res.json({ success: true, message: "Already verified", amount: payment.amount });
    }

    const [userRows] = await conn.execute(`SELECT id, wallet FROM users WHERE id = ?`, [userId]);
    if (!userRows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "User not found" });
    }

    await conn.execute(
      `UPDATE payments
       SET razorpay_payment_id=?, razorpay_signature=?, status='paid'
       WHERE razorpay_order_id=?`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    );

    await conn.execute(
      `INSERT INTO user_packages (user_id, package_id, purchased_at)
       VALUES (?, ?, NOW())`,
      [userId, package_id]
    );

    await conn.execute(
      `UPDATE users SET wallet = wallet + ? WHERE id = ?`,
      [payment.amount, userId]
    );

    await conn.commit();

    return res.json({
      success: true,
      amount: payment.amount,
      message: "Payment verified, package updated",
    });
  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: "Verification failed" });
  } finally {
    conn.release();
  }
};

export const requestWithdrawAmount = async (req, res) => {
  const { userId, amount, method, upi_id, bank_account, ifsc, account_holder } = req.body;

  try {
    if (!userId || amount == null || !method) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const [userRows] = await db.execute("SELECT id FROM users WHERE id=?", [userId]);
    if (!userRows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const [result] = await db.execute(
      `INSERT INTO withdraw_requests 
       (user_id, amount, method, upi_id, bank_account, ifsc, account_holder, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        userId,
        amt,
        method,
        method === "upi" ? upi_id : null,
        method === "bank" ? bank_account : null,
        method === "bank" ? ifsc : null,
        method === "bank" ? account_holder : null,
      ]
    );

    return res.status(201).json({
      success: true,
      withdrawId: result.insertId,
      message: "Request sent to admin",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getAllWithdrawRequests = async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM withdraw_requests");
    return res.status(200).json({
      success: true,
      message: "Withdraw requests fetched",
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const approveWithdrawRequest = async (req, res) => {
  const { withdrawId, adminId, status, adminNote = "" } = req.body;

  try {
    if (!withdrawId || !adminId || !status) {
      return res.status(400).json({
        success: false,
        message: "withdrawId, status and adminId required",
      });
    }

    const allowedStatus = ["APPROVED", "REJECTED"];
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be either APPROVED or REJECTED",
      });
    }

    const [adminRows] = await db.execute("SELECT id FROM admin WHERE id=?", [adminId]);
    if (!adminRows.length) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const [wrRows] = await db.execute(
      "SELECT id, user_id, status FROM withdraw_requests WHERE id=?",
      [withdrawId]
    );

    if (!wrRows.length) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    if (wrRows[0].status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Already ${wrRows[0].status}`,
      });
    }

    const approvedAt = status === "APPROVED" ? new Date() : null;
    const rejectedAt = status === "REJECTED" ? new Date() : null;

    const [result] = await db.execute(
      `UPDATE withdraw_requests
       SET 
         status = ?,
         admin_note = ?,
         approved_by = ?,
         approved_at = ?,
         rejected_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [status, adminNote || null, adminId, approvedAt, rejectedAt, withdrawId]
    );

    if (result.affectedRows === 0) {
      return res.status(409).json({
        success: false,
        message: "Request already processed",
      });
    }

    return res.json({
      success: true,
      message: `Withdraw ${status.toLowerCase()} successfully`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const executeWithdrawPayout = async (req, res) => {
  const { withdrawId } = req.body;
  const conn = await db.getConnection();

  try {
    if (!withdrawId) {
      return res.status(400).json({ success: false, message: "withdrawId required" });
    }

    await conn.beginTransaction();

    const [reqRows] = await conn.execute(
      "SELECT * FROM withdraw_requests WHERE id=? FOR UPDATE",
      [withdrawId]
    );

    if (!reqRows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    const wr = reqRows[0];

    if (wr.status !== "APPROVED") {
      await conn.rollback();
      return res
        .status(400)
        .json({ success: false, message: `Request must be APPROVED (current ${wr.status})` });
    }

    const [users] = await conn.execute(
      "SELECT id, wallet, first_name, email FROM users WHERE id=? FOR UPDATE",
      [wr.user_id]
    );

    if (!users.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = users[0];
    const amt = Number(wr.amount);
    const wallet = Number(user.wallet || 0);

    if (!Number.isFinite(amt) || amt <= 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: "Invalid withdraw amount" });
    }

    if (wallet < amt) {
      await conn.execute(
        "UPDATE withdraw_requests SET status='FAILED', failure_reason=? WHERE id=?",
        ["Insufficient wallet balance at payout time", withdrawId]
      );

      await conn.commit();
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });
    }

    await conn.execute("UPDATE withdraw_requests SET status='PROCESSING' WHERE id=?", [withdrawId]);
    await conn.execute("UPDATE users SET wallet = wallet - ? WHERE id=?", [amt, wr.user_id]);

    const idempotencyKey = crypto.randomUUID();
    const DEFAULT_PHONE = "9999999999";

    const payoutPayload =
      wr.method === "bank"
        ? {
            account_number: process.env.RAZORPAY_ACCOUNT_NUMBER,
            amount: Math.round(amt * 100),
            currency: "INR",
            mode: "IMPS",
            purpose: "payout",
            queue_if_low_balance: true,
            reference_id: `withdraw_${withdrawId}`,
            narration: "Withdrawal",
            fund_account: {
              account_type: "bank_account",
              bank_account: {
                name: wr.account_holder,
                ifsc: wr.ifsc,
                account_number: wr.bank_account,
              },
              contact: {
                name: user.first_name || "User",
                email: user.email,
                contact: DEFAULT_PHONE,
                type: "customer",
                reference_id: `user_${wr.user_id}`,
              },
            },
          }
        : {
            account_number: process.env.RZP_X_ACCOUNT_NUMBER,
            amount: Math.round(amt * 100),
            currency: "INR",
            mode: "UPI",
            purpose: "payout",
            queue_if_low_balance: true,
            reference_id: `withdraw_${withdrawId}`,
            narration: "Withdrawal",
            fund_account: {
              account_type: "vpa",
              vpa: { address: wr.upi_id },
              contact: {
                name: user.first_name || "User",
                email: user.email,
                contact: DEFAULT_PHONE,
                type: "customer",
                reference_id: `user_${wr.user_id}`,
              },
            },
          };

    let payout;
    try {
      const resp = await rzpx.post("/v1/payouts", payoutPayload, {
        headers: { "X-Payout-Idempotency": idempotencyKey },
      });
      payout = resp.data;
    } catch (apiErr) {
      const apiMsg =
        apiErr?.response?.data?.error?.description ||
        apiErr?.response?.data?.error?.message ||
        apiErr?.message ||
        "Payout API failed";

      await conn.execute("UPDATE users SET wallet = wallet + ? WHERE id=?", [amt, wr.user_id]);
      await conn.execute(
        "UPDATE withdraw_requests SET status='FAILED', failure_reason=? WHERE id=?",
        [apiMsg, withdrawId]
      );

      await conn.commit();

      return res.status(500).json({
        success: false,
        message: "Payout failed",
        error: apiMsg,
      });
    }

    await conn.execute(
      "UPDATE withdraw_requests SET status='SUCCESS', razorpay_payout_id=? WHERE id=?",
      [payout.id, withdrawId]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: "Withdraw payout initiated",
      data: { withdrawId, payoutId: payout.id, payoutStatus: payout.status },
      wallet: { deducted: amt, remainingBalance: wallet - amt },
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}

    return res.status(500).json({ success: false, message: "Server error", error: err?.message });
  } finally {
    conn.release();
  }
};