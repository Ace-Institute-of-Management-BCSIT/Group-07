const { pool, query } = require('../src/db');

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const orgs = await query('SELECT org_id, org_name FROM organizations LIMIT 4');
    if (!orgs || orgs.length === 0) {
      console.log('No organizations found to seed requests for.');
      return;
    }

    const requests = [
      { blood_group: 'A+', units: 5, urgency: 'urgent', city: 'Kathmandu', district: 'Kathmandu' },
      { blood_group: 'O-', units: 2, urgency: 'critical', city: 'Kathmandu', district: 'Kathmandu' },
      { blood_group: 'B+', units: 3, urgency: 'normal', city: 'Lalitpur', district: 'Lalitpur' },
    ];

    for (const [i, org] of orgs.entries()) {
      for (const [j, r] of requests.entries()) {
        // vary slightly per org
        const units = r.units + i;
        const urgency = r.urgency;
        const expires = addDays(7 + i + j);
        await query('INSERT INTO blood_requests (org_id, blood_group, units_needed, urgency, city, district, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [org.org_id, r.blood_group, units, urgency, r.city, r.district, expires]);
      }
    }

    await conn.commit();
    console.log('Seeded blood_requests for organizations.');
  } catch (err) {
    await conn.rollback();
    console.error('Seeding blood_requests failed:', err.message || err);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seed();
