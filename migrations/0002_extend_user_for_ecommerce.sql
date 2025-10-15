-- Migration number: 0002 	 2024-12-27T22:04:18.794Z
-- Extend user table for ecommerce functionality

ALTER TABLE user ADD COLUMN first_name TEXT;
ALTER TABLE user ADD COLUMN last_name TEXT;
ALTER TABLE user ADD COLUMN phone TEXT;
ALTER TABLE user ADD COLUMN role TEXT DEFAULT 'customer';
ALTER TABLE user ADD COLUMN avatar_url TEXT;
ALTER TABLE user ADD COLUMN last_login TIMESTAMP;
