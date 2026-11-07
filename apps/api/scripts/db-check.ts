import { createPool } from "./pool";

// Verifies the integrity rules in the schema. Runs inside a transaction that is always rolled back.
async function main() {
  const pool = createPool();
  const client = await pool.connect();
  let failures = 0;

  const expectFail = async (name: string, sql: string, params: unknown[] = []) => {
    await client.query("SAVEPOINT s");
    try {
      await client.query(sql, params);
      await client.query("ROLLBACK TO SAVEPOINT s");
      console.log(`FAIL  ${name} (statement was accepted)`);
      failures++;
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT s");
      console.log(`ok    ${name}`);
    }
  };

  try {
    await client.query("BEGIN");
    const cust = (await client.query<{ id: string }>("SELECT id FROM users WHERE role='CUSTOMER' LIMIT 1")).rows[0];
    const riders = (await client.query<{ id: string }>("SELECT id FROM users WHERE role='RIDER' LIMIT 2")).rows;
    const vendor = (await client.query<{ id: string }>("SELECT id FROM vendors LIMIT 1")).rows[0];
    const item = (await client.query<{ id: string }>("SELECT id FROM items LIMIT 1")).rows[0];
    if (!cust || riders.length < 2 || !vendor || !item) throw new Error("Run `npm run db:seed` first.");

    const insertOrder = `INSERT INTO orders (customer_id, vendor_id, rider_id, status, subtotal_kobo, delivery_fee_kobo, total_kobo, drop_address, drop_lat, drop_lng, distance_m, paystack_reference)
                         VALUES ($1,$2,$3,$4,1000,500,1500,'Test drop',9.07,7.47,1200,$5) RETURNING id`;

    const o1 = (await client.query<{ id: string }>(insertOrder, [cust.id, vendor.id, riders[0].id, "ASSIGNED", "ref-1"])).rows[0];
    await expectFail("rider cannot hold two active orders", insertOrder, [cust.id, vendor.id, riders[0].id, "PICKED_UP", "ref-2"]);
    await expectFail("duplicate paystack reference rejected", insertOrder, [cust.id, vendor.id, riders[1].id, "ASSIGNED", "ref-1"]);
    await expectFail("order total must equal subtotal + fee", `UPDATE orders SET total_kobo = 1 WHERE id = $1`, [o1.id]);
    await expectFail("order quantity must be positive", `INSERT INTO order_items (order_id, item_id, quantity, unit_price_kobo) VALUES ($1,$2,0,100)`, [o1.id, item.id]);
    await expectFail("negative item price rejected", `UPDATE items SET price_kobo = -1 WHERE id = $1`, [item.id]);

    await client.query(`INSERT INTO payments (order_id, reference, amount_kobo, status) VALUES ($1,'ref-1',1500,'success')`, [o1.id]);
    await expectFail("duplicate payment reference rejected", `INSERT INTO payments (order_id, reference, amount_kobo, status) VALUES ($1,'ref-1',1500,'success')`, [o1.id]);

    // A delivered order does not block the rider from taking a new one.
    await client.query("UPDATE orders SET status='DELIVERED' WHERE id=$1", [o1.id]);
    await client.query(insertOrder, [cust.id, vendor.id, riders[0].id, "ASSIGNED", "ref-3"]);
    console.log("ok    rider can take a new order after delivery");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All integrity checks passed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
