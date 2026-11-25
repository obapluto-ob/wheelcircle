CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL UNIQUE,
  webauthn_user_id text NOT NULL UNIQUE,
  trust_score integer NOT NULL DEFAULT 50,
  date_of_birth date,
  verification_consent_at timestamptz,
  identity_status text,
  identity_hash text UNIQUE,
  identity_last4 text,
  identity_name text,
  identity_name_mismatch boolean NOT NULL DEFAULT false,
  identity_source text,
  identity_provider text,
  identity_reference text,
  identity_checked_at timestamptz,
  identity_dob_match boolean,
  identity_phone_match boolean,
  identity_note text,
  identity_at timestamptz,
  identity_submitted_at timestamptz,
  identity_reviewed_by uuid,
  identity_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS verification_consent_at timestamptz;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_status text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_hash text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_last4 text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_name text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_name_mismatch boolean NOT NULL DEFAULT false;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_source text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_provider text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_reference text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_checked_at timestamptz;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_dob_match boolean;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_phone_match boolean;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_note text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_at timestamptz;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_submitted_at timestamptz;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_reviewed_by uuid;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS identity_reviewed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_identity_hash_idx ON app.users (identity_hash) WHERE identity_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.settings (
  id text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  admin_name text NOT NULL,
  target_user_id uuid NOT NULL,
  target_name text NOT NULL,
  action text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON app.admin_actions (created_at);

CREATE TABLE app.passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  credential_id text NOT NULL UNIQUE,
  public_key_jwk jsonb NOT NULL,
  rp_id text NOT NULL,
  sign_count integer NOT NULL DEFAULT 0,
  transports jsonb NOT NULL,
  label text NOT NULL DEFAULT 'Passkey',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_user_idx ON app.passkeys (user_id);

CREATE TABLE app.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  token_hash text NOT NULL UNIQUE,
  device_label text NOT NULL,
  user_agent text NOT NULL,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON app.sessions (user_id);
CREATE INDEX sessions_expires_idx ON app.sessions (expires_at);

CREATE TABLE app.recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  code_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON app.recovery_codes (user_id);

CREATE TABLE app.auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  user_id uuid REFERENCES app.users (id),
  challenge text NOT NULL,
  rp_id text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_user_idx ON app.auth_challenges (user_id);
CREATE INDEX auth_challenges_expires_idx ON app.auth_challenges (expires_at);

CREATE TABLE app.pending_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL,
  legal_name text,
  id_number text,
  date_of_birth date,
  verification_consent boolean NOT NULL DEFAULT false,
  webauthn_user_id text NOT NULL,
  challenge text NOT NULL,
  rp_id text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.pending_registrations ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE app.pending_registrations ADD COLUMN IF NOT EXISTS id_number text;
ALTER TABLE app.pending_registrations ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE app.pending_registrations ADD COLUMN IF NOT EXISTS verification_consent boolean NOT NULL DEFAULT false;
CREATE INDEX pending_registrations_phone_idx ON app.pending_registrations (phone);
CREATE INDEX pending_registrations_expires_idx ON app.pending_registrations (expires_at);

CREATE TABLE app.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limits_bucket_created_idx ON app.rate_limits (bucket, created_at);

CREATE TABLE app.wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES app.users (id),
  balance_minor integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  organizer_id uuid NOT NULL REFERENCES app.users (id),
  contribution_minor integer NOT NULL,
  max_members integer NOT NULL,
  organizer_fee_bps integer NOT NULL DEFAULT 100,
  bid_window_minutes integer NOT NULL DEFAULT 1440,
  contribution_window_hours integer NOT NULL DEFAULT 72,
  cycle_days integer NOT NULL DEFAULT 7,
  cadence text NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('weekly', 'fortnightly', 'monthly')),
  invite_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'forming',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX groups_organizer_idx ON app.groups (organizer_id);

CREATE TABLE app.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  seat_no integer NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  bond_bps integer NOT NULL DEFAULT 2500,
  trust_score integer NOT NULL DEFAULT 50,
  ontime_cycles integer NOT NULL DEFAULT 0,
  late_cycles integer NOT NULL DEFAULT 0,
  defaults integer NOT NULL DEFAULT 0,
  has_won boolean NOT NULL DEFAULT false,
  accepted_round integer NOT NULL DEFAULT 0,
  current_circle_id uuid,
  kyc_status text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id),
  UNIQUE (group_id, seat_no)
);
CREATE INDEX memberships_group_idx ON app.memberships (group_id);
CREATE INDEX memberships_user_idx ON app.memberships (user_id);

CREATE TABLE app.seat_swaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  from_membership_id uuid NOT NULL REFERENCES app.memberships (id),
  to_membership_id uuid NOT NULL REFERENCES app.memberships (id),
  from_seat integer NOT NULL,
  to_seat integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by_membership_id uuid REFERENCES app.memberships (id)
);
CREATE INDEX seat_swaps_group_idx ON app.seat_swaps (group_id, status);

CREATE TABLE app.guarantees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  member_membership_id uuid NOT NULL UNIQUE REFERENCES app.memberships (id),
  guarantor_membership_id uuid NOT NULL REFERENCES app.memberships (id),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  called_at timestamptz
);
CREATE INDEX guarantees_guarantor_idx ON app.guarantees (guarantor_membership_id);

CREATE TABLE app.circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  number integer NOT NULL,
  member_count integer NOT NULL,
  turns_total integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (group_id, number)
);
CREATE INDEX circles_group_idx ON app.circles (group_id);
ALTER TABLE app.memberships ADD CONSTRAINT memberships_current_circle_fk
  FOREIGN KEY (current_circle_id) REFERENCES app.circles (id);

CREATE TABLE app.cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES app.circles (id),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  number integer NOT NULL,
  member_count integer NOT NULL,
  contribution_minor integer NOT NULL,
  pot_expected_minor integer NOT NULL,
  pot_captured_minor integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'contributing',
  is_final boolean NOT NULL DEFAULT false,
  contribution_due_at timestamptz NOT NULL,
  auction_opens_at timestamptz,
  auction_closes_at timestamptz,
  scheduled_settle_at timestamptz,
  settled_at timestamptz,
  winner_membership_id uuid REFERENCES app.memberships (id),
  winning_discount_bps integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (circle_id, number)
);
CREATE INDEX cycles_group_idx ON app.cycles (group_id);
CREATE INDEX cycles_status_idx ON app.cycles (status);

CREATE TABLE app.contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES app.cycles (id),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  membership_id uuid NOT NULL REFERENCES app.memberships (id),
  amount_minor integer NOT NULL,
  late_fee_minor integer NOT NULL DEFAULT 0,
  total_minor integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  method text,
  provider_ref text,
  checkout_url text,
  checkout_expires_at timestamptz,
  covered_by_membership_id uuid REFERENCES app.memberships (id),
  cover_source text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, membership_id)
);
CREATE INDEX contributions_cycle_idx ON app.contributions (cycle_id);
CREATE INDEX contributions_membership_idx ON app.contributions (membership_id);

CREATE TABLE app.bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES app.cycles (id),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  membership_id uuid NOT NULL REFERENCES app.memberships (id),
  discount_bps integer NOT NULL DEFAULT 0,
  is_pass boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'sealed',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, membership_id)
);
CREATE INDEX bids_cycle_idx ON app.bids (cycle_id);

CREATE TABLE app.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL UNIQUE REFERENCES app.cycles (id),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  winner_membership_id uuid NOT NULL REFERENCES app.memberships (id),
  pot_minor integer NOT NULL,
  discount_bps integer NOT NULL,
  discount_minor integer NOT NULL,
  platform_fee_minor integer NOT NULL,
  organizer_fee_minor integer NOT NULL,
  organizer_waived_minor integer NOT NULL DEFAULT 0,
  fund_fee_minor integer NOT NULL,
  bond_target_minor integer NOT NULL DEFAULT 0,
  bond_hold_minor integer NOT NULL,
  winner_net_minor integer NOT NULL,
  waiter_count integer NOT NULL,
  waiter_share_minor integer NOT NULL,
  remainder_minor integer NOT NULL,
  is_final boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'held',
  release_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlements_group_idx ON app.settlements (group_id);

CREATE TABLE app.ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE,
  group_id uuid REFERENCES app.groups (id),
  cycle_id uuid REFERENCES app.cycles (id),
  user_id uuid REFERENCES app.users (id),
  membership_id uuid REFERENCES app.memberships (id),
  kind text NOT NULL,
  amount_minor integer NOT NULL,
  wallet_effect integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  memo text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_group_created_idx ON app.ledger (group_id, created_at);
CREATE INDEX ledger_user_created_idx ON app.ledger (user_id, created_at);
CREATE INDEX ledger_cycle_idx ON app.ledger (cycle_id);

CREATE TABLE app.bonds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  membership_id uuid NOT NULL REFERENCES app.memberships (id),
  settlement_id uuid NOT NULL UNIQUE REFERENCES app.settlements (id),
  amount_minor integer NOT NULL,
  held_minor integer NOT NULL,
  release_cycles_total integer NOT NULL,
  release_cycles_done integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'held',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX bonds_membership_idx ON app.bonds (membership_id);

CREATE TABLE app.bond_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bond_id uuid NOT NULL REFERENCES app.bonds (id),
  cycle_id uuid NOT NULL REFERENCES app.cycles (id),
  amount_minor integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bond_id, cycle_id)
);
CREATE INDEX bond_releases_bond_idx ON app.bond_releases (bond_id);

CREATE TABLE app.group_funds (
  group_id uuid PRIMARY KEY REFERENCES app.groups (id),
  balance_minor integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.fund_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE,
  group_id uuid NOT NULL REFERENCES app.groups (id),
  cycle_id uuid REFERENCES app.cycles (id),
  kind text NOT NULL,
  amount_minor integer NOT NULL,
  memo text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fund_entries_group_created_idx ON app.fund_entries (group_id, created_at);

CREATE TABLE app.payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES app.groups (id),
  cycle_id uuid REFERENCES app.cycles (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  membership_id uuid REFERENCES app.memberships (id),
  kind text NOT NULL,
  amount_minor integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  release_at timestamptz,
  provider text,
  provider_ref text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX payouts_user_created_idx ON app.payouts (user_id, created_at);
CREATE INDEX payouts_group_idx ON app.payouts (group_id);
CREATE INDEX payouts_provider_ref_idx ON app.payouts (provider_ref);

CREATE TABLE app.disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES app.groups (id),
  cycle_id uuid REFERENCES app.cycles (id),
  raised_by uuid NOT NULL REFERENCES app.users (id),
  against_user_id uuid REFERENCES app.users (id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX disputes_group_created_idx ON app.disputes (group_id, created_at);

CREATE TABLE app.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'paysasa',
  event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users (id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  session_id text NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT 'paysasa',
  status text NOT NULL DEFAULT 'pending',
  test_approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  expires_at timestamptz
);
ALTER TABLE app.wallet_topups ADD COLUMN IF NOT EXISTS test_approved boolean NOT NULL DEFAULT false;
CREATE INDEX wallet_topups_user_created_idx ON app.wallet_topups (user_id, created_at);
