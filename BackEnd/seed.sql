USE saveabeat_db;

INSERT INTO users (full_name, email, password_hash, phone, role, city, district) VALUES
('Bir Hospital Admin', 'bir.admin@bloodcare.org.np', CONCAT('seed-bir:', SHA2(CONCAT('seed-bir', 'Password123!'), 256)), '+977-1-4221119', 'org', 'Kathmandu', 'Kathmandu'),
('Red Cross Admin', 'redcross.admin@bloodcare.org.np', CONCAT('seed-redcross:', SHA2(CONCAT('seed-redcross', 'Password123!'), 256)), '+977-1-4270650', 'org', 'Kathmandu', 'Kathmandu'),
('TU Teaching Hospital Admin', 'tuth.admin@bloodcare.org.np', CONCAT('seed-tuth:', SHA2(CONCAT('seed-tuth', 'Password123!'), 256)), '+977-1-4412303', 'org', 'Kathmandu', 'Kathmandu'),
('Patan Hospital Admin', 'patan.admin@bloodcare.org.np', CONCAT('seed-patan:', SHA2(CONCAT('seed-patan', 'Password123!'), 256)), '+977-1-5522266', 'org', 'Lalitpur', 'Lalitpur'),
('Sample Donor', 'donor.demo@bloodcare.org.np', CONCAT('seed-donor:', SHA2(CONCAT('seed-donor', 'Password123!'), 256)), '+977-9800000000', 'donor', 'Lalitpur', 'Lalitpur');

INSERT INTO organizations (user_id, org_name, org_type, address, verified) VALUES
(1, 'Bir Hospital Blood Center', 'hospital', 'Tundikhel Road, Kathmandu', TRUE),
(2, 'Red Cross Blood Bank', 'ngo', 'Kalimati, Kathmandu', TRUE),
(3, 'Tribhuvan University Teaching Hospital', 'hospital', 'Maharajgunj, Kathmandu', TRUE),
(4, 'Patan Hospital Blood Bank', 'hospital', 'Lagankhel, Lalitpur', TRUE);

INSERT INTO donor_profiles (user_id, blood_group, is_available, last_donated_at, total_donations) VALUES
(5, 'A+', TRUE, '2025-05-18', 3);

INSERT INTO blood_requests (org_id, blood_group, units_needed, urgency, status, city, district, created_at, expires_at) VALUES
(1, 'A+', 12, 'urgent', 'open', 'Kathmandu', 'Kathmandu', '2025-09-10 08:30:00', '2025-09-17 18:00:00'),
(2, 'O+', 20, 'critical', 'open', 'Kathmandu', 'Kathmandu', '2025-09-11 09:00:00', '2025-09-14 18:00:00'),
(3, 'B-', 6, 'normal', 'fulfilled', 'Kathmandu', 'Kathmandu', '2025-09-01 10:15:00', '2025-09-08 18:00:00');

INSERT INTO notifications (user_id, request_id, type, message, is_read, sent_at) VALUES
(5, 1, 'match', 'A+ request available near you at Bir Hospital Blood Center.', FALSE, '2025-09-10 09:00:00'),
(5, 2, 'broadcast', 'Critical O+ request needs immediate donors in Kathmandu.', FALSE, '2025-09-11 09:30:00');

INSERT INTO chat_messages (sender_id, receiver_id, request_id, message_text, sent_at, is_read) VALUES
(5, 1, 1, 'I am available to help with this request.', '2025-09-10 09:15:00', FALSE),
(1, 5, 1, 'Thank you. Please confirm your availability.', '2025-09-10 09:25:00', FALSE);

INSERT INTO donation_responses (request_id, donor_id, status, responded_at, confirmed_at) VALUES
(1, 1, 'confirmed', '2025-09-10 09:40:00', '2025-09-10 10:00:00');

INSERT INTO donation_history (donor_id, request_id, donated_at, units_donated, location) VALUES
(1, 3, '2025-05-18', 1, 'Tribhuvan University Teaching Hospital');

INSERT INTO center_listings (org_id, display_name, phone, hours, distance_km, availability, services, image_url, latitude, longitude) VALUES
(1, 'Bir Hospital Blood Center', '+977-1-4221119', 'Mon-Fri: 8AM-6PM, Sat: 9AM-3PM', 2.3, 'High', 'Whole Blood|Platelets|Plasma|Power Red', 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?w=400&auto=format&fit=crop&q=70', 27.7046, 85.3077),
(2, 'Red Cross Blood Bank', '+977-1-4270650', 'Mon-Sat: 8AM-5PM', 3.1, 'Medium', 'Whole Blood|Platelets|Plasma', 'https://images.unsplash.com/photo-1579154204601-01588f351e67?w=400&auto=format&fit=crop&q=70', 27.7000, 85.3200),
(3, 'Tribhuvan University Teaching Hospital', '+977-1-4412303', '24/7 Emergency Services', 4.2, 'Low', 'Whole Blood|Emergency Collection', 'https://images.unsplash.com/photo-1586773860418-d37222d8fce3?w=400&auto=format&fit=crop&q=70', 27.7359, 85.3372),
(4, 'Patan Hospital Blood Bank', '+977-1-5522266', 'Mon-Sat: 10AM-5PM', 5.8, 'High', 'Whole Blood|Platelets', 'https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=400&auto=format&fit=crop&q=70', 27.6727, 85.3188);

INSERT INTO blood_drive_listings (org_id, title, event_date, time_range, location, distance_km, spots_total, spots_available, event_type, image_url) VALUES
(1, 'Bir Hospital Blood Drive', '2025-09-15', '9:00 AM – 5:00 PM', 'Bir Hospital', 2.3, 100, 45, 'Drive', 'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?w=600&auto=format&fit=crop&q=70'),
(2, 'Community Blood Camp', '2025-09-20', '10:00 AM – 4:00 PM', 'Patan Durbar Square', 4.1, 80, 23, 'Camp', 'https://images.unsplash.com/photo-1579154204601-01588f351e67?w=600&auto=format&fit=crop&q=70'),
(3, 'Emergency Blood Collection', '2025-09-12', '8:00 AM – 8:00 PM', 'TU Teaching Hospital', 1.8, 50, 12, 'Emergency', 'https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=600&auto=format&fit=crop&q=70'),
(4, 'University Blood Drive', '2025-09-25', '11:00 AM – 6:00 PM', 'Tribhuvan University', 6.5, 120, 67, 'Drive', 'https://images.unsplash.com/photo-1582719471384-894fbb16e074?w=600&auto=format&fit=crop&q=70');
