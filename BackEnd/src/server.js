const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const frontendDir = path.join(__dirname, '..', '..', 'FrontEnd');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(frontendDir));

const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

function sendDbError(res, error) {
  console.error(error);
  return res.status(500).json({ message: 'Database error', error: error.message });
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT bdl.event_id, bdl.title, o.org_name, bdl.event_date, bdl.time_range,
              bdl.location, bdl.distance_km, bdl.spots_available, bdl.spots_total,
              bdl.event_type, bdl.image_url
       FROM blood_drive_listings bdl
       INNER JOIN organization o ON o.org_id = bdl.org_id
       ORDER BY bdl.event_date ASC, bdl.distance_km ASC`
    );

    if (!rows.length) {
      return res.json([
        { id: 1, title: 'Bir Hospital Blood Drive', org: 'Bir Hospital Foundation', date: '2025-09-15', time: '9:00 AM - 5:00 PM', location: 'Bir Hospital', dist: '2.3km away', spots: 45, total: 100, type: 'Drive', img: 'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?w=600&auto=format&fit=crop&q=70' },
        { id: 2, title: 'Community Blood Camp', org: 'Nepal Red Cross Society', date: '2025-09-20', time: '10:00 AM - 4:00 PM', location: 'Patan Durbar Square', dist: '4.1km away', spots: 23, total: 80, type: 'Camp', img: 'https://images.unsplash.com/photo-1579154204601-01588f351e67?w=600&auto=format&fit=crop&q=70' },
        { id: 3, title: 'Emergency Blood Collection', org: 'Emergency Medical Services', date: '2025-09-12', time: '8:00 AM - 8:00 PM', location: 'TU Teaching Hospital', dist: '1.8km away', spots: 12, total: 50, type: 'Emergency', img: 'https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=600&auto=format&fit=crop&q=70' },
        { id: 4, title: 'University Blood Drive', org: 'Student Health Services', date: '2025-09-25', time: '11:00 AM - 6:00 PM', location: 'Tribhuvan University', dist: '6.5km away', spots: 67, total: 120, type: 'Drive', img: 'https://images.unsplash.com/photo-1582719471384-894fbb16e074?w=600&auto=format&fit=crop&q=70' }
      ]);
    }

    res.json(rows.map((row) => ({
      id: row.event_id,
      title: row.title,
      org: `Organized by ${row.org_name}`,
      date: String(row.event_date).slice(0, 10),
      time: row.time_range,
      location: row.location,
      dist: `${Number(row.distance_km).toFixed(1)}km away`,
      spots: row.spots_available,
      total: row.spots_total,
      type: row.event_type,
      img: row.image_url,
    })));
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [donorRows] = await pool.query('SELECT COUNT(*) AS count FROM donor_profile');
    const [centerRows] = await pool.query('SELECT COUNT(*) AS count FROM center_listings');
    const [eventRows] = await pool.query('SELECT COUNT(*) AS count FROM blood_drive_listings');

    res.json({
      donors: donorRows[0].count,
      centers: centerRows[0].count,
      events: eventRows[0].count,
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/centers', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT cl.listing_id, cl.display_name, cl.phone, cl.hours, cl.distance_km,
              cl.availability, cl.services, cl.image_url,
              o.org_name, o.address
       FROM center_listings cl
       INNER JOIN organization o ON o.org_id = cl.org_id
       ORDER BY cl.distance_km ASC, o.org_name ASC`
    );

    if (!rows.length) {
      return res.json([
        { id: 1, name: 'Bir Hospital Blood Center', dist: '2.3 km away', address: 'Tundilkhel Road, Kathmandu', phone: '+977-1-4221119', hours: 'Mon-Fri: 8AM-6PM, Sat: 9AM-3PM', avail: 'High', services: ['Whole Blood', 'Platelets', 'Plasma', 'Power Red'], img: 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?w=400&auto=format&fit=crop&q=70' },
        { id: 2, name: 'Red Cross Blood Bank', dist: '3.1 km away', address: 'Kalimati, Kathmandu', phone: '+977-1-4270650', hours: 'Mon-Sat: 8AM-5PM', avail: 'Medium', services: ['Whole Blood', 'Platelets', 'Plasma'], img: 'https://images.unsplash.com/photo-1579154204601-01588f351e67?w=400&auto=format&fit=crop&q=70' },
        { id: 3, name: 'Tribhuvan University Teaching Hospital', dist: '4.2 km away', address: 'Maharajgunj, Kathmandu', phone: '+977-1-4412303', hours: '24/7 Emergency Services', avail: 'Low', services: ['Whole Blood', 'Emergency Collection'], img: 'https://images.unsplash.com/photo-1586773860418-d37222d8fce3?w=400&auto=format&fit=crop&q=70' },
        { id: 4, name: 'Patan Hospital Blood Bank', dist: '5.8 km away', address: 'Lagankhel, Lalitpur', phone: '+977-1-5522266', hours: 'Mon-Sat: 10AM-5PM', avail: 'High', services: ['Whole Blood', 'Platelets'], img: 'https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=400&auto=format&fit=crop&q=70' },
        { id: 5, name: 'Kathmandu Medical College', dist: '7.1 km away', address: 'Sinamangal, Kathmandu', phone: '+977-1-4469404', hours: 'Mon-Fri: 7AM-8PM, Weekends: 8AM-4PM', avail: 'Medium', services: ['Whole Blood', 'Platelets', 'Plasma', 'Research Participation'], img: 'https://images.unsplash.com/photo-1582719471384-894fbb16e074?w=400&auto=format&fit=crop&q=70' }
      ]);
    }

    res.json(rows.map((row) => ({
      id: row.listing_id,
      name: row.display_name || row.org_name,
      dist: `${Number(row.distance_km).toFixed(1)} km away`,
      address: row.address,
      phone: row.phone,
      hours: row.hours,
      avail: row.availability,
      services: String(row.services || '').split('|').map((service) => service.trim()).filter(Boolean),
      img: row.image_url,
    })));
  } catch (error) {
    sendDbError(res, error);
  }
});

app.post('/api/register', async (req, res) => {
  const { fullName, email, phone, bloodGroup, password } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({ message: 'Full name, email, and password are required.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  if (bloodGroup && !bloodGroups.includes(bloodGroup)) {
    return res.status(400).json({ message: 'Invalid blood group.' });
  }

  try {
    const [existing] = await pool.query('SELECT user_id FROM user WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(409).json({ message: 'Email is already registered.' });
    }

    const passwordHash = password;
    const [userResult] = await pool.query(
      'INSERT INTO user (full_name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, ?)',
      [fullName, email, passwordHash, phone || null, 'donor']
    );

    let donorProfile = null;
    if (bloodGroup) {
      const [donorResult] = await pool.query(
        'INSERT INTO donor_profile (user_id, blood_group) VALUES (?, ?)',
        [userResult.insertId, bloodGroup]
      );
      donorProfile = { donorId: donorResult.insertId, bloodGroup };
    }

    res.status(201).json({
      message: 'Account created successfully.',
      user: {
        userId: userResult.insertId,
        fullName,
        email,
        phone: phone || null,
        role: 'donor',
        donorProfile,
      },
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const [rows] = await pool.query('SELECT user_id, full_name, email, password_hash, role FROM user WHERE email = ?', [email]);
    if (!rows.length || rows[0].password_hash !== password) {
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
    sendDbError(res, error);
  }
});

app.get('/api/me', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ message: 'Email query parameter is required.' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.role, u.city, u.district, u.created_at,
              d.donor_id, d.blood_group, d.is_available, d.last_donated_at, d.total_donations,
              o.org_id, o.org_name, o.org_type, o.address, o.verified
       FROM user u
       LEFT JOIN donor_profile d ON d.user_id = u.user_id
       LEFT JOIN organization o ON o.user_id = u.user_id
       WHERE u.email = ?`,
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json(rows[0]);
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/schema', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'schema.sql'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`SaveABeat server running on http://localhost:${port}`);
});
