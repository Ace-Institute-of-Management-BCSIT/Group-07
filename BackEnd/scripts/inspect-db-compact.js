const { query } = require('../src/db');

async function run() {
  try {
    const tables = [
      { name: 'users', sample: 'SELECT user_id, full_name, email, role, city FROM `users` LIMIT 5' },
      { name: 'donor_profiles', sample: 'SELECT donor_id, user_id, blood_group, is_available, total_donations, last_donated_at FROM `donor_profiles` LIMIT 5' },
      { name: 'center_listings', sample: 'SELECT listing_id, org_id, display_name, phone, availability FROM `center_listings` LIMIT 5' },
      { name: 'blood_drive_listings', sample: 'SELECT event_id, org_id, title, event_date, spots_available FROM `blood_drive_listings` LIMIT 5' },
      { name: 'donation_history', sample: 'SELECT history_id, donor_id, donated_at, units_donated, location FROM `donation_history` LIMIT 5' },
      { name: 'organizations', sample: 'SELECT org_id, user_id, org_name, org_type, verified FROM `organizations` LIMIT 5' },
      { name: 'blood_requests', sample: 'SELECT request_id, org_id, blood_group, units_needed, status FROM `blood_requests` LIMIT 5' },
    ];

    for (const t of tables) {
      const cntRes = await query(`SELECT COUNT(*) AS cnt FROM \`${t.name}\``);
      const cnt = (cntRes && cntRes[0] && cntRes[0].cnt) || 0;
      console.log(`\n== ${t.name} (count=${cnt}) ==`);
      const rows = await query(t.sample);
      console.log(rows.length ? JSON.stringify(rows, null, 2) : '(no sample rows)');
    }
  } catch (err) {
    console.error('Inspect failed:', err.message || err);
  } finally {
    process.exit(0);
  }
}

run();
