psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
        CREATE USER docker;
        CREATE DATABASE docker;
        GRANT ALL PRIVILEGES ON DATABASE docker TO docker;
        \c docker

        SET timezone = 'Australia/Melbourne';

        CREATE TABLE period_lines (
                period_line_id text PRIMARY KEY,
                compass_person_id text NOT NULL,
                campus_guid text,
                description text,
                expected_minutes integer NOT NULL,
                start timestamptz NOT NULL,
                finish timestamptz NOT NULL,
                period_code text NOT NULL,
                prevalent_overall_status_id text NOT NULL,
                standard_class_shadow boolean,
                teaching_time boolean NOT NULL,
                updated_timestamp timestamptz NOT NULL
        );

        CREATE INDEX period_lines_compass_person_id_idx ON period_lines (compass_person_id);
        CREATE INDEX period_lines_updated_timestamp_idx ON period_lines (updated_timestamp);

        -- single-row table: only ever written after a sync fully completes,
        -- so a crashed/partial run can never poison the incremental watermark
        CREATE TABLE sync_state (
                id boolean PRIMARY KEY DEFAULT true CHECK (id),
                last_synced_timestamp timestamptz NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now()
        );

        -- full attendanceGetStatuses reference list, kept in sync so status-based
        -- filtering (e.g. schoolSystemExportIdentifier = '500' / "Unexplained") can
        -- happen in SQL instead of a live Compass call at report time
        CREATE TABLE statuses (
                status_id text PRIMARY KEY,
                name text NOT NULL,
                short_code text NOT NULL,
                short_name text NOT NULL,
                description text NOT NULL,
                school_system_export_identifier text NOT NULL,
                counted_absence boolean NOT NULL,
                parent_selectable boolean NOT NULL,
                staff_selectable boolean NOT NULL
        );
EOSQL