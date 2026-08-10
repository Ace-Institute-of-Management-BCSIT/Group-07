const crypto = require('crypto');
const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');


require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const jwtSecret = process.env.JWT_SECRET || 'saveabeat_secret_key';

function createJwtToken(payload) {
  return jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
}

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
  console.error('Database Error:', error);
  const errMsg = (error && error.message) ? error.message : 'Database error.';
  return res.status(500).json({ message: `Database error: ${errMsg}` });
}

async function ensureDatabaseColumns() {
  try {
    await query(`ALTER TABLE blood_drive_listings MODIFY COLUMN image_url LONGTEXT NOT NULL`);
  } catch (e) {}
  try {
    await query(`ALTER TABLE blood_drive_listings MODIFY COLUMN distance_km DECIMAL(4,1) NULL DEFAULT 0.0`);
    await query(`ALTER TABLE blood_drive_listings MODIFY COLUMN spots_total INT NULL DEFAULT 0`);
    await query(`ALTER TABLE blood_drive_listings MODIFY COLUMN spots_available INT NULL DEFAULT 0`);
  } catch (e) {}
  try {
    await query(`ALTER TABLE blood_requests MODIFY COLUMN required_by DATETIME NULL`);
  } catch (e) {}
  try {
    await query(`ALTER TABLE notifications MODIFY COLUMN event_id INT NULL`);
  } catch (e) {}
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS campaign_blood_requirements (
        requirement_id INT AUTO_INCREMENT PRIMARY KEY,
        event_id INT NOT NULL,
        blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') NOT NULL,
        units_required INT NOT NULL DEFAULT 1,
        CONSTRAINT fk_req_event FOREIGN KEY (event_id) REFERENCES blood_drive_listings(event_id) ON DELETE CASCADE,
        UNIQUE KEY unique_event_blood (event_id, blood_group)
      ) ENGINE=InnoDB
    `);
  } catch (e) {}
}
ensureDatabaseColumns().catch(err => console.warn('Schema check warning:', err.message));



function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

async function domainHasMailServer(email) {
  return true;
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

function createMailTransport() {
  const host = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null;
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !smtpPort || !user || !pass) {
    console.warn('SMTP not fully configured — check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port: smtpPort,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }, 
  });
}
async function sendVerificationEmail(email, role, code) {
  const transport = createMailTransport();
  const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@saveabeat.local';
  const subject = 'SaveABeat Email Verification';
  const roleLabel = role === 'org' ? 'organization' : 'donor';
  const text = `Your SaveABeat ${roleLabel} verification code is ${code}. It expires in 10 minutes.`;
  const html = `<p>Your SaveABeat ${roleLabel} verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`;

  if (!transport) {
    console.warn('SMTP not configured. Logging verification code instead.');
    console.log(`Email verification code for ${email}: ${code}`);
    return;
  }

  await transport.sendMail({
    from: emailFrom,
    to: email,
    subject,
    text,
    html,
  });
}

function normalizeDonorVerificationStatus(status) {
  const normalized = String(status || 'Pending').trim().toLowerCase();
  if (normalized === 'verified' || normalized === 'approved') {
    return 'Verified';
  }
  if (normalized === 'rejected') {
    return 'Rejected';
  }
  return 'Pending';
}

function mapDonorRecord(row, { detail = false } = {}) {
  if (!row) {
    return null;
  }

  const verificationStatus = normalizeDonorVerificationStatus(row.verification_status);
  const donor = {
    user_id: row.user_id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    district: row.district,
    bloodGroup: row.blood_group,
    profile_picture: row.profile_picture,
    created_at: row.created_at,
    verification_status: verificationStatus,
  };

  if (detail) {
    donor.address = row.address;
    donor.profile_image_name = row.profile_image_name;
    donor.profile_image_data = row.profile_image_data;
    donor.profile_picture_name = row.profile_picture_name;
    donor.is_available = row.is_available === 1 || row.is_available === true;
    donor.last_donated_at = row.last_donated_at;
    donor.total_donations = row.total_donations;
    donor.blood_verification_document_type = row.blood_verification_document_type;
    donor.blood_verification_document_file = row.blood_verification_document_file;
    donor.blood_verification_document_name = row.blood_verification_document_name;
  }

  return donor;
}

async function sendDonorVerificationEmail(email, fullName, loginUrl) {
  const transport = createMailTransport();
  const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@saveabeat.local';
  const donorName = fullName || 'there';
  const safeLoginUrl = loginUrl || 'login.html?role=donor';
  const subject = 'Your Donor Account Has Been Verified';
  const text = [
    `Hello ${donorName},`,
    '',
    'Your donor account has been successfully verified by the administrator.',
    'You can now log in to the donor panel using the password you created during signup.',
    '',
    `Email: ${email}`,
    `Login here: ${safeLoginUrl}`,
    '',
    'Thank you for registering as a donor.',
  ].join('\n');
  const html = `
    <p>Hello ${donorName},</p>
    <p>Your donor account has been successfully verified by the administrator.</p>
    <p>You can now log in to the donor panel using the password you created during signup.</p>
    <p><strong>Email:</strong> ${email}<br/>
    <strong>Login here:</strong> <a href="${safeLoginUrl}">${safeLoginUrl}</a></p>
    <p>Thank you for registering as a donor.</p>
  `;

  if (!transport) {
    console.warn('SMTP not configured. Logging donor verification email details instead.');
    console.log(`Donor verification email for ${email}: ${subject}`);
    return false;
  }

  await transport.sendMail({
    from: emailFrom,
    to: email,
    subject,
    text,
    html,
  });

  return true;
}

function getAdminRequestIdentity(req) {
  const source = req.method === 'GET' ? req.query : req.body || {};
  return {
    email: String(source.email || '').trim().toLowerCase(),
    role: String(source.role || '').trim().toLowerCase(),
  };
}

async function getAdminAccountByEmail(email) {
  if (!email) {
    return null;
  }

  const rows = await query(
    `SELECT u.user_id, u.full_name, u.email, u.role
     FROM users u
     WHERE LOWER(u.email) = ? AND u.role = 'admin'
     LIMIT 1`,
    [email]
  );

  return rows[0] || null;
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
    id: row.org_id,
    orgId: row.org_id,
    name: row.display_name || row.org_name,
    orgName: row.org_name,
    orgType: row.org_type,
    address: row.address,
    district: row.district || '',
    city: row.city || '',
    phone: row.phone || row.contact || '',
    hours: row.hours || 'Contact organization for hours',
    availability,
    avail: availability,
    services: parseList(row.services || 'Whole Blood|Platelets|Plasma'),
    imageUrl,
    img: imageUrl,
    verified: Boolean(row.verified),
    verification_documents: row.verification_documents || null,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

app.get('/api/centers', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT o.org_id, o.org_name, o.org_type, o.address, o.contact, o.building_photo, o.verified, o.verification_documents,
              u.district, u.city,
              cl.listing_id, cl.display_name, cl.phone, cl.hours, cl.distance_km,
              cl.availability, cl.services, cl.image_url, cl.latitude, cl.longitude
       FROM organizations o
       LEFT JOIN users u ON u.user_id = o.user_id
       LEFT JOIN center_listings cl ON cl.org_id = o.org_id
       ORDER BY o.org_name ASC`
    );

    res.json({
      data: rows.map((row) => mapCenterRow({
        ...row,
        phone: row.phone || row.contact,
        image_url: row.image_url || row.building_photo,
        hours: row.hours,
        services: row.services,
        availability: row.availability || 'Medium',
        display_name: row.display_name || row.org_name,
        district: row.district,
        city: row.city,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load centers.' });
  }
});

async function getCampaignBloodRequirementsMap(eventIds) {
  if (!eventIds || !eventIds.length) return {};
  try {
    const rows = await query(
      `SELECT event_id, blood_group, units_required
       FROM campaign_blood_requirements
       WHERE event_id IN (${eventIds.map(() => '?').join(',')})`,
      eventIds
    );
    const map = {};
    for (const r of rows) {
      if (!map[r.event_id]) map[r.event_id] = [];
      map[r.event_id].push({ bloodGroup: r.blood_group, unitsRequired: Number(r.units_required || 1) });
    }
    return map;
  } catch (e) {
    console.warn('Failed to load blood requirements map:', e.message);
    return {};
  }
}

const VALID_CAMPAIGN_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const VALID_CAMPAIGN_TYPES = ['Drive', 'Camp', 'Emergency'];

function parseCampaignBloodRequirements(rawRequirements, { requireAtLeastOne = true } = {}) {
  if (!Array.isArray(rawRequirements)) {
    return {
      requirements: [],
      error: requireAtLeastOne
        ? 'Please select at least one blood group requirement with a minimum of 1 unit.'
        : null,
    };
  }

  const requirements = [];
  const seenGroups = new Set();

  for (const rawItem of rawRequirements) {
    if (!rawItem) {
      continue;
    }

    const bloodGroup = String(rawItem.bloodGroup || '').trim().toUpperCase();
  const unitsRequired = rawItem.unitsRequired == null || rawItem.unitsRequired === ''
    ? 1
    : Number(rawItem.unitsRequired);
    if (!VALID_CAMPAIGN_BLOOD_GROUPS.includes(bloodGroup)) {
      return {
        requirements: [],
        error: 'Each blood requirement must use a valid blood group.',
      };
    }

    if (!Number.isInteger(unitsRequired) || unitsRequired < 1) {
      return {
        requirements: [],
        error: `Units required for ${bloodGroup} must be a whole number of at least 1.`,
      };
    }

    if (seenGroups.has(bloodGroup)) {
      return {
        requirements: [],
        error: 'Duplicate blood groups are not allowed in the same campaign.',
      };
    }

    seenGroups.add(bloodGroup);
    requirements.push({ bloodGroup, unitsRequired });
  }

  if (requireAtLeastOne && requirements.length === 0) {
    return {
      requirements: [],
      error: 'Please select at least one blood group requirement with a minimum of 1 unit.',
    };
  }

  return { requirements, error: null };
}

function mapCampaignRow(row, reqMap = {}) {
  const bloodReqs = reqMap[row.event_id] || row.bloodRequirements || [];
  const totalUnitsRequired = bloodReqs.reduce((sum, r) => sum + Number(r.unitsRequired || 0), 0);
  return {
    id: row.event_id,
    title: row.title,
    org: `Organized by ${row.org_name}`,
    orgName: row.org_name,
    orgId: row.org_id,
    date: formatDate(row.event_date),
    time: row.time_range,
    location: row.location,
    type: row.event_type,
    status: row.campaign_status || row.status || 'active',
    img: row.image_url,
    bloodRequirements: bloodReqs,
    totalUnitsRequired: totalUnitsRequired,
    spots: totalUnitsRequired || row.spots_available || 0,
    total: totalUnitsRequired || row.spots_total || 0,
    kind: 'campaign',
  };
}

app.get('/api/events', async (_req, res) => {
  try {
    const [campaignRows, requestRows] = await Promise.all([
      query(
        `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
                bl.time_range, bl.location, bl.event_type, bl.image_url, bl.status
         FROM blood_drive_listings bl
         INNER JOIN organizations o ON o.org_id = bl.org_id
         WHERE bl.status IN ('active', 'stopped')
         ORDER BY bl.event_date DESC, bl.event_id DESC`
      ),
      query(
        `SELECT br.request_id, br.blood_group, br.units_needed, br.urgency,
                br.expires_at, br.hospital_name, br.patient_type,
                br.hospital_address, br.contact_person, br.contact_number,
                o.org_name
         FROM blood_requests br
         INNER JOIN organizations o ON o.org_id = br.org_id
         WHERE br.status = 'open' AND (br.expires_at IS NULL OR br.expires_at >= NOW())
         ORDER BY br.expires_at ASC, br.request_id DESC`
      ),
    ]);

    const campaignEventIds = campaignRows.map((r) => r.event_id);
    const reqMap = await getCampaignBloodRequirementsMap(campaignEventIds);

    res.json({
      data: [
        ...campaignRows.map((row) => mapCampaignRow(row, reqMap)),
        ...requestRows.map(mapBloodRequestListing),
      ].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))),
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/org/dashboard', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Email query parameter is required.' });
  }

  try {
    const orgRows = await query(
      `SELECT o.org_id, o.org_name, o.org_type, o.address, o.contact, o.verified,
              u.full_name, u.email, u.phone, u.city, u.district
       FROM users u
       INNER JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ? AND u.role = 'org'
       LIMIT 1`,
      [email]
    );

    if (!orgRows.length) {
      return res.status(404).json({ message: 'Organization account not found.' });
    }

    const org = orgRows[0];
    const [campaignRows, requestRows, donationRows] = await Promise.all([
      query(
        `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
                bl.time_range, bl.location, bl.event_type, bl.status AS campaign_status, bl.image_url
         FROM blood_drive_listings bl
         INNER JOIN organizations o ON o.org_id = bl.org_id
         WHERE bl.org_id = ?
         ORDER BY bl.event_date DESC, bl.event_id DESC`,
        [org.org_id]
      ),
      query(
        `SELECT request_id, blood_group, units_needed, urgency, status, city, district, created_at, expires_at,
                hospital_name, patient_type, hospital_address, contact_person, contact_number
         FROM blood_requests WHERE org_id = ?
         ORDER BY created_at DESC`,
        [org.org_id]
      ),
      query(
        `SELECT dh.history_id, dh.units_donated, dh.donated_at, dh.location, br.request_id, br.status AS request_status
         FROM donation_history dh
         INNER JOIN blood_requests br ON br.request_id = dh.request_id
         WHERE br.org_id = ?
         ORDER BY dh.donated_at DESC, dh.history_id DESC`,
        [org.org_id]
      ),
    ]);

    const campaignEventIds = campaignRows.map((r) => r.event_id);
    const reqMap = await getCampaignBloodRequirementsMap(campaignEventIds);
    const mappedCampaigns = campaignRows.map((r) => mapCampaignRow(r, reqMap));

    const isCampaignComplete = (campaign) => (
      String(campaign.status || 'active') !== 'active'
    );
    const upcomingCampaigns = mappedCampaigns.filter((campaign) => !isCampaignComplete(campaign));
    const completedCampaigns = mappedCampaigns.filter(isCampaignComplete);
    const openRequestListings = requestRows
      .filter((request) => String(request.status).toLowerCase() === 'open' && (!request.expires_at || new Date(request.expires_at) >= new Date()))
      .map((request) => mapBloodRequestListing({ ...request, org_name: org.org_name }));
    const totalBloodUnitsCollected = donationRows.reduce((s, r) => s + Number(r.units_donated || 0), 0);
    const totalSoldBloodUnits = donationRows.filter((r) => String(r.request_status || '').toLowerCase() === 'fulfilled').reduce((s, r) => s + Number(r.units_donated || 0), 0);
    const requestForBloodUnits = requestRows.reduce((s, r) => s + Number(r.units_needed || 0), 0);
    const openRequests = requestRows.filter((r) => String(r.status || '').toLowerCase() === 'open').length;
    const fulfilledRequests = requestRows.filter((r) => String(r.status || '').toLowerCase() === 'fulfilled').length;

    res.json({
      org: {
        orgId: org.org_id, orgName: org.org_name, orgType: org.org_type,
        address: org.address, contact: org.contact, verified: Boolean(org.verified),
        managerName: org.full_name, email: org.email, phone: org.phone,
        city: org.city, district: org.district,
      },
      metrics: {
        totalCampaigns: mappedCampaigns.length, upcomingCampaigns: upcomingCampaigns.length,
        completedCampaigns: completedCampaigns.length, totalBloodUnitsCollected,
        requestForBloodUnits, totalSoldBloodUnits, openRequests, fulfilledRequests,
        totalCampaignSpots: mappedCampaigns.reduce((s, r) => s + Number(r.totalUnitsRequired || 0), 0),
        availableCampaignSpots: mappedCampaigns.reduce((s, r) => s + Number(r.totalUnitsRequired || 0), 0),
      },
      campaigns: {
        upcoming: upcomingCampaigns,
        completed: completedCampaigns,
      },
      requests: requestRows.map((r) => ({
        requestId: r.request_id, bloodGroup: r.blood_group, unitsNeeded: r.units_needed,
        urgency: r.urgency, status: r.status, city: r.city, district: r.district,
        createdAt: formatDate(r.created_at), expiresAt: formatDate(r.expires_at),
        hospitalName: r.hospital_name, patientType: r.patient_type,
      })),
      recentActivity: donationRows.map((r) => ({
        historyId: r.history_id, units: r.units_donated, date: formatDate(r.donated_at),
        location: r.location, requestId: r.request_id, requestStatus: r.request_status,
      })),
    });
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
  const rawRequirements = Array.isArray(req.body.bloodRequirements) ? req.body.bloodRequirements : [];

  if (!email || !title || !eventDate || !timeRange || !location || !imageUrl) {
    return res.status(400).json({ message: 'Title, date, time, location, and campaign image are required.' });
  }

  const todayDate = new Date().toISOString().slice(0, 10);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(eventDate) || eventDate < todayDate) {
    return res.status(400).json({ message: 'Event date must be today or a future date.' });
  }

  if (!VALID_CAMPAIGN_TYPES.includes(eventType)) {
    return res.status(400).json({ message: 'Campaign type must be Drive, Camp, or Emergency.' });
  }

  const parsedRequirements = parseCampaignBloodRequirements(rawRequirements);
  if (parsedRequirements.error) {
    return res.status(400).json({ message: parsedRequirements.error });
  }
  const bloodRequirements = parsedRequirements.requirements;

  const totalUnitsRequired = bloodRequirements.reduce((sum, r) => sum + r.unitsRequired, 0);

  try {
    const orgRows = await query(
      `SELECT o.org_id, o.org_name, o.verified
       FROM users u
       INNER JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ? AND u.role = 'org'
       LIMIT 1`,
      [email]
    );

    if (!orgRows.length) {
      return res.status(404).json({ message: 'Organization account not found.' });
    }

    const org = orgRows[0];
    if (!org.verified) {
      await query('UPDATE organizations SET verified = TRUE WHERE org_id = ?', [org.org_id]);
      org.verified = 1;
    }

    const bloodSummaryText = bloodRequirements.map(r => `${r.bloodGroup} (${r.unitsRequired} units)`).join(', ');

    const insertResult = await query(
      `INSERT INTO blood_drive_listings (org_id, title, event_date, time_range, location, event_type, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        org.org_id,
        title,
        eventDate,
        timeRange,
        location,
        eventType,
        imageUrl,
      ]
    );

    const eventId = insertResult.insertId;

    for (const reqItem of bloodRequirements) {
      await query(
        `INSERT INTO campaign_blood_requirements (event_id, blood_group, units_required)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE units_required = VALUES(units_required)`,
        [eventId, reqItem.bloodGroup, reqItem.unitsRequired]
      );
    }

    const reqMap = { [eventId]: bloodRequirements };
    const rows = await query(
      `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
              bl.time_range, bl.location, bl.event_type, bl.status AS campaign_status, bl.image_url
       FROM blood_drive_listings bl
       INNER JOIN organizations o ON o.org_id = bl.org_id
       WHERE bl.event_id = ?
       LIMIT 1`,
      [eventId]
    );

    // Notify ALL registered donors in-app and by email
    try {
      const donors = await query(
        `SELECT u.user_id, u.email, u.full_name FROM users u WHERE u.role = 'donor'`
      );

      const notifMessage = `New ${eventType}: "${title}" on ${eventDate} at ${location} by ${org.org_name}. Required Blood: ${bloodSummaryText}.`;

      for (const donor of donors) {
        await query(
          `INSERT INTO notifications (user_id, request_id, event_id, type, message) VALUES (?, NULL, ?, 'broadcast', ?)`,
          [donor.user_id, eventId, notifMessage]
        );

        const transport = createMailTransport();
        if (transport) {
          transport.sendMail({
            from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@saveabeat.local',
            to: donor.email,
            subject: `SaveABeat — New Campaign: ${title}`,
            html: `
              <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #eee;border-radius:12px">
                <h2 style="color:#D62B2B">SaveABeat — New Blood Campaign ❤️</h2>
                <p>Hi <strong>${donor.full_name || 'Donor'}</strong>,</p>
                <p>${notifMessage}</p>
                <p style="margin-top:16px"><a href="http://localhost:3000/donor-dashboard.html" style="background:#D62B2B;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">View Campaign & Donate</a></p>
                <p style="color:#888;font-size:.85rem;margin-top:24px">You are receiving this email because you are a registered donor on SaveABeat.</p>
              </div>`,
          }).catch((err) => console.warn('Donor email notification failed:', err.message));
        }
      }
      console.log(`Notified ${donors.length} registered donors for campaign "${title}"`);
    } catch (notifErr) {
      console.warn('Notification step failed (campaign still created):', notifErr.message);
    }

    res.status(201).json({
      message: 'Campaign created successfully. All registered donors have been notified!',
      campaign: mapCampaignRow(rows[0], reqMap),
    });
  } catch (error) {
    console.error('Campaign creation failed:', error);
    sendDbError(res, error);
  }
});

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

app.put('/api/org/campaigns/:eventId', async (req, res) => {
  const eventId = Number.parseInt(req.params.eventId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  const hasBloodRequirements = Object.prototype.hasOwnProperty.call(req.body, 'bloodRequirements');
  const rawRequirements = hasBloodRequirements ? req.body.bloodRequirements : null;
  const isCompleted = req.body.isCompleted === true;

  if (!eventId || !email) {
    return res.status(400).json({ message: 'Campaign id and organization email are required.' });
  }

  try {
    const org = await getOrganizationForCampaignAction(email);
    if (!org) {
      return res.status(403).json({ message: 'Organization account not found.' });
    }

    const campaignRows = await query(
      `SELECT event_id, title, event_type, event_date, time_range, location, status
       FROM blood_drive_listings
       WHERE event_id = ? AND org_id = ?
       LIMIT 1`,
      [eventId, org.org_id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ message: 'Campaign not found or you do not have permission to update it.' });
    }

    const currentCampaign = campaignRows[0];
    const title = String(req.body.title || currentCampaign.title || '').trim();
    const eventType = String(req.body.type || currentCampaign.event_type || 'Drive').trim();
    const eventDate = String(req.body.eventDate || currentCampaign.event_date || '').trim();
    const time = String(req.body.time || currentCampaign.time_range || '').trim();
    const location = String(req.body.location || currentCampaign.location || '').trim();

    if (!title || !eventDate || !location) {
      return res.status(400).json({ message: 'Campaign name, date, and location are required.' });
    }

    if (!VALID_CAMPAIGN_TYPES.includes(eventType)) {
      return res.status(400).json({ message: 'Campaign type must be Drive, Camp, or Emergency.' });
    }

    let bloodRequirements = null;
    if (hasBloodRequirements) {
      const parsedRequirements = parseCampaignBloodRequirements(rawRequirements);
      if (parsedRequirements.error) {
        return res.status(400).json({ message: parsedRequirements.error });
      }
      bloodRequirements = parsedRequirements.requirements;
    }

    const status = isCompleted ? 'completed' : currentCampaign.status || 'active';

    await query(
      `UPDATE blood_drive_listings
       SET title = ?, event_date = ?, time_range = ?, location = ?, event_type = ?, status = ?
       WHERE event_id = ? AND org_id = ?`,
      [title, eventDate, time || '', location, eventType, status, eventId, org.org_id]
    );

    if (bloodRequirements) {
      await query(
        `DELETE FROM campaign_blood_requirements WHERE event_id = ?`,
        [eventId]
      );

      for (const reqItem of bloodRequirements) {
        await query(
          `INSERT INTO campaign_blood_requirements (event_id, blood_group, units_required)
           VALUES (?, ?, ?)`,
          [eventId, reqItem.bloodGroup, reqItem.unitsRequired]
        );
      }
    }

    const reqMap = bloodRequirements ? { [eventId]: bloodRequirements } : await getCampaignBloodRequirementsMap([eventId]);
    const rows = await query(
      `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
              bl.time_range, bl.location, bl.event_type, bl.status AS campaign_status, bl.image_url
       FROM blood_drive_listings bl
       INNER JOIN organizations o ON o.org_id = bl.org_id
       WHERE bl.event_id = ?
       LIMIT 1`,
      [eventId]
    );

    res.json({
      message: 'Campaign updated successfully.',
      campaign: mapCampaignRow(rows[0], reqMap),
    });
  } catch (error) {
    console.error('Campaign update failed:', error);
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

    const eventRows = await query(
      `SELECT event_id, location, spots_available FROM blood_drive_listings
       WHERE event_id = ? AND status = 'active' AND spots_available > 0 LIMIT 1`,
      [eventId]
    );
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
      const donatedUnits = Number.isNaN(units) || units < 1 ? 1 : units;
      await query(
        `UPDATE blood_drive_listings
         SET spots_available = GREATEST(0, COALESCE(spots_available, 0) - ?),
             status = CASE WHEN GREATEST(0, COALESCE(spots_available, 0) - ?) = 0 THEN 'completed' ELSE status END
         WHERE event_id = ? AND status = 'active'`,
        [donatedUnits, donatedUnits, eventId]
      );
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

app.post('/api/notifications/email', async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ message: 'Message is required.' });
  }

  try {
    const donors = await query("SELECT email, full_name FROM users WHERE role = 'donor'");
    const transport = createMailTransport();
    if (transport) {
      for (const donor of donors) {
        transport.sendMail({
          from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@saveabeat.local',
          to: donor.email,
          subject: 'SaveABeat Notification',
          text: message,
          html: `<p>Hi <strong>${donor.full_name || 'Donor'}</strong>,</p><p>${message}</p><p><a href="http://localhost:3000/donor-dashboard.html" style="background:#D62B2B;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold">View Donor Dashboard</a></p>`
        }).catch(err => console.warn('Notification email error:', err.message));
      }
    }
    res.json({ ok: true, message: `Email notifications queued for ${donors.length} donors.` });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.post('/api/org/requests', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const hospitalName = String(req.body.hospitalName || '').trim();
  const bloodGroup = String(req.body.bloodGroup || '').trim();
  const unitsRequired = Number.parseInt(req.body.unitsRequired || 0, 10);
  const priority = String(req.body.priority || 'normal').trim();
  const patientType = String(req.body.patientType || '').trim();
  const requiredBy = String(req.body.requiredBy || '').trim();
  const hospitalAddress = String(req.body.hospitalAddress || '').trim();
  const contactPerson = String(req.body.contactPerson || '').trim();
  const contactNumber = String(req.body.contactNumber || '').trim();
  const additionalNote = String(req.body.additionalNote || '').trim();

  const bloodGroups = ['A+','A-','B+','B-','AB+','AB-','O+','O-'];
  const priorityMap = { normal: 'normal', urgent: 'urgent', critical: 'critical' };
  const urgency = priorityMap[priority] || 'normal';

  if (!email || !hospitalName || !bloodGroup || !unitsRequired || !patientType || !requiredBy || !hospitalAddress || !contactPerson || !contactNumber) {
    return res.status(400).json({ message: 'Please fill in all required fields.' });
  }

  const requiredByDate = new Date(requiredBy);
  if (Number.isNaN(requiredByDate.getTime()) || requiredByDate <= new Date()) {
    return res.status(400).json({ message: 'Required by date and time must be in the future.' });
  }

  if (!bloodGroups.includes(bloodGroup)) {
    return res.status(400).json({ message: 'Invalid blood group.' });
  }

  if (Number.isNaN(unitsRequired) || unitsRequired < 1) {
    return res.status(400).json({ message: 'Units required must be at least 1.' });
  }

  try {
    const orgRows = await query(
      `SELECT o.org_id, o.org_name, o.verified, o.address, o.contact,
              u.full_name, u.phone, u.city, u.district
       FROM users u
       INNER JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ? AND u.role = 'org'
       LIMIT 1`,
      [email]
    );

    if (!orgRows.length) {
      return res.status(404).json({ message: 'Organization account not found.' });
    }

    const org = orgRows[0];
    if (!org.verified) {
      await query('UPDATE organizations SET verified = TRUE WHERE org_id = ?', [org.org_id]);
      org.verified = 1;
    }

    const city = org.city || 'Kathmandu';
    const district = org.district || 'Kathmandu';

    let formattedRequiredBy = requiredBy;
    if (formattedRequiredBy.length === 10) {
      formattedRequiredBy = `${formattedRequiredBy} 23:59:59`;
    }

    const insertResult = await query(
      `INSERT INTO blood_requests (
        org_id, blood_group, units_needed, urgency, status, city, district,
        expires_at, hospital_name, patient_type, required_by, hospital_address,
        contact_person, contact_number, additional_note
      ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        org.org_id, bloodGroup, unitsRequired, urgency, city, district,
        formattedRequiredBy,
        hospitalName, patientType, formattedRequiredBy, hospitalAddress,
        contactPerson, contactNumber, additionalNote || null,
      ]
    );

    // Notify ALL registered donors by email and in-app
    try {
      const donors = await query(
        `SELECT u.user_id, u.email, u.full_name FROM users u WHERE u.role = 'donor'`
      );

      const notifMessage = `Urgent blood request: ${bloodGroup} blood needed (${unitsRequired} units) at ${hospitalName}. Required by: ${requiredBy}. Contact: ${contactPerson} (${contactNumber}).`;

      for (const donor of donors) {
        await query(
          `INSERT INTO notifications (user_id, request_id, type, message) VALUES (?, ?, 'match', ?)`,
          [donor.user_id, insertResult.insertId, notifMessage]
        );

        const transport = createMailTransport();
        if (transport) {
          transport.sendMail({
            from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@saveabeat.local',
            to: donor.email,
            subject: `SaveABeat — Urgent Blood Request: ${bloodGroup} needed at ${hospitalName}`,
            html: `
              <div style="font-family:sans-serif;max-width:500px;margin:auto;padding:32px;border:1px solid #eee;border-radius:12px">
                <h2 style="color:#D62B2B">SaveABeat — Urgent Blood Needed ❤️</h2>
                <p>Hi <strong>${donor.full_name || 'Donor'}</strong>,</p>
                <p>An urgent blood request for <strong>${bloodGroup}</strong> has been published by <strong>${org.org_name}</strong>.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0">
                  <tr><td style="padding:8px;color:#888;font-size:.85rem">Hospital</td><td style="padding:8px;font-weight:600">${hospitalName}</td></tr>
                  <tr style="background:#fafafa"><td style="padding:8px;color:#888;font-size:.85rem">Address</td><td style="padding:8px">${hospitalAddress}</td></tr>
                  <tr><td style="padding:8px;color:#888;font-size:.85rem">Blood Type</td><td style="padding:8px;font-weight:600;color:#D62B2B">${bloodGroup}</td></tr>
                  <tr style="background:#fafafa"><td style="padding:8px;color:#888;font-size:.85rem">Units Needed</td><td style="padding:8px">${unitsRequired}</td></tr>
                  <tr><td style="padding:8px;color:#888;font-size:.85rem">Patient Type</td><td style="padding:8px">${patientType}</td></tr>
                  <tr style="background:#fafafa"><td style="padding:8px;color:#888;font-size:.85rem">Required By</td><td style="padding:8px;font-weight:600">${requiredBy}</td></tr>
                  <tr><td style="padding:8px;color:#888;font-size:.85rem">Priority</td><td style="padding:8px">${priority}</td></tr>
                  <tr style="background:#fafafa"><td style="padding:8px;color:#888;font-size:.85rem">Contact Person</td><td style="padding:8px">${contactPerson}</td></tr>
                  <tr><td style="padding:8px;color:#888;font-size:.85rem">Contact Number</td><td style="padding:8px"><strong>${contactNumber}</strong></td></tr>
                  ${additionalNote ? `<tr style="background:#fafafa"><td style="padding:8px;color:#888;font-size:.85rem">Note</td><td style="padding:8px">${additionalNote}</td></tr>` : ''}
                </table>
                <p style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px;font-size:.88rem">
                  ⚠️ <strong>Urgent:</strong> Please contact <strong>${contactPerson}</strong> at <strong>${contactNumber}</strong> if you can donate.
                </p>
                <p style="margin-top:16px"><a href="http://localhost:3000/donor-dashboard.html" style="background:#D62B2B;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Go to Donor Dashboard</a></p>
                <p style="color:#888;font-size:.82rem;margin-top:24px">You are receiving this email because you are a registered donor on SaveABeat.</p>
              </div>`,
          }).catch((err) => console.warn('Donor request email failed:', err.message));
        }
      }
      console.log(`Notified ${donors.length} registered donors for blood request at ${hospitalName}`);
    } catch (notifErr) {
      console.warn('Notification failed (request still created):', notifErr.message);
    }

    res.status(201).json({
      message: `Blood request published. All registered donors have been notified.`,
      requestId: insertResult.insertId,
    });
  } catch (error) {
    console.error('Blood request creation failed:', error);
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
  const spotsTotal = Number.parseInt(req.body.spotsTotal, 10);
  const bloodGroupNeeded = String(req.body.bloodGroupNeeded || '').trim() || null;

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
      `SELECT o.org_id, o.org_name, o.verified
       FROM users u
       INNER JOIN organizations o ON o.user_id = u.user_id
       WHERE LOWER(u.email) = ? AND u.role = 'org'
       LIMIT 1`,
      [email]
    );

    if (!orgRows.length) {
      return res.status(404).json({ message: 'Organization account not found.' });
    }

    const org = orgRows[0];
    if (!org.verified) {
      await query('UPDATE organizations SET verified = TRUE WHERE org_id = ?', [org.org_id]);
      org.verified = 1;
    }

    const insertResult = await query(
      `INSERT INTO blood_drive_listings (org_id, title, event_date, time_range, location, distance_km, spots_total, spots_available, event_type, blood_group_needed, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        org.org_id,
        title,
        eventDate,
        timeRange,
        location,
        0,
        spotsTotal,
        spotsTotal,
        eventType,
        bloodGroupNeeded,
        imageUrl,
      ]
    );

    const rows = await query(
      `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
              bl.time_range, bl.location, bl.distance_km, bl.spots_total,
              bl.spots_available, bl.event_type, bl.blood_group_needed, bl.image_url
       FROM blood_drive_listings bl
       INNER JOIN organizations o ON o.org_id = bl.org_id
       WHERE bl.event_id = ?
       LIMIT 1`,
      [insertResult.insertId]
    );

    // Notify ALL registered donors in-app and by email
    try {
      const donors = await query(
        `SELECT u.user_id, u.email, u.full_name FROM users u WHERE u.role = 'donor'`
      );

      const notifMessage = bloodGroupNeeded
        ? `New ${eventType}: "${title}" on ${eventDate} at ${location} by ${org.org_name}. Needed blood type: ${bloodGroupNeeded}.`
        : `New ${eventType}: "${title}" on ${eventDate} at ${location} by ${org.org_name}. All blood types welcome!`;

      for (const donor of donors) {
        await query(
          `INSERT INTO notifications (user_id, request_id, event_id, type, message) VALUES (?, NULL, ?, 'broadcast', ?)`,
          [donor.user_id, insertResult.insertId, notifMessage]
        );

        const transport = createMailTransport();
        if (transport) {
          transport.sendMail({
            from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@saveabeat.local',
            to: donor.email,
            subject: `SaveABeat — New Campaign: ${title}`,
            html: `
              <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #eee;border-radius:12px">
                <h2 style="color:#D62B2B">SaveABeat — New Blood Campaign ❤️</h2>
                <p>Hi <strong>${donor.full_name || 'Donor'}</strong>,</p>
                <p>${notifMessage}</p>
                <p style="margin-top:16px"><a href="http://localhost:3000/donor-dashboard.html" style="background:#D62B2B;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">View Campaign & Donate</a></p>
                <p style="color:#888;font-size:.85rem;margin-top:24px">You are receiving this email because you are a registered donor on SaveABeat.</p>
              </div>`,
          }).catch((err) => console.warn('Donor email notification failed:', err.message));
        }
      }
      console.log(`Notified ${donors.length} registered donors for campaign "${title}"`);
    } catch (notifErr) {
      console.warn('Notification step failed (campaign still created):', notifErr.message);
    }

    res.status(201).json({
      message: 'Campaign created successfully. All registered donors have been notified!',
      campaign: mapCampaignRow(rows[0]),
    });
  } catch (error) {
    console.error('Campaign creation failed:', error);
    sendDbError(res, error);
  }
});

async function getOrganizationForCampaignAction(email) {
  const rows = await query(
    `SELECT o.org_id FROM users u
     INNER JOIN organizations o ON o.user_id = u.user_id
     WHERE LOWER(u.email) = ? AND u.role = 'org' LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

function mapBloodRequestListing(row) {
  const urgency = String(row.urgency || 'normal').toLowerCase();
  return {
    id: `request-${row.request_id}`,
    requestId: row.request_id,
    kind: 'blood-request',
    title: `${String(row.blood_group || '').trim()} blood needed`,
    org: `Requested by ${row.hospital_name || row.org_name}`,
    orgName: row.org_name,
    date: formatDate(row.expires_at),
    time: 'Required by',
    location: row.hospital_address || 'Location not specified',
    spots: row.units_needed,
    total: row.units_needed,
    type: 'Emergency',
    urgency,
    patientType: row.patient_type || null,
    contactPerson: row.contact_person || null,
    contactNumber: row.contact_number || null,
    img: 'https://images.unsplash.com/photo-1615461066841-6116e61058f4?w=900&auto=format&fit=crop&q=70',
  };
}

app.post('/api/org/campaigns/:eventId/stop', async (req, res) => {
  const eventId = Number.parseInt(req.params.eventId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!eventId || !email) {
    return res.status(400).json({ message: 'Campaign id and organization email are required.' });
  }

  try {
    const organization = await getOrganizationForCampaignAction(email);
    if (!organization) {
      return res.status(403).json({ message: 'Organization account not found.' });
    }

    const result = await query(
      `UPDATE blood_drive_listings SET status = 'stopped'
       WHERE event_id = ? AND org_id = ? AND status = 'active'`,
      [eventId, organization.org_id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'An active campaign with this id was not found.' });
    }
    res.json({ message: 'Campaign stopped and moved to completed campaigns.' });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.delete('/api/org/campaigns/:eventId', async (req, res) => {
  const eventId = Number.parseInt(req.params.eventId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!eventId || !email) {
    return res.status(400).json({ message: 'Campaign id and organization email are required.' });
  }

  try {
    const organization = await getOrganizationForCampaignAction(email);
    if (!organization) {
      return res.status(403).json({ message: 'Organization account not found.' });
    }

    const result = await query(
      'DELETE FROM blood_drive_listings WHERE event_id = ? AND org_id = ?',
      [eventId, organization.org_id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }
    await query('DELETE FROM notifications WHERE event_id = ?', [eventId]);
    res.json({ message: 'Campaign deleted successfully.' });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.put('/api/org/campaigns/:eventId', async (req, res) => {
  const eventId = Number.parseInt(req.params.eventId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  const hasBloodRequirements = Object.prototype.hasOwnProperty.call(req.body, 'bloodRequirements');
  const rawRequirements = hasBloodRequirements ? req.body.bloodRequirements : null;
  const isCompleted = req.body.isCompleted === true;

  if (!eventId || !email) {
    return res.status(400).json({ message: 'Campaign id and organization email are required.' });
  }

  try {
    const organization = await getOrganizationForCampaignAction(email);
    if (!organization) {
      return res.status(403).json({ message: 'Organization account not found.' });
    }

    const campaignRows = await query(
      `SELECT event_id, title, event_type, event_date, time_range, location, status
       FROM blood_drive_listings
       WHERE event_id = ? AND org_id = ?
       LIMIT 1`,
      [eventId, organization.org_id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ message: 'Campaign not found or you do not have permission to update it.' });
    }

    const currentCampaign = campaignRows[0];
    const title = String(req.body.title || currentCampaign.title || '').trim();
    const type = String(req.body.type || currentCampaign.event_type || 'Drive').trim();
    const eventDate = String(req.body.eventDate || currentCampaign.event_date || '').trim();
    const time = String(req.body.time || currentCampaign.time_range || '').trim();
    const location = String(req.body.location || currentCampaign.location || '').trim();

    if (!title || !eventDate || !location) {
      return res.status(400).json({ message: 'Campaign name, date, and location are required.' });
    }

    if (!VALID_CAMPAIGN_TYPES.includes(type)) {
      return res.status(400).json({ message: 'Campaign type must be Drive, Camp, or Emergency.' });
    }

    let bloodRequirements = null;
    if (hasBloodRequirements) {
      const parsedRequirements = parseCampaignBloodRequirements(rawRequirements);
      if (parsedRequirements.error) {
        return res.status(400).json({ message: parsedRequirements.error });
      }
      bloodRequirements = parsedRequirements.requirements;
    }

    const status = isCompleted ? 'completed' : currentCampaign.status || 'active';

    const result = await query(
      `UPDATE blood_drive_listings 
       SET title = ?, event_type = ?, event_date = ?, time_range = ?, location = ?, status = ?
       WHERE event_id = ? AND org_id = ?`,
      [title, type, eventDate, time || '', location, status, eventId, organization.org_id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Campaign not found or you do not have permission to update it.' });
    }

    if (bloodRequirements) {
      await query('DELETE FROM campaign_blood_requirements WHERE event_id = ?', [eventId]);

      for (const reqItem of bloodRequirements) {
        await query(
          'INSERT INTO campaign_blood_requirements (event_id, blood_group, units_required) VALUES (?, ?, ?)',
          [eventId, reqItem.bloodGroup, reqItem.unitsRequired]
        );
      }
    }

    const reqMap = bloodRequirements ? { [eventId]: bloodRequirements } : await getCampaignBloodRequirementsMap([eventId]);
    const rows = await query(
      `SELECT bl.event_id, bl.org_id, o.org_name, bl.title, bl.event_date,
              bl.time_range, bl.location, bl.event_type, bl.status AS campaign_status, bl.image_url
       FROM blood_drive_listings bl
       INNER JOIN organizations o ON o.org_id = bl.org_id
       WHERE bl.event_id = ?
       LIMIT 1`,
      [eventId]
    );

    res.json({
      message: 'Campaign updated successfully.',
      campaign: mapCampaignRow(rows[0], reqMap),
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.post('/api/org/:orgId/verify', async (req, res) => {
  const orgId = Number.parseInt(req.params.orgId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || '').trim().toLowerCase();
  const action = String(req.body.action || 'approve').trim().toLowerCase(); // 'approve' or 'reject'

  if (!orgId || !email) {
    return res.status(400).json({ message: 'Organization id and admin email are required.' });
  }

  if (role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can verify organizations.' });
  }

  try {
    const adminRows = await query(
      `SELECT u.user_id FROM users u WHERE LOWER(u.email) = ? AND u.role = 'admin' LIMIT 1`,
      [email]
    );

    if (!adminRows.length) {
      return res.status(403).json({ message: 'Admin account not found.' });
    }

    const verificationStatus = action === 'reject' ? 'Rejected' : 'Approved';
    const verified = action === 'reject' ? FALSE : TRUE;

    const result = await query(
      `UPDATE organizations SET verified = ?, verification_status = ? WHERE org_id = ?`,
      [verified, verificationStatus, orgId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Organization not found.' });
    }

    const actionMessage = action === 'reject' ? 'rejected' : 'verified';
    res.json({ message: `Organization ${actionMessage} successfully.` });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/notifications', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Email query parameter is required.' });
  }

  try {
    const rows = await query(
      `SELECT n.notif_id AS id, n.type, n.message, n.is_read AS isRead, n.sent_at AS sentAt,
              n.event_id AS eventId, n.request_id AS requestId
       FROM notifications n
       INNER JOIN users u ON u.user_id = n.user_id
       WHERE LOWER(u.email) = ? AND u.role = 'donor'
       ORDER BY n.sent_at DESC, n.notif_id DESC
       LIMIT 50`,
      [email]
    );
    res.json({ data: rows });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.patch('/api/notifications/:notificationId/read', async (req, res) => {
  const notificationId = Number.parseInt(req.params.notificationId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!notificationId || !email) {
    return res.status(400).json({ message: 'Notification id and email are required.' });
  }

  try {
    const result = await query(
      `UPDATE notifications n
       INNER JOIN users u ON u.user_id = n.user_id
       SET n.is_read = TRUE
       WHERE n.notif_id = ? AND LOWER(u.email) = ? AND u.role = 'donor'`,
      [notificationId, email]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Notification not found.' });
    }
    res.json({ message: 'Notification marked as read.' });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/admin/donors', async (req, res) => {
  try {
    const { email, role } = getAdminRequestIdentity(req);
    if (!email || role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can view donors.' });
    }

    const admin = await getAdminAccountByEmail(email);
    if (!admin) {
      return res.status(403).json({ message: 'Admin account not found.' });
    }

    const rows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.city, u.district, u.created_at,
              d.blood_group, d.verification_status
       FROM users u
       INNER JOIN donor_profiles d ON u.user_id = d.user_id
       WHERE u.role = 'donor'
       ORDER BY u.created_at DESC`
    );

    res.json({ data: rows.map((row) => mapDonorRecord(row)) });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/admin/donors/:donorId', async (req, res) => {
  const donorId = Number.parseInt(req.params.donorId, 10);
  try {
    const { email, role } = getAdminRequestIdentity(req);
    if (!email || role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can view donor details.' });
    }

    const admin = await getAdminAccountByEmail(email);
    if (!admin) {
      return res.status(403).json({ message: 'Admin account not found.' });
    }

    if (!donorId) {
      return res.status(400).json({ message: 'Donor id is required.' });
    }

    const rows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.address, u.city, u.district,
              u.profile_image_name, u.profile_image_data, u.created_at,
              COALESCE(d.profile_picture, u.profile_image_data) AS profile_picture,
              COALESCE(d.profile_picture_name, u.profile_image_name) AS profile_picture_name,
              d.blood_group, d.is_available, d.last_donated_at, d.total_donations,
              d.blood_verification_document_type, d.blood_verification_document_file,
              d.blood_verification_document_name, d.verification_status
       FROM users u
       INNER JOIN donor_profiles d ON u.user_id = d.user_id
       WHERE u.user_id = ? AND u.role = 'donor'
       LIMIT 1`,
      [donorId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Donor not found.' });
    }

    res.json({ data: mapDonorRecord(rows[0], { detail: true }) });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.post('/api/admin/donors/:donorId/verify', async (req, res) => {
  const donorId = Number.parseInt(req.params.donorId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || '').trim().toLowerCase();
  const action = String(req.body.action || 'approve').trim().toLowerCase();

  if (!donorId || !email) {
    return res.status(400).json({ message: 'Donor id and admin email are required.' });
  }

  if (role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can verify donors.' });
  }

  try {
    const admin = await getAdminAccountByEmail(email);
    if (!admin) {
      return res.status(403).json({ message: 'Admin account not found.' });
    }

    const donorRows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.address, u.city, u.district,
              u.profile_image_name, u.profile_image_data, u.created_at,
              COALESCE(d.profile_picture, u.profile_image_data) AS profile_picture,
              COALESCE(d.profile_picture_name, u.profile_image_name) AS profile_picture_name,
              d.blood_group, d.is_available, d.last_donated_at, d.total_donations,
              d.blood_verification_document_type, d.blood_verification_document_file,
              d.blood_verification_document_name, d.verification_status
       FROM users u
       INNER JOIN donor_profiles d ON u.user_id = d.user_id
       WHERE u.user_id = ? AND u.role = 'donor'
       LIMIT 1`,
      [donorId]
    );

    if (!donorRows.length) {
      return res.status(404).json({ message: 'Donor not found.' });
    }

    const donor = donorRows[0];
    const currentStatus = normalizeDonorVerificationStatus(donor.verification_status);
    const verificationStatus = action === 'reject' ? 'Rejected' : 'Verified';

    if (verificationStatus === 'Verified' && currentStatus === 'Verified') {
      return res.json({
        message: 'Donor is already verified.',
        donor: mapDonorRecord(donor, { detail: true }),
        emailSent: false,
      });
    }

    const result = await query(
      `UPDATE donor_profiles SET verification_status = ? WHERE user_id = ?`,
      [verificationStatus, donorId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Donor not found.' });
    }

    donor.verification_status = verificationStatus;

    let emailSent = false;
    if (verificationStatus === 'Verified') {
      const origin = String(req.get('origin') || '').trim().replace(/\/$/, '');
      const envBaseUrl = String(process.env.DONOR_LOGIN_URL || process.env.FRONTEND_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
      const loginUrl = envBaseUrl
        ? `${envBaseUrl}/login.html?role=donor`
        : origin
          ? `${origin}/login.html?role=donor`
          : 'login.html?role=donor';

      try {
        emailSent = await sendDonorVerificationEmail(donor.email, donor.full_name, loginUrl);
      } catch (error) {
        console.error('Donor verification email failed:', error);
      }
    }

    res.json({
      message: verificationStatus === 'Verified'
        ? (emailSent ? 'Donor verified successfully.' : 'Donor verified successfully, but the verification email could not be sent automatically.')
        : 'Donor rejected successfully.',
      emailSent,
      donor: mapDonorRecord(donor, { detail: true }),
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.delete('/api/admin/donors/:donorId', async (req, res) => {
  const donorId = Number.parseInt(req.params.donorId, 10);
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || '').trim().toLowerCase();

  if (!donorId || !email) {
    return res.status(400).json({ message: 'Donor id and admin email are required.' });
  }

  if (role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can delete donors.' });
  }

  try {
    const admin = await getAdminAccountByEmail(email);
    if (!admin) {
      return res.status(403).json({ message: 'Admin account not found.' });
    }

    const donorRows = await query(
      `SELECT u.user_id, u.full_name, u.email
       FROM users u
       WHERE u.user_id = ? AND u.role = 'donor'
       LIMIT 1`,
      [donorId]
    );

    if (!donorRows.length) {
      return res.status(404).json({ message: 'Donor not found.' });
    }

    const result = await query(
      `DELETE FROM users
       WHERE user_id = ? AND role = 'donor'`,
      [donorId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Donor not found.' });
    }

    res.json({ message: 'Donor deleted successfully.' });
  } catch (error) {
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
    try {
      await sendVerificationEmail(email, role, code);
    } catch (error) {
      verificationCodes.delete(getVerificationKey(email, role));
      console.error('Email send failure:', error);
      return res.status(500).json({ message: 'Unable to send verification code. Please try again later.' });
    }
    res.json({
      message: 'Verification code sent. Please check your email.',
    });
  } catch (error) {
    console.error('Verification code request failed:', error);
    res.status(500).json({ message: 'Unable to send verification code.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const fullName = String(req.body.fullName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const role = String(req.body.role || 'donor').trim().toLowerCase();
  const bloodGroup = String(req.body.bloodGroup || '').trim() || null;
  const password = String(req.body.password || '');
  const city = String(req.body.city || '').trim() || null;
  const district = String(req.body.district || '').trim() || null;
  const totalDonations = Number.parseInt(req.body.totalDonations, 10);
  const profileImageName = String(req.body.profileImageName || '').trim() || null;
  const profileImageData = String(req.body.profileImageData || '').trim() || null;
  const bloodVerificationDocType = String(req.body.bloodVerificationDocType || '').trim() || null;
  const bloodVerificationDocFile = String(req.body.bloodVerificationDocFile || '').trim() || null;
  const bloodVerificationDocName = String(req.body.bloodVerificationDocName || '').trim() || null;
  const orgName = String(req.body.orgName || '').trim() || null;
  const orgDocumentsName = String(req.body.orgDocumentsName || '').trim() || null;
  const orgDocumentsData = String(req.body.orgDocumentsData || '').trim() || null;
  const orgPhotoName = String(req.body.orgPhotoName || '').trim() || null;
  const orgPhotoData = String(req.body.orgPhotoData || '').trim() || null;
  const orgType = String(req.body.orgType || 'hospital').trim() || 'hospital';
  const verificationDocType = String(req.body.verificationDocType || '').trim() || null;
  const verificationDocFile = String(req.body.verificationDocFile || '').trim() || null;
  const verificationDocName = String(req.body.verificationDocName || '').trim() || null;
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

      if (!bloodVerificationDocType || !bloodVerificationDocFile || !bloodVerificationDocName) {
        return res.status(400).json({ message: 'Blood type verification document is required.' });
      }

      const verificationError = verifyEmailCode(email, role, emailVerificationCode);
      if (verificationError) {
        return res.status(400).json({ message: verificationError });
      }

      const insertUser = await query(
        `INSERT INTO users (full_name, email, password_hash, phone, role, city, district)
         VALUES (?, ?, ?, ?, 'donor', ?, ?)`,
        [fullName, email, passwordHash, phone || null, city, district]
      );

      await query(
        `INSERT INTO donor_profiles (user_id, blood_group, is_available, total_donations, profile_picture, profile_picture_name, blood_verification_document_type, blood_verification_document_file, blood_verification_document_name, verification_status)
         VALUES (?, ?, TRUE, 0, ?, ?, ?, ?, ?, 'Pending')`,
        [insertUser.insertId, bloodGroup, profileImageData, profileImageName, bloodVerificationDocType, bloodVerificationDocFile, bloodVerificationDocName]
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
          role: 'donor',
          city,
          district,
          bloodGroup,
          verificationStatus: 'Pending',
          totalDonations: Number.isNaN(totalDonations) || totalDonations < 0 ? 0 : totalDonations,
        },
      });
    }

    // Organization registration
    if (!orgName || !orgDocumentsData || !orgDocumentsName || !orgPhotoData || !orgPhotoName) {
      return res.status(400).json({ message: 'Organization name, verification document, and photo are required.' });
    }

    if (!verificationDocType || !verificationDocFile || !verificationDocName) {
      return res.status(400).json({ message: 'Verification document type and file are required.' });
    }

    const verificationError = verifyEmailCode(email, role, emailVerificationCode);
    if (verificationError) {
      return res.status(400).json({ message: verificationError });
    }

    const insertUser = await query(
      `INSERT INTO users (full_name, email, password_hash, phone, role, city, district)
       VALUES (?, ?, ?, ?, 'org', ?, ?)`,
      [orgName, email, passwordHash, phone || null, city, district]
    );

    const insertOrg = await query(
      `INSERT INTO organizations (user_id, org_name, org_type, contact, verification_document_type, verification_document_file, verification_document_name, verification_status, verification_documents, verification_documents_name, building_photo, building_photo_name, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, FALSE)`,
      [insertUser.insertId, orgName, orgType, phone || null, verificationDocType, verificationDocFile, verificationDocName, orgDocumentsData, orgDocumentsName, orgPhotoData, orgPhotoName]
    );

    const normalizedServices = services.includes('|') ? services : services.split(',').map((item) => item.trim()).filter(Boolean).join('|');

    await query(
      `INSERT INTO center_listings (org_id, display_name, phone, hours, distance_km, availability, services, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [insertOrg.insertId, orgName, phone || '', operatingHours || 'Mon-Fri: 8AM-6PM', 5.0, 'Medium', normalizedServices || 'Whole Blood|Platelets|Plasma', orgPhotoData]
    );

    return res.status(201).json({
      message: 'Verified Successfully.',
      user: {
        userId: insertUser.insertId,
        fullName: orgName,
        email,
        phone: phone || null,
        role: 'org',
        city,
        district,
        orgName,
        orgType,
        verificationStatus: 'Pending',
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
  const expectedRole = String(req.body.role || '').trim().toLowerCase();

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const rows = await query(
      'SELECT user_id, full_name, email, password_hash, role FROM users WHERE LOWER(email) = ? LIMIT 1',
      [email]
    );

    if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ message: 'Invalid Credentials' });
    }

    const userRole = String(rows[0].role || '').trim().toLowerCase();

    if (expectedRole && userRole !== expectedRole) {
      return res.status(401).json({ message: 'Invalid Credentials' });
    }

    const token = createJwtToken({ userId: rows[0].user_id, role: userRole, email: rows[0].email });

    res.json({
      message: 'Login successful.',
      user: {
        userId: rows[0].user_id,
        fullName: rows[0].full_name,
        email: rows[0].email,
        role: userRole,
        token,
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

app.post('/api/responses', async (req, res) => {
  const { requestId, responseType, fullName, phone, email, bloodGroup, referralFullName, referralPhone, referralBloodGroup, referralRelationship, availabilityDate, availabilityTime, notes } = req.body;

  if (!requestId || !responseType || !availabilityDate || !availabilityTime) {
    return res.status(400).json({ message: 'Request ID, response type, availability date, and time are required.' });
  }

  if (responseType === 'self' && (!fullName || !phone || !bloodGroup)) {
    return res.status(400).json({ message: 'Full name, phone, and blood group are required for self response.' });
  }

  if (responseType === 'referral' && (!referralFullName || !referralPhone || !referralBloodGroup || !referralRelationship)) {
    return res.status(400).json({ message: 'Referral full name, phone, blood group, and relationship are required for referral response.' });
  }

  try {
    const result = await query(
      `INSERT INTO donation_responses 
       (request_id, donor_id, response_type, full_name, phone, email, blood_group, 
        referral_full_name, referral_phone, referral_blood_group, referral_relationship, 
        availability_date, availability_time, notes, status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        requestId,
        responseType,
        responseType === 'self' ? fullName : null,
        responseType === 'self' ? phone : null,
        responseType === 'self' ? email : null,
        responseType === 'self' && bloodGroup ? bloodGroup : null,
        responseType === 'referral' ? referralFullName : null,
        responseType === 'referral' ? referralPhone : null,
        responseType === 'referral' ? referralBloodGroup : null,
        responseType === 'referral' ? referralRelationship : null,
        availabilityDate,
        availabilityTime,
        notes || null
      ]
    );

    res.status(201).json({
      message: 'Response submitted successfully.',
      responseId: result.insertId
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/donor/eligibility', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authHeader.substring(7);
  const campaignId = Number.parseInt(req.query.campaignId || '0', 10);
  let donorId = null;

  try {
    const decoded = jwt.verify(token, jwtSecret);
    donorId = decoded.userId || decoded.donorId;
  } catch (jwtError) {
    return res.status(401).json({ message: 'Invalid token.' });
  }

  if (!donorId) {
    return res.status(401).json({ message: 'Authentication failed.' });
  }

  try {
    const [donor] = await query(
      `SELECT donor_id, blood_group, last_donated_at FROM donor_profiles WHERE user_id = ?`,
      [donorId]
    );

    if (!donor) {
      return res.status(404).json({ message: 'Donor profile not found.' });
    }

    const donorProfileId = donor.donor_id;
    const donorBloodGroup = String(donor.blood_group || '').trim();
    const donorLastDonatedAt = donor.last_donated_at ? new Date(donor.last_donated_at) : null;

    const [lastCompletedDonation] = await query(
      `SELECT donation_completed_at 
       FROM donation_participation 
       WHERE donor_id = ? AND status = 'completed' AND donation_completed_at IS NOT NULL
       ORDER BY donation_completed_at DESC 
       LIMIT 1`,
      [donorProfileId]
    );

    const [activeParticipation] = await query(
      `SELECT participation_id, campaign_id, status, applied_at 
       FROM donation_participation 
       WHERE donor_id = ? AND status IN ('pending', 'approved')
       ORDER BY applied_at DESC 
       LIMIT 1`,
      [donorProfileId]
    );

    let eligibilityStatus = 'eligible';
    let eligibleDate = null;
    let lastDonationDate = null;
    let activeRegistration = null;
    let bloodGroupMismatch = false;
    let requiredBloodGroups = [];

    if (donorLastDonatedAt) {
      lastDonationDate = donorLastDonatedAt.toISOString().split('T')[0];
    }

    if (lastCompletedDonation && lastCompletedDonation.donation_completed_at) {
      const completedDate = new Date(lastCompletedDonation.donation_completed_at);
      const completedIso = completedDate.toISOString().split('T')[0];
      if (!lastDonationDate || completedIso > lastDonationDate) {
        lastDonationDate = completedIso;
      }
    }

    if (lastDonationDate) {
      const donationDate = new Date(lastDonationDate);
      const eligibleDateObj = new Date(donationDate);
      eligibleDateObj.setDate(eligibleDateObj.getDate() + 56);
      eligibleDate = eligibleDateObj.toISOString().split('T')[0];

      const today = new Date();
      if (today < eligibleDateObj) {
        eligibilityStatus = 'ineligible';
      }
    }

    if (campaignId) {
      const rows = await query(
        `SELECT blood_group FROM campaign_blood_requirements WHERE event_id = ?`,
        [campaignId]
      );
      requiredBloodGroups = rows.map((r) => String(r.blood_group || '').trim()).filter(Boolean);
      if (requiredBloodGroups.length && donorBloodGroup && !requiredBloodGroups.includes(donorBloodGroup)) {
        bloodGroupMismatch = true;
        eligibilityStatus = 'ineligible';
      }
    }

    if (activeParticipation) {
      activeRegistration = {
        participationId: activeParticipation.participation_id,
        campaignId: activeParticipation.campaign_id,
        status: activeParticipation.status,
        appliedAt: activeParticipation.applied_at
      };
      eligibilityStatus = 'has_active_registration';
    }

    res.json({
      eligibilityStatus,
      eligibleDate,
      lastDonationDate,
      activeRegistration,
      donorBloodGroup,
      requiredBloodGroups,
      bloodGroupMismatch
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.post('/api/participation', async (req, res) => {
  const { campaignId, organizationId, participationType, fullName, email, phone, bloodGroup, confirmAge, confirmHealthy, confirmInterval, confirmMedicalScreening } = req.body;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authHeader.substring(7);
  let donorId = null;

  try {
    const decoded = jwt.verify(token, jwtSecret);
    donorId = decoded.userId || decoded.donorId;
  } catch (jwtError) {
    return res.status(401).json({ message: 'Invalid token.' });
  }

  if (!donorId) {
    return res.status(401).json({ message: 'Authentication failed.' });
  }

  try {
    if (!campaignId || !organizationId || !participationType) {
      return res.status(400).json({ message: 'Campaign ID, organization ID, and participation type are required.' });
    }

    if (!confirmAge || !confirmHealthy || !confirmInterval || !confirmMedicalScreening) {
      return res.status(400).json({ message: 'All eligibility confirmations must be checked.' });
    }

    const [donor] = await query(
      `SELECT donor_id, blood_group, last_donated_at FROM donor_profiles WHERE user_id = ?`,
      [donorId]
    );

    if (!donor) {
      return res.status(404).json({ message: 'Donor profile not found.' });
    }

    const donorProfileId = donor.donor_id;
    const donorBloodGroup = String(donor.blood_group || '').trim();
    const donorLastDonatedAt = donor.last_donated_at ? new Date(donor.last_donated_at) : null;

    const [campaign] = await query(
      `SELECT event_id, org_id, status FROM blood_drive_listings WHERE event_id = ? AND status = 'active' LIMIT 1`,
      [campaignId]
    );
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found or not open for registration.' });
    }

    const campaignRows = await query(
      `SELECT blood_group FROM campaign_blood_requirements WHERE event_id = ?`,
      [campaignId]
    );
    const requiredGroups = campaignRows.map((r) => String(r.blood_group || '').trim()).filter(Boolean);
    if (requiredGroups.length && donorBloodGroup && !requiredGroups.includes(donorBloodGroup)) {
      return res.status(403).json({
        message: `Your blood group (${donorBloodGroup}) does not match this campaign's requirements: ${requiredGroups.join(', ')}.`
      });
    }

    const [lastCompletedDonation] = await query(
      `SELECT donation_completed_at 
       FROM donation_participation 
       WHERE donor_id = ? AND status = 'completed' AND donation_completed_at IS NOT NULL
       ORDER BY donation_completed_at DESC 
       LIMIT 1`,
      [donorProfileId]
    );

    let lastDonationDate = donorLastDonatedAt ? donorLastDonatedAt : null;
    if (lastCompletedDonation && lastCompletedDonation.donation_completed_at) {
      const completedDate = new Date(lastCompletedDonation.donation_completed_at);
      if (!lastDonationDate || completedDate > lastDonationDate) {
        lastDonationDate = completedDate;
      }
    }

    if (lastDonationDate) {
      const eligibleDate = new Date(lastDonationDate);
      eligibleDate.setDate(eligibleDate.getDate() + 56);

      const today = new Date();
      if (today < eligibleDate) {
        return res.status(403).json({
          message: 'You are not yet eligible to donate.',
          lastDonationDate: lastDonationDate.toISOString().split('T')[0],
          eligibleDate: eligibleDate.toISOString().split('T')[0]
        });
      }
    }

    const [activeParticipation] = await query(
      `SELECT participation_id 
       FROM donation_participation 
       WHERE donor_id = ? AND status IN ('pending', 'approved')
       LIMIT 1`,
      [donorProfileId]
    );

    if (activeParticipation) {
      return res.status(409).json({
        message: 'You already have an active donation registration for another campaign. Please complete or cancel your existing participation before registering again.'
      });
    }

    const result = await query(
      `INSERT INTO donation_participation 
       (donor_id, campaign_id, organization_id, participation_type, status, eligibility_checked, notes)
       VALUES (?, ?, ?, ?, 'pending', TRUE, ?)`,
      [donorProfileId, campaignId, organizationId, participationType, JSON.stringify({ fullName, email, phone, bloodGroup })]
    );

    res.status(201).json({
      message: 'Participation registered successfully.',
      participationId: result.insertId
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/organization/campaigns/:eventId/participations', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authHeader.substring(7);
  let userId = null;

  try {
    const decoded = jwt.verify(token, jwtSecret);
    userId = decoded.userId || decoded.orgId;
  } catch (jwtError) {
    return res.status(401).json({ message: 'Invalid token.' });
  }

  if (!userId) {
    return res.status(401).json({ message: 'Invalid token.' });
  }

  const eventId = Number.parseInt(req.params.eventId, 10);
  if (!eventId) {
    return res.status(400).json({ message: 'Valid campaign id is required.' });
  }

  try {
    const [org] = await query(
      `SELECT org_id FROM organizations WHERE user_id = ?`,
      [userId]
    );

    if (!org) {
      return res.status(403).json({ message: 'Not authorized as an organization.' });
    }

    const [campaign] = await query(
      `SELECT event_id FROM blood_drive_listings WHERE event_id = ? AND org_id = ?`,
      [eventId, org.org_id]
    );

    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found or you do not have permission to access it.' });
    }

    const registrations = await query(
      `SELECT dp.participation_id, dp.status, dp.applied_at, dp.approved_at, dp.donation_completed_at, dp.notes
       FROM donation_participation dp
       INNER JOIN blood_drive_listings bl ON dp.campaign_id = bl.event_id
       WHERE bl.event_id = ? AND bl.org_id = ?
       ORDER BY dp.applied_at DESC`,
      [eventId, org.org_id]
    );

    const processed = registrations.map((row) => {
      let donorData = {};
      try {
        donorData = row.notes ? JSON.parse(row.notes) : {};
      } catch (_err) {
        donorData = {};
      }
      return {
        participationId: row.participation_id,
        status: row.status,
        appliedAt: row.applied_at,
        approvedAt: row.approved_at,
        donationCompletedAt: row.donation_completed_at,
        fullName: donorData.fullName || donorData.name || 'Unknown',
        email: donorData.email || '',
        phone: donorData.phone || '',
        bloodGroup: donorData.bloodGroup || donorData.blood_group || '',
      };
    });

    res.json({
      total: processed.length,
      registrations: processed,
    });
  } catch (error) {
    sendDbError(res, error);
  }
});

app.get('/api/organization/participations', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, jwtSecret);
    const userId = decoded.userId || decoded.orgId;

    if (!userId) {
      return res.status(401).json({ message: 'Invalid token.' });
    }

    const [org] = await query(
      `SELECT org_id FROM organizations WHERE user_id = ?`,
      [userId]
    );

    if (!org) {
      return res.status(403).json({ message: 'Not authorized as an organization.' });
    }

    const participations = await query(
      `SELECT dp.*, dp.notes as donor_notes, 
              bdl.title as campaign_title, bdl.event_date, bdl.time_range, bdl.location,
              dp.full_name, dp.email, dp.phone, dp.blood_group
       FROM donation_participation dp
       LEFT JOIN blood_drive_listings bdl ON dp.campaign_id = bdl.event_id
       WHERE dp.organization_id = ?
       ORDER BY dp.applied_at DESC`,
      [org.org_id]
    );

    const enrichedParticipations = participations.map(p => {
      let donorInfo = {};
      try {
        if (p.donor_notes) {
          donorInfo = JSON.parse(p.donor_notes);
        }
      } catch (e) {
        donorInfo = {};
      }
      
      return {
        ...p,
        fullName: donorInfo.fullName || p.full_name,
        email: donorInfo.email || p.email,
        phone: donorInfo.phone || p.phone,
        bloodGroup: donorInfo.bloodGroup || p.blood_group
      };
    });

    res.json(enrichedParticipations);
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token.' });
    }
    sendDbError(res, error);
  }
});

app.patch('/api/organization/participations/:participationId', async (req, res) => {
  const { participationId } = req.params;
  const { status, donationCompletedAt } = req.body;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, jwtSecret);
    const userId = decoded.userId || decoded.orgId;

    if (!userId) {
      return res.status(401).json({ message: 'Invalid token.' });
    }

    const [org] = await query(
      `SELECT org_id FROM organizations WHERE user_id = ?`,
      [userId]
    );

    if (!org) {
      return res.status(403).json({ message: 'Not authorized as an organization.' });
    }

    const validStatuses = ['pending', 'approved', 'rejected', 'cancelled', 'completed', 'no_show'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    let updateFields = ['status = ?'];
    let updateValues = [status];

    if (status === 'approved') {
      updateFields.push('approved_at = CURRENT_TIMESTAMP');
    } else if (status === 'cancelled') {
      updateFields.push('cancelled_at = CURRENT_TIMESTAMP');
    } else if (status === 'completed' && donationCompletedAt) {
      updateFields.push('donation_completed_at = ?');
      updateValues.push(donationCompletedAt);
    } else if (status === 'no_show') {
      updateFields.push('cancelled_at = CURRENT_TIMESTAMP');
    }

    updateValues.push(participationId, org.org_id);

    const result = await query(
      `UPDATE donation_participation 
       SET ${updateFields.join(', ')}
       WHERE participation_id = ? AND organization_id = ?`,
      updateValues
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Participation not found or not authorized.' });
    }

    res.json({
      message: 'Participation status updated successfully.',
      participationId: Number(participationId),
      status
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token.' });
    }
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

    // Existing installations predate campaign-linked notifications. Keep the
    // migration small and idempotent so the notification dropdown can link to
    // the exact campaign that created it.
    const [notificationColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'event_id'`
    );
    if (!notificationColumns.length) {
      await pool.query('ALTER TABLE notifications ADD COLUMN event_id INT NULL AFTER request_id');
    }

    const [campaignStatusColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blood_drive_listings' AND COLUMN_NAME = 'status'`
    );
    if (!campaignStatusColumns.length) {
      await pool.query("ALTER TABLE blood_drive_listings ADD COLUMN status ENUM('active', 'completed', 'stopped') NOT NULL DEFAULT 'active' AFTER event_type");
    }

    const [donorStatusColumns] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donor_profiles' AND COLUMN_NAME = 'verification_status'`
    );
    if (donorStatusColumns.length) {
      const donorStatusType = String(donorStatusColumns[0].COLUMN_TYPE || '');
      if (donorStatusType.includes('Approved') || !donorStatusType.includes('Verified')) {
        await pool.query("ALTER TABLE donor_profiles MODIFY verification_status ENUM('Pending', 'Approved', 'Verified', 'Rejected') NOT NULL DEFAULT 'Pending'");
        await pool.query("UPDATE donor_profiles SET verification_status = 'Verified' WHERE verification_status = 'Approved'");
        await pool.query("ALTER TABLE donor_profiles MODIFY verification_status ENUM('Pending', 'Verified', 'Rejected') NOT NULL DEFAULT 'Pending'");
      }
    }

    // Migration for donation_responses table to support self/referral functionality
    const [responseTypeColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donation_responses' AND COLUMN_NAME = 'response_type'`
    );
    if (!responseTypeColumns.length) {
      await pool.query("ALTER TABLE donation_responses ADD COLUMN response_type ENUM('self', 'referral') NOT NULL DEFAULT 'self' AFTER donor_id");
    }

    const [fullNameColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donation_responses' AND COLUMN_NAME = 'full_name'`
    );
    if (!fullNameColumns.length) {
      await pool.query("ALTER TABLE donation_responses ADD COLUMN full_name VARCHAR(100) AFTER response_type");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN phone VARCHAR(20) AFTER full_name");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN email VARCHAR(150) AFTER phone");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') AFTER email");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN referral_full_name VARCHAR(100) AFTER blood_group");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN referral_phone VARCHAR(20) AFTER referral_full_name");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN referral_blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') AFTER referral_phone");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN referral_relationship VARCHAR(50) AFTER referral_blood_group");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN availability_date DATE NOT NULL AFTER referral_relationship");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN availability_time VARCHAR(10) NOT NULL AFTER availability_date");
      await pool.query("ALTER TABLE donation_responses ADD COLUMN notes TEXT AFTER availability_time");
      await pool.query("ALTER TABLE donation_responses MODIFY COLUMN donor_id INT NULL");
    }

    // Migration for donation_participation table
    const [participationColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donation_participation' AND COLUMN_NAME = 'participation_id'`
    );
    if (!participationColumns.length) {
      await pool.query(`
        CREATE TABLE donation_participation (
          participation_id INT AUTO_INCREMENT PRIMARY KEY,
          donor_id INT NOT NULL,
          campaign_id INT NOT NULL,
          organization_id INT NOT NULL,
          participation_type ENUM('event', 'drive', 'center') NOT NULL DEFAULT 'event',
          status ENUM('pending', 'approved', 'rejected', 'cancelled', 'completed', 'no_show') NOT NULL DEFAULT 'pending',
          applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          approved_at DATETIME,
          donation_completed_at DATETIME,
          cancelled_at DATETIME,
          eligibility_checked BOOLEAN DEFAULT FALSE,
          notes TEXT,
          CONSTRAINT fk_participation_donor
            FOREIGN KEY (donor_id) REFERENCES donor_profiles(donor_id)
            ON DELETE CASCADE,
          CONSTRAINT fk_participation_campaign
            FOREIGN KEY (campaign_id) REFERENCES blood_drive_listings(event_id)
            ON DELETE CASCADE,
          CONSTRAINT fk_participation_org
            FOREIGN KEY (organization_id) REFERENCES organizations(org_id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
    }

    // Campaign images are sent from the browser as base64 data URLs. Older
    // databases used VARCHAR/TEXT here, which rejects ordinary photo uploads.
    await pool.query('ALTER TABLE blood_drive_listings MODIFY COLUMN image_url MEDIUMTEXT NOT NULL');

    const transport = createMailTransport();
    if (transport) {
      transport.verify((err) => {
        if (err) console.error('SMTP connection failed:', err.message);
        else console.log('SMTP ready to send emails');
      });
    }

    function listen(portToTry) {
      const server = app.listen(portToTry, () => {
        console.log(`SaveABeat backend running on http://localhost:${portToTry}`);
        if (portToTry !== port) {
          console.warn(`Note: default port ${port} was busy. Update your frontend fetch calls if needed.`);
        }
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`Port ${portToTry} is in use, trying ${portToTry + 1}...`);
          listen(portToTry + 1);
        } else {
          throw err;
        }
      });
    }

    listen(port);

  } catch (error) {
    console.error('Failed to connect to MySQL. Check BackEnd/.env and schema setup.');
    process.exitCode = 1;
  }
}

start();
