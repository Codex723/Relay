import bcrypt from "bcryptjs";
import { createPool } from "./pool";

// All seeded vendors, riders and customers are DEMO DATA (fictional).
const DEMO_PASSWORD = "relay-demo-123";

type VendorSeed = {
  name: string;
  city: "ABUJA" | "LAGOS";
  address: string;
  lat: number;
  lng: number;
  items: [name: string, description: string, priceKobo: number][];
};

const vendors: VendorSeed[] = [
  { name: "Wuse Grill House", city: "ABUJA", address: "Wuse 2, Abuja", lat: 9.0765, lng: 7.4698,
    items: [["Suya platter", "Beef suya, onions, yaji", 350000], ["Chicken shawarma", "Grilled chicken, slaw, garlic sauce", 450000], ["Smoky jollof and chicken", "Party-style jollof, grilled chicken", 550000], ["Zobo (500ml)", "Chilled hibiscus drink", 80000]] },
  { name: "Maitama Bites", city: "ABUJA", address: "Maitama, Abuja", lat: 9.0830, lng: 7.4930,
    items: [["Peppered snail", "Spiced snail, bell peppers", 600000], ["Grilled tilapia", "Whole tilapia, pepper sauce", 850000], ["Fried plantain", "Ripe plantain, side portion", 150000], ["Chapman", "Classic Nigerian cocktail, non-alcoholic", 120000]] },
  { name: "Garki Mama Put", city: "ABUJA", address: "Garki Area 11, Abuja", lat: 9.0300, lng: 7.4900,
    items: [["Amala and ewedu", "With gbegiri and assorted meat", 300000], ["Pounded yam and egusi", "Egusi soup, assorted meat", 450000], ["Ofada rice", "Ofada sauce, boiled egg", 400000], ["Bottled water", "75cl", 30000]] },
  { name: "Jabi Pizza Co", city: "ABUJA", address: "Jabi Lake Mall area, Abuja", lat: 9.0700, lng: 7.4200,
    items: [["Margherita (medium)", "Tomato, mozzarella, basil", 650000], ["Suya pizza (medium)", "Suya beef, onions, mozzarella", 800000], ["Garlic bread", "Four slices", 200000], ["Soft drink", "50cl", 50000]] },
  { name: "Gwarinpa Noodle Bar", city: "ABUJA", address: "Gwarinpa, Abuja", lat: 9.1100, lng: 7.4000,
    items: [["Chicken stir-fry noodles", "Egg noodles, vegetables, chicken", 420000], ["Prawn fried rice", "Prawns, sweet corn, peppers", 580000], ["Spring rolls (6)", "Vegetable filling", 250000], ["Iced tea", "Lemon, 40cl", 70000]] },
  { name: "Asokoro Bakehouse", city: "ABUJA", address: "Asokoro, Abuja", lat: 9.0400, lng: 7.5300,
    items: [["Meat pie", "Flaky pastry, minced beef", 90000], ["Sausage roll", "Pork-free chicken sausage", 80000], ["Chocolate cake slice", "Rich chocolate sponge", 220000], ["Cappuccino", "Single shot, steamed milk", 180000]] },
  { name: "VI Seafood Deck", city: "LAGOS", address: "Victoria Island, Lagos", lat: 6.4281, lng: 3.4219,
    items: [["Peppered prawns", "Jumbo prawns, pepper sauce", 950000], ["Grilled croaker", "Whole croaker, plantain", 900000], ["Seafood okro", "With eba", 700000], ["Palm wine spritz", "Non-alcoholic mocktail", 150000]] },
  { name: "Ikeja Suya Spot", city: "LAGOS", address: "Ikeja GRA, Lagos", lat: 6.6018, lng: 3.3515,
    items: [["Beef suya (250g)", "Spiced and grilled", 400000], ["Chicken suya (250g)", "Spiced and grilled", 420000], ["Kilishi", "Dried spiced beef strips", 350000], ["Fura da nono", "Millet and milk drink", 120000]] },
  { name: "Lekki Brunch Club", city: "LAGOS", address: "Lekki Phase 1, Lagos", lat: 6.4474, lng: 3.4700,
    items: [["Pancake stack", "Maple syrup, berries", 550000], ["Avocado toast", "Poached egg, chilli flakes", 600000], ["Yam and egg sauce", "Fried yam, tomato egg sauce", 450000], ["Fresh orange juice", "Freshly squeezed, 40cl", 180000]] },
];

const riderSpots: [string, number, number][] = [
  ["Musa Demo-Rider", 9.0765, 7.4698],
  ["Ada Demo-Rider", 9.0830, 7.4930],
  ["Tunde Demo-Rider", 9.0300, 7.4900],
  ["Zainab Demo-Rider", 6.4281, 3.4219],
  ["Chidi Demo-Rider", 6.6018, 3.3515],
];

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data when NODE_ENV=production.");
  }
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "TRUNCATE order_events, dispatch_offers, payments, order_items, orders, riders, items, vendors, users RESTART IDENTITY CASCADE",
    );

    await client.query(
      "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,'ADMIN')",
      ["Demo Admin", "admin@relay.demo", "+2340000000001", hash],
    );
    for (const [i, name] of ["Demo Customer One", "Demo Customer Two", "Demo Customer Three"].entries()) {
      await client.query(
        "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,'CUSTOMER')",
        [name, `customer${i + 1}@relay.demo`, `+234000000010${i + 1}`, hash],
      );
    }
    for (const [i, [name, lat, lng]] of riderSpots.entries()) {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,'RIDER') RETURNING id",
        [name, `rider${i + 1}@relay.demo`, `+234000000020${i + 1}`, hash],
      );
      await client.query(
        "INSERT INTO riders (user_id, is_online, current_lat, current_lng, last_seen_at, vehicle_type) VALUES ($1, false, $2, $3, now(), 'motorbike')",
        [rows[0].id, lat, lng],
      );
    }
    for (const v of vendors) {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO vendors (name, city, address, lat, lng) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [v.name, v.city, v.address, v.lat, v.lng],
      );
      for (const [name, description, price] of v.items) {
        await client.query("INSERT INTO items (vendor_id, name, description, price_kobo) VALUES ($1,$2,$3,$4)", [
          rows[0].id,
          name,
          description,
          price,
        ]);
      }
    }
    await client.query("COMMIT");

    // Proof step: read rows back.
    const first = await client.query(
      "SELECT v.name, v.city, count(i.id)::int AS items FROM vendors v JOIN items i ON i.vendor_id = v.id GROUP BY v.id ORDER BY v.name LIMIT 1",
    );
    console.log("Read-back (sample vendor):", first.rows[0]);
    const counts = await client.query(
      "SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM vendors) AS vendors, (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM riders) AS riders",
    );
    console.log("Totals:", counts.rows[0]);
    console.log(`Demo login password for all seeded users: ${DEMO_PASSWORD}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
