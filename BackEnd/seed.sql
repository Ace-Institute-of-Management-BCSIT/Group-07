USE saveabeat_db;

-- =========================
-- ORGANIZATIONS (USERS)
-- =========================
INSERT INTO users (full_name, email, password_hash, phone, role, address, city, district) VALUES
('Bir Hospital', 'bir.admin@bloodcare.org.np', CONCAT('seed-bir:', SHA2(CONCAT('seed-bir:', 'Password@123'), 256)), '+977-1-4221119', 'org', 'Tundikhel Road, Kathmandu', 'Kathmandu', 'Kathmandu'),
('Red Cross Society', 'redcross.admin@bloodcare.org.np', CONCAT('seed-redcross:', SHA2(CONCAT('seed-redcross:', 'Password@123'), 256)), '+977-1-4270650', 'org', 'Kalimati, Kathmandu', 'Kathmandu', 'Kathmandu'),
('TU Teaching Hospital', 'tuth.admin@bloodcare.org.np', CONCAT('seed-tuth:', SHA2(CONCAT('seed-tuth:', 'Password@123'), 256)), '+977-1-4412303', 'org', 'Maharajgunj, Kathmandu', 'Kathmandu', 'Kathmandu'),
('Patan Hospital', 'patan.admin@bloodcare.org.np', CONCAT('seed-patan:', SHA2(CONCAT('seed-patan:', 'Password@123'), 256)), '+977-1-5522266', 'org', 'Lagankhel, Lalitpur', 'Lalitpur', 'Lalitpur');

-- =========================
-- ADMIN ACCOUNTS (USERS)
-- =========================
INSERT INTO users (full_name, email, password_hash, phone, role, address, city, district) VALUES
('Sulav Shrestha', 'sulav.admin@bloodcare.org.np', CONCAT('seed-sulav:', SHA2(CONCAT('seed-sulav:', 'Admin@12345'), 256)), '+977-9811111111', 'admin', 'Kathmandu, Nepal', 'Kathmandu', 'Kathmandu'),
('Deepesh Karki', 'deepesh.admin@bloodcare.org.np', CONCAT('seed-deepesh:', SHA2(CONCAT('seed-deepesh:', 'Admin@12345'), 256)), '+977-9822222222', 'admin', 'Lalitpur, Nepal', 'Lalitpur', 'Lalitpur'),
('Aryan Thapa', 'aryan.admin@bloodcare.org.np', CONCAT('seed-aryan:', SHA2(CONCAT('seed-aryan:', 'Admin@12345'), 256)), '+977-9833333333', 'admin', 'Bhaktapur, Nepal', 'Bhaktapur', 'Bhaktapur');

-- =========================
-- DONOR ACCOUNT (USER)
-- =========================
INSERT INTO users (full_name, email, password_hash, phone, role, address, city, district, profile_image_name, profile_image_data) VALUES
('Rajesh Kumar', 'rajesh.donor@bloodcare.org.np', CONCAT('seed-donor:', SHA2(CONCAT('seed-donor:', 'Password@123'), 256)), '+977-9800000000', 'donor', 'Lalitpur, Nepal', 'Lalitpur', 'Lalitpur', 'rajesh_profile.jpg', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDA...');

-- =========================
-- ORGANIZATIONS
-- =========================
INSERT INTO organizations (user_id, org_name, org_type, address, contact, verification_documents, verification_documents_name, building_photo, building_photo_name, verified) VALUES
(1, 'Bir Hospital Blood Center', 'hospital', 'Tundikhel Road, Kathmandu', '+977-1-4221119', 'base64_encoded_verification_document_1', 'bir_hospital_license.pdf', 'base64_encoded_building_photo_1', 'bir_hospital_building.jpg', TRUE),
(2, 'Red Cross Blood Bank', 'ngo', 'Kalimati, Kathmandu', '+977-1-4270650', 'base64_encoded_verification_document_2', 'redcross_registration.pdf', 'base64_encoded_building_photo_2', 'redcross_office.jpg', TRUE),
(3, 'TU Teaching Hospital Blood Center', 'hospital', 'Maharajgunj, Kathmandu', '+977-1-4412303', 'base64_encoded_verification_document_3', 'tu_hospital_license.pdf', 'base64_encoded_building_photo_3', 'tu_hospital_building.jpg', TRUE),
(4, 'Patan Hospital Blood Bank', 'hospital', 'Lagankhel, Lalitpur', '+977-1-5522266', 'base64_encoded_verification_document_4', 'patan_hospital_license.pdf', 'base64_encoded_building_photo_4', 'patan_hospital_building.jpg', TRUE);

-- =========================
-- ADMIN PROFILES
-- =========================
INSERT INTO admin_profiles (user_id, address) VALUES
(5, 'Kathmandu, Nepal'),
(6, 'Lalitpur, Nepal'),
(7, 'Bhaktapur, Nepal');

-- =========================
-- DONOR PROFILES
-- =========================
INSERT INTO donor_profiles (user_id, blood_group, is_available, last_donated_at, total_donations, profile_picture, profile_picture_name) VALUES
(8, 'A+', TRUE, '2025-05-18', 5, 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDA...', 'rajesh_profile.jpg');