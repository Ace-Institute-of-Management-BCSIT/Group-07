const crypto = require('crypto');
const express = require('express');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, query } = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const frontendDir = path.join(__dirname, '..', '..', 'FrontEnd');

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(frontendDir));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${sha256(`${salt}:${password}`)}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) {
    return false;
  }

  const [salt, digest] = storedHash.split(':');
  return sha256(`${salt}:${password}`) === digest;
}

function formatDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function parseList(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Database connection failed.' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const [donorCountRows, centerCountRows, eventCountRows] = await Promise.all([
      query('SELECT COUNT(*) AS count FROM donor_profiles'),
      query('SELECT COUNT(*) AS count FROM center_listings'),
      query('SELECT COUNT(*) AS count FROM blood_drive_listings'),
    ]);

    res.json({
      donors: donorCountRows[0].count,
      centers: centerCountRows[0].count,
      events: eventCountRows[0].count,
    });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load stats.' });
  }
});

app.get('/api/centers', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT cl.listing_id, cl.org_id, o.org_name, o.org_type, o.address,
              cl.display_name, cl.phone, cl.hours, cl.distance_km,
              cl.availability, cl.services, cl.image_url, cl.latitude, cl.longitude,
              o.verified
       FROM center_listings cl
       INNER JOIN organizations o ON o.org_id = cl.org_id
       ORDER BY cl.distance_km ASC, o.org_name ASC`
    );

    res.json({
      data: rows.map((row) => ({
        id: row.listing_id,
        name: row.display_name || row.org_name,
        orgName: row.org_name,
        orgType: row.org_type,
        address: row.address,
        phone: row.phone,
        hours: row.hours,
        dist: `${Number(row.distance_km).toFixed(1)} km away`,
        availability: row.availability,
        avail: row.availability,
        services: parseList(row.services),
        imageUrl: row.image_url,
        img: row.image_url,
        verified: Boolean(row.verified),
        latitude: row.latitude,
        longitude: row.longitude,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load centers.' });
  }
});

app.get('/api/events', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
              bl.time_range, bl.location, bl.distance_km, bl.spots_total,
              bl.spots_available, bl.event_type, bl.image_url
       FROM blood_drive_listings bl
       INNER JOIN organizations o ON o.org_id = bl.org_id
       ORDER BY bl.event_date ASC, bl.distance_km ASC`
    );

    res.json({
      data: rows.map((row) => ({
        id: row.event_id,
        title: row.title,
        org: `Organized by ${row.org_name}`,
        date: formatDate(row.event_date),
        time: row.time_range,
        location: row.location,
        dist: `${Number(row.distance_km).toFixed(1)}km away`,
        spots: row.spots_available,
        total: row.spots_total,
        type: row.event_type,
        img: row.image_url,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load events.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const fullName = String(req.body.fullName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const bloodGroup = String(req.body.bloodGroup || '').trim() || null;
  const password = String(req.body.password || '');
  const city = String(req.body.city || '').trim() || null;
  const district = String(req.body.district || '').trim() || null;

  if (!fullName || !email || !password) {
    return res.status(400).json({ message: 'Full name, email, and password are required.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  try {
    const existingUsers = await query('SELECT user_id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ message: 'Email is already registered.' });
    }

    const passwordHash = createPasswordHash(password);
    const insertUser = await query(
      `INSERT INTO users (full_name, email, password_hash, phone, role, city, district)
       VALUES (?, ?, ?, ?, 'donor', ?, ?)`,
      [fullName, email, passwordHash, phone || null, city, district]
    );

    await query(
      `INSERT INTO donor_profiles (user_id, blood_group, is_available, total_donations)
       VALUES (?, ?, TRUE, 0)`,
      [insertUser.insertId, bloodGroup]
    );

    res.status(201).json({
      message: 'Account created successfully.',
      user: {
        userId: insertUser.insertId,
        fullName,
        email,
        role: 'donor',
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Unable to create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const rows = await query(
      'SELECT user_id, full_name, email, password_hash, role FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    res.json({
      message: 'Login successful.',
      user: {
        userId: rows[0].user_id,
        fullName: rows[0].full_name,
        email: rows[0].email,
        role: rows[0].role,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Unable to log in.' });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use((req, res) => {
  if (req.originalUrl.startsWith('/api/')) {
    res.status(404).json({ message: 'API route not found.' });
    return;
  }

  res.status(404).send('Not found');
});

async function start() {
  try {
    await pool.query('SELECT 1');
    app.listen(port, () => {
      console.log(`SaveABeat backend running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to connect to MySQL. Check BackEnd/.env and schema setup.');
    process.exitCode = 1;
  }
}

start();
