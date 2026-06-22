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
  const role = String(req.body.role || 'donor').trim().toLowerCase();
  const address = String(req.body.address || '').trim() || null;
  const bloodGroup = String(req.body.bloodGroup || '').trim() || null;
  const password = String(req.body.password || '');
  const city = String(req.body.city || '').trim() || null;
  const district = String(req.body.district || '').trim() || null;
  const totalDonations = Number.parseInt(req.body.totalDonations, 10);
  const profileImageName = String(req.body.profileImageName || '').trim() || null;
  const profileImageData = String(req.body.profileImageData || '').trim() || null;
  const orgName = String(req.body.orgName || '').trim() || null;
  const orgDocumentsName = String(req.body.orgDocumentsName || '').trim() || null;
  const orgDocumentsData = String(req.body.orgDocumentsData || '').trim() || null;
  const orgPhotoName = String(req.body.orgPhotoName || '').trim() || null;
  const orgPhotoData = String(req.body.orgPhotoData || '').trim() || null;

  if (!fullName || !email || !password) {
    return res.status(400).json({ message: 'Full name, email, and password are required.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  if (!['donor', 'org'].includes(role)) {
    return res.status(400).json({ message: 'Only donor and organization accounts can be registered here.' });
  }

  try {
    const existingUsers = await query('SELECT user_id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ message: 'Email is already registered.' });
    }

    const passwordHash = createPasswordHash(password);

    if (role === 'donor') {
      if (!profileImageData || !profileImageName) {
        return res.status(400).json({ message: 'Profile picture is required for donor registration.' });
      }

      const insertUser = await query(
        `INSERT INTO users (full_name, email, password_hash, phone, role, address, city, district, profile_image_name, profile_image_data)
         VALUES (?, ?, ?, ?, 'donor', ?, ?, ?, ?, ?)`,
        [fullName, email, passwordHash, phone || null, address, city, district, profileImageName, profileImageData]
      );

      await query(
        `INSERT INTO donor_profiles (user_id, blood_group, is_available, total_donations, profile_picture, profile_picture_name)
         VALUES (?, ?, TRUE, 0, ?, ?)`,
        [insertUser.insertId, bloodGroup, profileImageData, profileImageName]
      );

      if (!Number.isNaN(totalDonations) && totalDonations > 0) {
        await query(
          'UPDATE donor_profiles SET total_donations = ? WHERE user_id = ?',
          [totalDonations, insertUser.insertId]
        );
      }

      return res.status(201).json({
        message: 'Account created successfully.',
        user: {
          userId: insertUser.insertId,
          fullName,
          email,
          phone: phone || null,
          address,
          role: 'donor',
          city,
          district,
          profileImageName,
          profileImageData,
        },
      });
    }

    if (!orgName || !address || !orgDocumentsData || !orgDocumentsName || !orgPhotoData || !orgPhotoName) {
      return res.status(400).json({ message: 'Organization name, address, documents, and photo are required.' });
    }

    const insertUser = await query(
      `INSERT INTO users (full_name, email, password_hash, phone, role, address, city, district)
       VALUES (?, ?, ?, ?, 'org', ?, ?, ?)`,
      [orgName, email, passwordHash, phone || null, address, city, district]
    );

    await query(
      `INSERT INTO organizations (user_id, org_name, org_type, address, contact, verification_documents, verification_documents_name, building_photo, building_photo_name, verified)
       VALUES (?, ?, 'ngo', ?, ?, ?, ?, ?, ?, FALSE)`,
      [insertUser.insertId, orgName, address, phone || null, orgDocumentsData, orgDocumentsName, orgPhotoData, orgPhotoName]
    );

    return res.status(201).json({
      message: 'Verified Successfully.',
      user: {
        userId: insertUser.insertId,
        fullName: orgName,
        email,
        phone: phone || null,
        address,
        role: 'org',
        city,
        district,
        orgName,
        orgDocumentsName,
        orgDocumentsData,
        orgPhotoName,
        orgPhotoData,
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

app.get('/api/me', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ message: 'Email query parameter is required.' });
  }

  try {
    const rows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.address, u.role, u.city, u.district, u.profile_image_name, u.profile_image_data, u.created_at,
              d.donor_id, d.blood_group, d.is_available, d.last_donated_at, d.total_donations, d.profile_picture, d.profile_picture_name,
              o.org_id, o.org_name, o.org_type, o.address AS org_address, o.contact, o.verification_documents_name, o.building_photo_name, o.verified
       FROM users u
       LEFT JOIN donor_profiles d ON d.user_id = u.user_id
       LEFT JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ?
       LIMIT 1`,
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const row = rows[0];
    res.json({
      user: {
        userId: row.user_id,
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        address: row.address,
        role: row.role,
        city: row.city,
        district: row.district,
        profileImageName: row.profile_image_name,
        profileImageData: row.profile_image_data,
        createdAt: row.created_at,
        donorProfile: row.donor_id ? {
          donorId: row.donor_id,
          bloodGroup: row.blood_group,
          isAvailable: Boolean(row.is_available),
          lastDonatedAt: row.last_donated_at,
          totalDonations: row.total_donations,
          profilePicture: row.profile_picture,
          profilePictureName: row.profile_picture_name,
        } : null,
        organization: row.org_id ? {
          orgId: row.org_id,
          orgName: row.org_name,
          orgType: row.org_type,
          address: row.org_address || row.address,
          contact: row.contact,
          verificationDocumentsName: row.verification_documents_name,
          buildingPhotoName: row.building_photo_name,
          verified: Boolean(row.verified),
        } : null,
      },
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.put('/api/me', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const fullName = String(req.body.fullName || '').trim();
  const phone = String(req.body.phone || '').trim() || null;
  const address = String(req.body.address || '').trim() || null;
  const city = String(req.body.city || '').trim() || null;
  const district = String(req.body.district || '').trim() || null;
  const bloodGroup = String(req.body.bloodGroup || '').trim() || null;
  const isAvailable = req.body.isAvailable;
  const profileImageName = String(req.body.profileImageName || '').trim() || null;
  const profileImageData = String(req.body.profileImageData || '').trim() || null;

  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  try {
    const rows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.address, u.role, u.city, u.district, u.profile_image_name, u.profile_image_data,
              d.donor_id, d.blood_group, d.is_available, d.last_donated_at, d.total_donations, d.profile_picture, d.profile_picture_name,
              o.org_id, o.org_name, o.org_type, o.address AS org_address, o.contact, o.verification_documents_name, o.building_photo_name, o.verified
       FROM users u
       LEFT JOIN donor_profiles d ON d.user_id = u.user_id
       LEFT JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ?
       LIMIT 1`,
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const user = rows[0];

    await query(
      'UPDATE users SET full_name = ?, phone = ?, address = ?, city = ?, district = ?, profile_image_name = COALESCE(?, profile_image_name), profile_image_data = COALESCE(?, profile_image_data) WHERE user_id = ?',
      [fullName || user.full_name, phone, address, city, district, profileImageName, profileImageData, user.user_id]
    );

    if (user.donor_id) {
      const availabilityValue = isAvailable === undefined || isAvailable === null
        ? user.is_available
        : Boolean(isAvailable);

      await query(
        'UPDATE donor_profiles SET blood_group = ?, is_available = ?, profile_picture = COALESCE(?, profile_picture), profile_picture_name = COALESCE(?, profile_picture_name) WHERE user_id = ?',
        [bloodGroup || user.blood_group, availabilityValue ? 1 : 0, profileImageData, profileImageName, user.user_id]
      );
    }

    const updatedRows = await query(
            `SELECT u.user_id, u.full_name, u.email, u.phone, u.address, u.role, u.city, u.district, u.profile_image_name, u.profile_image_data, u.created_at,
              d.donor_id, d.blood_group, d.is_available, d.last_donated_at, d.total_donations, d.profile_picture, d.profile_picture_name,
              o.org_id, o.org_name, o.org_type, o.address AS org_address, o.contact, o.verification_documents_name, o.building_photo_name, o.verified
       FROM users u
       LEFT JOIN donor_profiles d ON d.user_id = u.user_id
       LEFT JOIN organizations o ON o.user_id = u.user_id
       WHERE u.user_id = ?
       LIMIT 1`,
      [user.user_id]
    );

    const updated = updatedRows[0];
    res.json({
      message: 'Profile updated successfully.',
      user: {
        userId: updated.user_id,
        fullName: updated.full_name,
        email: updated.email,
        phone: updated.phone,
        address: updated.address,
        role: updated.role,
        city: updated.city,
        district: updated.district,
        profileImageName: updated.profile_image_name,
        profileImageData: updated.profile_image_data,
        createdAt: updated.created_at,
        donorProfile: updated.donor_id ? {
          donorId: updated.donor_id,
          bloodGroup: updated.blood_group,
          isAvailable: Boolean(updated.is_available),
          lastDonatedAt: updated.last_donated_at,
          totalDonations: updated.total_donations,
          profilePicture: updated.profile_picture,
          profilePictureName: updated.profile_picture_name,
        } : null,
        organization: updated.org_id ? {
          orgId: updated.org_id,
          orgName: updated.org_name,
          orgType: updated.org_type,
          address: updated.org_address || updated.address,
          contact: updated.contact,
          verificationDocumentsName: updated.verification_documents_name,
          buildingPhotoName: updated.building_photo_name,
          verified: Boolean(updated.verified),
        } : null,
      },
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'register.html'));
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
