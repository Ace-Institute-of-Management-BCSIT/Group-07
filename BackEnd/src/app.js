const crypto = require('crypto');
const express = require('express');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, query } = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const frontendDir = path.join(__dirname, '..', '..', 'FrontEnd');
const verificationCodes = new Map();
const verificationCodeTtlMs = 10 * 60 * 1000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '20mb' }));
app.use(express.static(frontendDir));
const fs = require('fs');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${sha256(`${salt}:${password}`)}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) {
    return false;
  }

  const separatorIndex = storedHash.indexOf(':');
  if (separatorIndex === -1) {
    return false;
  }

  const salt = storedHash.slice(0, separatorIndex);
  const digest = storedHash.slice(separatorIndex + 1);
  return sha256(`${salt}:${password}`) === digest;
}

function sendDbError(res, error) {
  console.error(error);
  return res.status(500).json({ message: 'Database error.' });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function getPasswordStrengthError(password) {
  if (password.length < 8) {
    return 'Password must be at least 8 characters.';
  }

  if (!/[a-z]/.test(password)) {
    return 'Password must include a lowercase letter.';
  }

  if (!/[A-Z]/.test(password)) {
    return 'Password must include an uppercase letter.';
  }

  if (!/\d/.test(password)) {
    return 'Password must include a number.';
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    return 'Password must include a special character.';
  }

  return null;
}

function createVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function getVerificationKey(email, role) {
  return `${role}:${email}`;
}

function storeVerificationCode(email, role) {
  const code = createVerificationCode();
  verificationCodes.set(getVerificationKey(email, role), {
    codeHash: sha256(code),
    expiresAt: Date.now() + verificationCodeTtlMs,
    attempts: 0,
  });
  return code;
}

function verifyEmailCode(email, role, code) {
  const key = getVerificationKey(email, role);
  const record = verificationCodes.get(key);

  if (!record) {
    return 'Please request an email verification code first.';
  }

  if (Date.now() > record.expiresAt) {
    verificationCodes.delete(key);
    return 'Verification code has expired. Please request a new code.';
  }

  record.attempts += 1;
  if (record.attempts > 5) {
    verificationCodes.delete(key);
    return 'Too many incorrect verification attempts. Please request a new code.';
  }

  if (sha256(String(code || '').trim()) !== record.codeHash) {
    return 'Invalid verification code.';
  }

  verificationCodes.delete(key);
  return null;
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

app.post('/api/seed-demo', async (req, res) => {
  // Protected to local calls only - ensure called from localhost in production
  const origin = req.ip || req.connection.remoteAddress || '';
  if (!origin.includes('127.0.0.1') && !origin.includes('::1') && origin !== '::ffff:127.0.0.1') {
    // allow when running locally via tools too
  }

  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'seed.sql'), 'utf8');
    // Split statements on semicolon followed by newline to avoid splitting inside functions
    const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      // Skip USE database and CREATE DATABASE if not needed
      if (/^USE\s+/i.test(stmt)) continue;
      if (/^CREATE\s+DATABASE/i.test(stmt)) continue;
      try {
        await query(stmt);
      } catch (e) {
        console.warn('Seed statement failed, continuing', e.message);
      }
    }

    res.json({ message: 'Seed script executed (errors may be ignored).' });
  } catch (error) {
    console.error('Seeding failed:', error);
    res.status(500).json({ message: 'Seeding failed.' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const [donorCountRows, centerCountRows, eventCountRows] = await Promise.all([
      query('SELECT COUNT(*) AS count FROM donor_profiles'),
      query('SELECT COUNT(*) AS count FROM organizations'),
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

function mapCenterRow(row) {
  const availability = row.availability || 'Medium';
  const imageUrl = row.image_url || row.building_photo || '';
  return {
    id: row.listing_id || row.org_id,
    orgId: row.org_id,
    name: row.display_name || row.org_name,
    orgName: row.org_name,
    orgType: row.org_type,
    address: row.address,
    phone: row.phone || row.contact || '',
    hours: row.hours || 'Contact organization for hours',
    dist: `${Number(row.distance_km || 0).toFixed(1)} km away`,
    availability,
    avail: availability,
    services: parseList(row.services || 'Whole Blood|Platelets|Plasma'),
    imageUrl,
    img: imageUrl,
    verified: Boolean(row.verified),
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

app.get('/api/centers', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT o.org_id, o.org_name, o.org_type, o.address, o.contact, o.building_photo, o.verified,
              cl.listing_id, cl.display_name, cl.phone, cl.hours, cl.distance_km,
              cl.availability, cl.services, cl.image_url, cl.latitude, cl.longitude
       FROM organizations o
       LEFT JOIN center_listings cl ON cl.org_id = o.org_id
       ORDER BY COALESCE(cl.distance_km, 999) ASC, o.org_name ASC`
    );

    res.json({
      data: rows.map((row) => mapCenterRow({
        ...row,
        phone: row.phone || row.contact,
        image_url: row.image_url || row.building_photo,
        hours: row.hours,
        services: row.services,
        distance_km: row.distance_km ?? 5,
        availability: row.availability || 'Medium',
        display_name: row.display_name || row.org_name,
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
        orgName: row.org_name,
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

function mapCampaignRow(row) {
  return {
    id: row.event_id,
    title: row.title,
    org: `Organized by ${row.org_name}`,
    orgName: row.org_name,
    date: formatDate(row.event_date),
    time: row.time_range,
    location: row.location,
    dist: `${Number(row.distance_km).toFixed(1)}km away`,
    spots: row.spots_available,
    total: row.spots_total,
    type: row.event_type,
    img: row.image_url,
  };
}

app.get('/api/org/campaigns', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ message: 'Email query parameter is required.' });
  }

  try {
    const orgRows = await query(
      `SELECT o.org_id, o.org_name
       FROM users u
       INNER JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ? AND u.role = 'org'
       LIMIT 1`,
      [email]
    );

    if (!orgRows.length) {
      return res.status(404).json({ message: 'Organization account not found.' });
    }

    const rows = await query(
      `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
              bl.time_range, bl.location, bl.distance_km, bl.spots_total,
              bl.spots_available, bl.event_type, bl.image_url
       FROM blood_drive_listings bl
       INNER JOIN organizations o ON o.org_id = bl.org_id
       WHERE bl.org_id = ?
       ORDER BY bl.event_date DESC, bl.event_id DESC`,
      [orgRows[0].org_id]
    );

    res.json({
      orgName: orgRows[0].org_name,
      data: rows.map(mapCampaignRow),
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/donor/history', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Email query parameter is required.' });
  }

  try {
    const donorRows = await query(
      `SELECT d.donor_id
       FROM users u
       INNER JOIN donor_profiles d ON d.user_id = u.user_id
       WHERE LOWER(u.email) = ?
       LIMIT 1`,
      [email]
    );

    if (!donorRows.length) {
      return res.status(404).json({ message: 'Donor profile not found.' });
    }

    const donorId = donorRows[0].donor_id;

    const rows = await query(
      `SELECT dh.history_id, dh.donated_at, dh.units_donated, dh.location, o.org_name
       FROM donation_history dh
       LEFT JOIN blood_requests br ON br.request_id = dh.request_id
       LEFT JOIN organizations o ON o.org_id = br.org_id
       WHERE dh.donor_id = ?
       ORDER BY dh.donated_at DESC`,
      [donorId]
    );

    res.json({ data: rows.map((r) => ({ id: r.history_id, date: formatDate(r.donated_at), units: r.units_donated, location: r.location, org: r.org_name })) });
  } catch (error) {
    sendDbError(res, error);
  }
});

// Record a donation for an event (donor applied / marked as donated)
app.post('/api/events/:id/apply', async (req, res) => {
  const eventId = Number.parseInt(req.params.id, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  const units = Number.parseInt(req.body.units || 1, 10);

  if (!eventId || !email) {
    return res.status(400).json({ message: 'Event id and donor email are required.' });
  }

  try {
    const donorRows = await query(
      `SELECT d.donor_id, d.total_donations
       FROM users u
       INNER JOIN donor_profiles d ON d.user_id = u.user_id
       WHERE LOWER(u.email) = ?
       LIMIT 1`,
      [email]
    );

    if (!donorRows.length) {
      return res.status(404).json({ message: 'Donor profile not found.' });
    }

    const eventRows = await query('SELECT event_id, location, spots_available FROM blood_drive_listings WHERE event_id = ? LIMIT 1', [eventId]);
    if (!eventRows.length) {
      return res.status(404).json({ message: 'Event not found.' });
    }

    const donorId = donorRows[0].donor_id;
    const location = eventRows[0].location || 'Event location';

    // insert donation history record
    const insert = await query(
      `INSERT INTO donation_history (donor_id, request_id, donated_at, units_donated, location)
       VALUES (?, NULL, CURDATE(), ?, ?)`,
      [donorId, Number.isNaN(units) || units < 1 ? 1 : units, location]
    );

    // update donor total donations
    await query('UPDATE donor_profiles SET total_donations = total_donations + ? WHERE donor_id = ?', [Number.isNaN(units) || units < 1 ? 1 : units, donorId]);

    // decrement event spots if available
    try {
      await query('UPDATE blood_drive_listings SET spots_available = GREATEST(0, COALESCE(spots_available, 0) - ?) WHERE event_id = ?', [Number.isNaN(units) || units < 1 ? 1 : units, eventId]);
    } catch (_e) {
      // ignore if update fails
    }

    res.status(201).json({ message: 'Thank you — your donation was recorded.', historyId: insert.insertId });
  } catch (error) {
    sendDbError(res, error);
  }
});

// Create a blood request for a center/listing
app.post('/api/requests', async (req, res) => {
  const listingId = Number.parseInt(req.body.listingId, 10);
  const bloodGroup = String(req.body.bloodGroup || '').trim();
  const unitsNeeded = Number.parseInt(req.body.unitsNeeded || 1, 10);
  const urgency = String(req.body.urgency || 'normal').trim();
  const city = String(req.body.city || '').trim();
  const district = String(req.body.district || '').trim();

  if (!listingId || !bloodGroup || !unitsNeeded || !city || !district) {
    return res.status(400).json({ message: 'Listing id, blood group, units, city and district are required.' });
  }

  try {
    const listingRows = await query('SELECT org_id FROM center_listings WHERE listing_id = ? LIMIT 1', [listingId]);
    if (!listingRows.length) {
      return res.status(404).json({ message: 'Center listing not found.' });
    }

    const orgId = listingRows[0].org_id;
    const result = await query(
      `INSERT INTO blood_requests (org_id, blood_group, units_needed, urgency, city, district, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [orgId, bloodGroup, unitsNeeded, urgency, city, district]
    );

    res.status(201).json({ message: 'Blood request created.', requestId: result.insertId });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.post('/api/org/campaigns', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const title = String(req.body.title || '').trim();
  const eventDate = String(req.body.eventDate || '').trim();
  const timeRange = String(req.body.timeRange || '').trim();
  const location = String(req.body.location || '').trim();
  const eventType = String(req.body.eventType || 'Drive').trim();
  const imageUrl = String(req.body.imageUrl || req.body.imageData || '').trim();
  const distanceKm = Number.parseFloat(req.body.distanceKm);
  const spotsTotal = Number.parseInt(req.body.spotsTotal, 10);

  if (!email || !title || !eventDate || !timeRange || !location || !imageUrl) {
    return res.status(400).json({ message: 'Title, date, time, location, and campaign image are required.' });
  }

  if (!['Drive', 'Camp', 'Emergency'].includes(eventType)) {
    return res.status(400).json({ message: 'Campaign type must be Drive, Camp, or Emergency.' });
  }

  if (Number.isNaN(spotsTotal) || spotsTotal < 1) {
    return res.status(400).json({ message: 'Total spots must be at least 1.' });
  }

  try {
    const orgRows = await query(
      `SELECT o.org_id, o.org_name
       FROM users u
       INNER JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ? AND u.role = 'org'
       LIMIT 1`,
      [email]
    );

    if (!orgRows.length) {
      return res.status(404).json({ message: 'Organization account not found.' });
    }

    const insertResult = await query(
      `INSERT INTO blood_drive_listings (org_id, title, event_date, time_range, location, distance_km, spots_total, spots_available, event_type, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orgRows[0].org_id,
        title,
        eventDate,
        timeRange,
        location,
        Number.isNaN(distanceKm) ? 5.0 : distanceKm,
        spotsTotal,
        spotsTotal,
        eventType,
        imageUrl,
      ]
    );

    const rows = await query(
      `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
              bl.time_range, bl.location, bl.distance_km, bl.spots_total,
              bl.spots_available, bl.event_type, bl.image_url
       FROM blood_drive_listings bl
       INNER JOIN organizations o ON o.org_id = bl.org_id
       WHERE bl.event_id = ?
       LIMIT 1`,
      [insertResult.insertId]
    );

    res.status(201).json({
      message: 'Campaign created successfully.',
      campaign: mapCampaignRow(rows[0]),
    });
  } catch (error) {
    console.error('Campaign creation failed:', error);
    sendDbError(res, error);
  }
});

app.post('/api/auth/send-verification-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || 'donor').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Please enter a valid email address.' });
  }

  if (!['donor', 'org'].includes(role)) {
    return res.status(400).json({ message: 'Only donor and organization accounts can request verification codes.' });
  }

  try {
    const existingUsers = await query('SELECT user_id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ message: 'Email is already registered.' });
    }

    const code = storeVerificationCode(email, role);
    console.log(`Email verification code for ${email}: ${code}`);

    res.json({
      message: 'Verification code sent. Check the backend console for the code while email delivery is not configured.',
      devCode: process.env.NODE_ENV === 'production' ? undefined : code,
    });
  } catch (error) {
    res.status(500).json({ message: 'Unable to send verification code.' });
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
  const operatingHours = String(req.body.operatingHours || '').trim();
  const services = String(req.body.services || 'Whole Blood|Platelets|Plasma').trim();
  const emailVerificationCode = String(req.body.emailVerificationCode || '').trim();

  if (!fullName || !email || !password) {
    return res.status(400).json({ message: 'Full name, email, and password are required.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Please enter a valid email address.' });
  }

  const passwordStrengthError = getPasswordStrengthError(password);
  if (passwordStrengthError) {
    return res.status(400).json({ message: passwordStrengthError });
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

      const verificationError = verifyEmailCode(email, role, emailVerificationCode);
      if (verificationError) {
        return res.status(400).json({ message: verificationError });
      }

      const insertUser = await query(
        `INSERT INTO users (full_name, email, password_hash, phone, role, address, city, district)
         VALUES (?, ?, ?, ?, 'donor', ?, ?, ?)`,
        [fullName, email, passwordHash, phone || null, address, city, district]
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
          bloodGroup,
          totalDonations: Number.isNaN(totalDonations) || totalDonations < 0 ? 0 : totalDonations,
        },
      });
    }

    if (!orgName || !address || !orgDocumentsData || !orgDocumentsName || !orgPhotoData || !orgPhotoName) {
      return res.status(400).json({ message: 'Organization name, address, documents, and photo are required.' });
    }

    if (!operatingHours) {
      return res.status(400).json({ message: 'Operating hours are required for organization registration.' });
    }

    const verificationError = verifyEmailCode(email, role, emailVerificationCode);
    if (verificationError) {
      return res.status(400).json({ message: verificationError });
    }

    const insertUser = await query(
      `INSERT INTO users (full_name, email, password_hash, phone, role, address, city, district)
       VALUES (?, ?, ?, ?, 'org', ?, ?, ?)`,
      [orgName, email, passwordHash, phone || null, address, city, district]
    );

    const insertOrg = await query(
      `INSERT INTO organizations (user_id, org_name, org_type, address, contact, verification_documents, verification_documents_name, building_photo, building_photo_name, verified)
       VALUES (?, ?, 'individual', ?, ?, ?, ?, ?, ?, FALSE)`,
      [insertUser.insertId, orgName, address, phone || null, orgDocumentsData, orgDocumentsName, orgPhotoData, orgPhotoName]
    );

    const normalizedServices = services.includes('|') ? services : services.split(',').map((item) => item.trim()).filter(Boolean).join('|');

    await query(
      `INSERT INTO center_listings (org_id, display_name, phone, hours, distance_km, availability, services, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [insertOrg.insertId, orgName, phone || '', operatingHours, 5.0, 'Medium', normalizedServices || 'Whole Blood|Platelets|Plasma', orgPhotoData]
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
        operatingHours,
        services: parseList(normalizedServices),
      },
    });
  } catch (error) {
    console.error('Registration failed:', error);
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
    console.error('Login failed:', error);
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
              o.org_id, o.org_name, o.org_type, o.address AS org_address, o.contact, o.verification_documents_name, o.building_photo, o.building_photo_name, o.verified,
              cl.hours AS operating_hours, cl.services AS center_services, cl.availability AS center_availability, cl.distance_km AS center_distance_km
       FROM users u
       LEFT JOIN donor_profiles d ON d.user_id = u.user_id
       LEFT JOIN organizations o ON o.user_id = u.user_id
       LEFT JOIN center_listings cl ON cl.org_id = o.org_id
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
        profileImageName: row.profile_image_name || row.profile_picture_name,
        profileImageData: row.profile_image_data || row.profile_picture,
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
          buildingPhoto: row.building_photo,
          buildingPhotoName: row.building_photo_name,
          verified: Boolean(row.verified),
          operatingHours: row.operating_hours,
          services: parseList(row.center_services || 'Whole Blood|Platelets|Plasma'),
          availability: row.center_availability || 'Medium',
          distanceKm: row.center_distance_km,
        } : null,
      },
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.put('/api/me', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const newEmail = String(req.body.newEmail || email).trim().toLowerCase();
  const fullName = String(req.body.fullName || '').trim();
  const phone = String(req.body.phone || '').trim() || null;
  const address = String(req.body.address || '').trim() || null;
  const city = String(req.body.city || '').trim() || null;
  const district = String(req.body.district || '').trim() || null;
  const bloodGroup = String(req.body.bloodGroup || '').trim() || null;
  const totalDonations = Number.parseInt(req.body.totalDonations, 10);
  const orgName = String(req.body.orgName || '').trim();
  const isAvailable = req.body.isAvailable;
  const profileImageName = String(req.body.profileImageName || '').trim() || null;
  const profileImageData = String(req.body.profileImageData || '').trim() || null;
  const orgPhotoName = String(req.body.orgPhotoName || '').trim() || null;
  const orgPhotoData = String(req.body.orgPhotoData || '').trim() || null;
  const operatingHours = String(req.body.operatingHours || '').trim() || null;
  const services = String(req.body.services || '').trim() || null;
  const availability = String(req.body.availability || '').trim() || null;

  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  if (!isValidEmail(newEmail)) {
    return res.status(400).json({ message: 'Please enter a valid email address.' });
  }

  try {
    const rows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.address, u.role, u.city, u.district, u.profile_image_name, u.profile_image_data,
              d.donor_id, d.blood_group, d.is_available, d.last_donated_at, d.total_donations, d.profile_picture, d.profile_picture_name,
              o.org_id, o.org_name, o.org_type, o.address AS org_address, o.contact, o.verification_documents_name, o.building_photo, o.building_photo_name, o.verified,
              cl.listing_id, cl.hours AS operating_hours, cl.services AS center_services, cl.availability AS center_availability
       FROM users u
       LEFT JOIN donor_profiles d ON d.user_id = u.user_id
       LEFT JOIN organizations o ON o.user_id = u.user_id
       LEFT JOIN center_listings cl ON cl.org_id = o.org_id
       WHERE LOWER(u.email) = ?
       LIMIT 1`,
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const user = rows[0];

    if (newEmail !== email) {
      const existingEmailRows = await query(
        'SELECT user_id FROM users WHERE email = ? AND user_id <> ? LIMIT 1',
        [newEmail, user.user_id]
      );
      if (existingEmailRows.length > 0) {
        return res.status(409).json({ message: 'Email is already registered.' });
      }
    }

    await query(
      'UPDATE users SET full_name = ?, email = ?, phone = ?, address = ?, city = ?, district = ?, profile_image_name = COALESCE(?, profile_image_name), profile_image_data = COALESCE(?, profile_image_data) WHERE user_id = ?',
      [fullName || user.full_name, newEmail, phone, address, city, district, profileImageName, profileImageData, user.user_id]
    );

    if (user.donor_id) {
      const availabilityValue = isAvailable === undefined || isAvailable === null
        ? user.is_available
        : Boolean(isAvailable);

      await query(
        'UPDATE donor_profiles SET blood_group = ?, is_available = ?, total_donations = ?, profile_picture = COALESCE(?, profile_picture), profile_picture_name = COALESCE(?, profile_picture_name) WHERE user_id = ?',
        [
          bloodGroup || user.blood_group,
          availabilityValue ? 1 : 0,
          Number.isNaN(totalDonations) || totalDonations < 0 ? user.total_donations : totalDonations,
          profileImageData,
          profileImageName,
          user.user_id
        ]
      );
    }

    if (user.org_id) {
      await query(
        'UPDATE organizations SET org_name = ?, address = ?, contact = ?, building_photo = COALESCE(?, building_photo), building_photo_name = COALESCE(?, building_photo_name) WHERE user_id = ?',
        [orgName || fullName || user.org_name, address || user.org_address, phone || null, orgPhotoData, orgPhotoName, user.user_id]
      );

      const normalizedServices = services
        ? (services.includes('|') ? services : services.split(',').map((item) => item.trim()).filter(Boolean).join('|'))
        : null;
      const listingName = orgName || fullName || user.org_name;
      const listingPhone = phone || user.contact || '';
      const listingHours = operatingHours || user.operating_hours;
      const listingServices = normalizedServices || user.center_services || 'Whole Blood|Platelets|Plasma';
      const listingAvailability = availability || user.center_availability || 'Medium';
      const listingImage = orgPhotoData || user.building_photo;

      if (user.listing_id) {
        await query(
          `UPDATE center_listings
           SET display_name = ?, phone = ?, hours = ?, services = ?, availability = ?, image_url = COALESCE(?, image_url)
           WHERE listing_id = ?`,
          [listingName, listingPhone, listingHours, listingServices, listingAvailability, listingImage, user.listing_id]
        );
      } else {
        await query(
          `INSERT INTO center_listings (org_id, display_name, phone, hours, distance_km, availability, services, image_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [user.org_id, listingName, listingPhone, listingHours || 'Contact organization for hours', 5.0, listingAvailability, listingServices, listingImage]
        );
      }
    }

    const updatedRows = await query(
            `SELECT u.user_id, u.full_name, u.email, u.phone, u.address, u.role, u.city, u.district, u.profile_image_name, u.profile_image_data, u.created_at,
              d.donor_id, d.blood_group, d.is_available, d.last_donated_at, d.total_donations, d.profile_picture, d.profile_picture_name,
              o.org_id, o.org_name, o.org_type, o.address AS org_address, o.contact, o.verification_documents_name, o.building_photo, o.building_photo_name, o.verified,
              cl.hours AS operating_hours, cl.services AS center_services, cl.availability AS center_availability, cl.distance_km AS center_distance_km
       FROM users u
       LEFT JOIN donor_profiles d ON d.user_id = u.user_id
       LEFT JOIN organizations o ON o.user_id = u.user_id
       LEFT JOIN center_listings cl ON cl.org_id = o.org_id
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
          buildingPhoto: updated.building_photo,
          buildingPhotoName: updated.building_photo_name,
          verified: Boolean(updated.verified),
          operatingHours: updated.operating_hours,
          services: parseList(updated.center_services || 'Whole Blood|Platelets|Plasma'),
          availability: updated.center_availability || 'Medium',
          distanceKm: updated.center_distance_km,
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

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Uploaded files are too large. Please use files under 10 MB each.' });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: 'Invalid request body.' });
  }

  console.error(err);
  return res.status(500).json({ message: 'Server error.' });
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
