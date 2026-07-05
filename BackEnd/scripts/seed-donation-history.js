const { pool, query } = require('../src/db');

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const donors = await query('SELECT donor_id FROM donor_profiles LIMIT 5');
    if (!donors || donors.length === 0) {
      console.log('No donor_profiles found to seed.');
      return;
    }

    for (const donor of donors) {
      // insert two history records per donor
      const entries = [
        { date: addDays(-30), units: 1, loc: 'Center Donation' },
        { date: addDays(-120), units: 1, loc: 'Community Drive' },
      ];

      for (const e of entries) {
        await query('INSERT INTO donation_history (donor_id, request_id, donated_at, units_donated, location) VALUES (?, NULL, ?, ?, ?)',
          [donor.donor_id, e.date, e.units, e.loc]);
      }

      // update donor profile totals and last donated
      await query('UPDATE donor_profiles SET total_donations = total_donations + ?, last_donated_at = ? WHERE donor_id = ?', [entries.length, entries[0].date, donor.donor_id]);
    }

    await conn.commit();
    console.log('Seeded donation_history for donors.');
  } catch (err) {
    await conn.rollback();
    console.error('Seeding donation_history failed:', err.message || err);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seed();
