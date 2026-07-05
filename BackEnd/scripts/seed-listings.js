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
      console.log('No organizations found to seed listings for.');
      return;
    }

    for (const [i, org] of orgs.entries()) {
      // Upsert center_listings (org_id unique)
      const display = `${org.org_name} Center`;
      const services = 'Blood collection, Donation counseling, Screening';
      const image = 'https://via.placeholder.com/400x200.png?text=Center+Photo';

      await query(`INSERT INTO center_listings (org_id, display_name, phone, hours, distance_km, availability, services, image_url, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), phone=VALUES(phone), hours=VALUES(hours), availability=VALUES(availability), services=VALUES(services), image_url=VALUES(image_url)`,
        [org.org_id, display, '+977-1-4000000', '09:00 - 17:00', 1.2 + i, 'High', services, image, 27.700000 + (i * 0.01), 85.333333 + (i * 0.01)]);

      // Insert one or two upcoming drives if not already present
      const titles = [`${org.org_name} Community Drive`, `${org.org_name} Emergency Camp`];
      for (let j = 0; j < titles.length; j++) {
        const title = titles[j];
        const exists = await query('SELECT COUNT(*) AS cnt FROM blood_drive_listings WHERE org_id = ? AND title = ?', [org.org_id, title]);
        const cnt = exists && exists[0] ? exists[0].cnt : 0;
        if (cnt === 0) {
          const eventDate = addDays(7 + i * 3 + j * 5);
          await query(`INSERT INTO blood_drive_listings (org_id, title, event_date, time_range, location, distance_km, spots_total, spots_available, event_type, image_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [org.org_id, title, eventDate, '10:00 - 15:00', 'Main Hall, ' + org.org_name, 2.5 + i, 100, 100, j === 0 ? 'Drive' : 'Camp', 'https://via.placeholder.com/600x300.png?text=Drive']);
        }
      }
    }

    await conn.commit();
    console.log('Seeded center_listings and blood_drive_listings.');
  } catch (err) {
    await conn.rollback();
    console.error('Seeding listings failed:', err.message || err);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seed();
