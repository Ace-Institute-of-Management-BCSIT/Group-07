CREATE DATABASE IF NOT EXISTS saveabeat_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE saveabeat_db;

CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  role ENUM('donor', 'org', 'admin') NOT NULL DEFAULT 'donor',
  city VARCHAR(100),
  district VARCHAR(100),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS organizations (
  org_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  org_name VARCHAR(150) NOT NULL,
  org_type ENUM('hospital', 'ngo', 'clinic', 'individual') NOT NULL,
  address TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_organizations_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS donor_profiles (
  donor_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  last_donated_at DATE NULL,
  total_donations INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_donor_profiles_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS blood_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  blood_group ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') NOT NULL,
  units_needed INT NOT NULL,
  urgency ENUM('normal', 'urgent', 'critical') NOT NULL,
  status ENUM('open', 'fulfilled', 'expired', 'cancelled') NOT NULL DEFAULT 'open',
  city VARCHAR(100) NOT NULL,
  district VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NULL,
  CONSTRAINT fk_blood_requests_org
    FOREIGN KEY (org_id) REFERENCES organizations(org_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  notif_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  request_id INT NULL,
  type ENUM('match', 'broadcast', 'system') NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_notifications_request
    FOREIGN KEY (request_id) REFERENCES blood_requests(request_id)
    ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id INT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  request_id INT NULL,
  message_text TEXT NOT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_chat_messages_sender
    FOREIGN KEY (sender_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_chat_messages_receiver
    FOREIGN KEY (receiver_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_chat_messages_request
    FOREIGN KEY (request_id) REFERENCES blood_requests(request_id)
    ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS donation_responses (
  response_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  donor_id INT NOT NULL,
  status ENUM('pending', 'confirmed', 'rejected') NOT NULL DEFAULT 'pending',
  responded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at DATETIME NULL,
  CONSTRAINT fk_donation_responses_request
    FOREIGN KEY (request_id) REFERENCES blood_requests(request_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_donation_responses_donor
    FOREIGN KEY (donor_id) REFERENCES donor_profiles(donor_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS donation_history (
  history_id INT AUTO_INCREMENT PRIMARY KEY,
  donor_id INT NOT NULL,
  request_id INT NULL,
  donated_at DATE NOT NULL,
  units_donated INT NOT NULL,
  location VARCHAR(150) NOT NULL,
  CONSTRAINT fk_donation_history_donor
    FOREIGN KEY (donor_id) REFERENCES donor_profiles(donor_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_donation_history_request
    FOREIGN KEY (request_id) REFERENCES blood_requests(request_id)
    ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS center_listings (
  listing_id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL UNIQUE,
  display_name VARCHAR(150) NULL,
  phone VARCHAR(20) NOT NULL,
  hours VARCHAR(150) NOT NULL,
  distance_km DECIMAL(4,1) NOT NULL,
  availability ENUM('High', 'Medium', 'Low') NOT NULL,
  services TEXT NOT NULL,
  image_url TEXT NOT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  CONSTRAINT fk_center_listings_org
    FOREIGN KEY (org_id) REFERENCES organizations(org_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS blood_drive_listings (
  event_id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  event_date DATE NOT NULL,
  time_range VARCHAR(50) NOT NULL,
  location VARCHAR(150) NOT NULL,
  distance_km DECIMAL(4,1) NOT NULL,
  spots_total INT NOT NULL,
  spots_available INT NOT NULL,
  event_type ENUM('Drive', 'Camp', 'Emergency') NOT NULL,
  image_url TEXT NOT NULL,
  CONSTRAINT fk_blood_drive_listings_org
    FOREIGN KEY (org_id) REFERENCES organizations(org_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;
