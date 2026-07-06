const crypto = require('crypto');
const { query } = require('../src/db');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${sha256(`${salt}:${password}`)}`;
}

async function main() {
  const users = [
    { email: 'bir.admin@bloodcare.org.np', password: 'Password@123' },
    { email: 'rajesh.donor@bloodcare.org.np', password: 'Password@123' },
  ];

  try {
    for (const u of users) {
      const hash = createPasswordHash(u.password);
      await query('UPDATE users SET password_hash = ? WHERE LOWER(email) = ?', [hash, u.email.toLowerCase()]);
      console.log('Updated password for', u.email);
    }
  } catch (err) {
    console.error('Update failed:', err.message || err);
  } finally {
    process.exit(0);
  }
}

main();
