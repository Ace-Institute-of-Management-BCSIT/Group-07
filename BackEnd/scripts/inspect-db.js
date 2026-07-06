const { query } = require('../src/db');

async function inspectTable(name, sampleLimit = 5) {
  try {
    const countRes = await query(`SELECT COUNT(*) AS cnt FROM \`${name}\``);
    const count = countRes && countRes[0] ? countRes[0].cnt : 0;
    console.log(`\nTable: ${name} — count: ${count}`);
    const rows = await query(`SELECT * FROM \`${name}\` LIMIT ?`, [sampleLimit]);
    console.log(`Sample rows (${rows.length}):`);
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`Error inspecting table ${name}:`, err.message || err);
  }
}

async function main() {
  const tables = ['users', 'donor_profiles', 'center_listings', 'blood_drive_listings', 'blood_requests', 'donation_history', 'organizations'];
  for (const t of tables) {
    // eslint-disable-next-line no-await-in-loop
    await inspectTable(t, 5);
  }
  process.exit(0);
}

main();
