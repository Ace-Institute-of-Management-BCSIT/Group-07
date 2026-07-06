const { query } = require('../src/db');

async function main() {
  const email = process.argv[2] || 'bir.admin@bloodcare.org.np';
  try {
    const rows = await query('SELECT user_id, full_name, email, password_hash FROM users WHERE LOWER(email) = ? LIMIT 1', [email.toLowerCase()]);
    if (!rows.length) {
      console.log('User not found for', email);
      process.exit(0);
    }
    console.log(rows[0]);
  } catch (err) {
    console.error('Query failed:', err.message || err);
  } finally {
    process.exit(0);
  }
}

main();
