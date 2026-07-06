const { query } = require('../src/db');

async function ensure(email) {
  try {
    const rows = await query(`SELECT u.user_id, u.full_name, u.email, d.donor_id, d.user_id AS dp_user_id FROM users u LEFT JOIN donor_profiles d ON d.user_id = u.user_id WHERE LOWER(u.email) = ? LIMIT 1`, [email.toLowerCase()]);
    if (!rows.length) {
      console.log('No user found for', email);
      return;
    }
    const r = rows[0];
    console.log('User:', { user_id: r.user_id, full_name: r.full_name, email: r.email });
    if (r.dp_user_id) {
      console.log('Donor profile exists (donor_id):', r.donor_id);
      return;
    }

    // create a donor profile for this user
    const created = await query('INSERT INTO donor_profiles (user_id, blood_group, is_available, last_donated_at, total_donations, profile_picture, profile_picture_name) VALUES (?, ?, TRUE, NULL, 0, ?, ?)', [r.user_id, 'A+', 'https://via.placeholder.com/128.png?text=Donor', 'placeholder.png']);
    console.log('Created donor_profile with id', created.insertId);
  } catch (err) {
    console.error('Error:', err.message || err);
  } finally {
    process.exit(0);
  }
}

const email = process.argv[2] || 'rajesh.donor@bloodcare.org.np';
ensure(email);
