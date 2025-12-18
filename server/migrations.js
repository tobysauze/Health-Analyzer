async function ensureAtLeastOneUser({ getDb, runDb, bcrypt, crypto, normalizeEmail }) {
  const row = await getDb('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  if (row?.id) return row.id;

  const email = normalizeEmail(process.env.ADMIN_EMAIL || 'owner@local');
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  const hash = await bcrypt.hash(password, 12);
  const r = await runDb('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
  console.log(`Created initial user: ${email}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Initial password (set ADMIN_PASSWORD to override): ${password}`);
  }
  return r.lastID;
}

async function columnExists({ allDb }, table, col) {
  const rows = await allDb(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === col);
}

async function addColumnIfMissing({ allDb, runDb }, table, col, defSql) {
  const exists = await columnExists({ allDb }, table, col);
  if (exists) return false;
  await runDb(`ALTER TABLE ${table} ADD COLUMN ${defSql}`);
  return true;
}

async function backfillUserId({ runDb }, table, userId) {
  await runDb(`UPDATE ${table} SET user_id = COALESCE(user_id, ?)`, [userId]);
}

async function initializeDatabase({ runDb }) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS sleep_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      score INTEGER,
      duration_hours REAL,
      deep_sleep_hours REAL,
      rem_sleep_hours REAL,
      bedtime TEXT,
      wake_time TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS activity_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      steps INTEGER,
      calories_burned INTEGER,
      heart_rate_avg INTEGER,
      active_minutes INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS nutrition_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      fiber_g REAL,
      sugar_g REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS food_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      food_name TEXT NOT NULL,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      serving_size TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS mood_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      mood_score INTEGER CHECK(mood_score >= 1 AND mood_score <= 10),
      energy_score INTEGER CHECK(energy_score >= 1 AND energy_score <= 10),
      stress_score INTEGER CHECK(stress_score >= 1 AND stress_score <= 10),
      anxiety_score INTEGER CHECK(anxiety_score >= 1 AND anxiety_score <= 10),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS supplements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      dosage TEXT,
      timing TEXT,
      notes TEXT,
      start_date TEXT,
      end_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS medications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      dosage TEXT,
      frequency TEXT,
      start_date TEXT,
      end_date TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS genetic_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      filename TEXT,
      data TEXT,
      analysis_results TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS correlations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      factor1 TEXT NOT NULL,
      factor2 TEXT NOT NULL,
      correlation_coefficient REAL,
      p_value REAL,
      sample_size INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS journal_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      journal_id INTEGER NOT NULL,
      mood_score INTEGER CHECK(mood_score >= 1 AND mood_score <= 10),
      energy_score INTEGER CHECK(energy_score >= 1 AND energy_score <= 10),
      stress_score INTEGER CHECK(stress_score >= 1 AND stress_score <= 10),
      anxiety_score INTEGER CHECK(anxiety_score >= 1 AND anxiety_score <= 10),
      sentiment REAL,
      tags TEXT,
      summary TEXT,
      extracted_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(journal_id) REFERENCES journal_entries(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS food_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS food_photo_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      photo_id INTEGER NOT NULL,
      dish_name TEXT,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      fiber_g REAL,
      sugar_g REAL,
      micronutrients_json TEXT,
      confidence REAL,
      extracted_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(photo_id) REFERENCES food_photos(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS workout_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('run','strength','other')),
      name TEXT,
      notes TEXT,
      duration_minutes REAL,
      distance_km REAL,
      pace_min_per_km REAL,
      calories INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS workout_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      session_id INTEGER NOT NULL,
      exercise TEXT NOT NULL,
      set_index INTEGER,
      reps INTEGER,
      weight_kg REAL,
      rpe REAL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES workout_sessions(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL COLLATE NOCASE,
      muscle_group TEXT,
      equipment TEXT,
      tags TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS body_composition (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      weight_kg REAL,
      body_fat_pct REAL,
      bmi REAL,
      hydration_pct REAL,
      muscle_mass_kg REAL,
      visceral_fat REAL,
      source TEXT,
      raw_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const stmt of tables) {
    try {
      await runDb(stmt);
    } catch (e) {
      // ignore create errors
    }
  }
}

async function runMigrations({ runDb, getDb, allDb, bcrypt, crypto, normalizeEmail }) {
  await runDb(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`);
  const row = await getDb('SELECT MAX(version) AS v FROM schema_migrations');
  let v = Number(row?.v || 0);

  if (v < 1) {
    const defaultUserId = await ensureAtLeastOneUser({ getDb, runDb, bcrypt, crypto, normalizeEmail });
    const userTables = [
      'sleep_data', 'activity_data', 'nutrition_data', 'food_log', 'mood_data',
      'supplements', 'medications', 'genetic_data', 'correlations',
      'journal_entries', 'journal_insights', 'food_photos', 'food_photo_insights',
      'workout_sessions', 'workout_sets', 'body_composition', 'exercises'
    ];

    for (const t of userTables) {
      try {
        await addColumnIfMissing({ allDb, runDb }, t, 'user_id', 'user_id INTEGER');
      } catch {}
    }
    for (const t of userTables) {
      try {
        await backfillUserId({ runDb }, t, defaultUserId);
      } catch {}
    }

    await runDb('INSERT INTO schema_migrations (version) VALUES (1)');
    v = 1;
  }

  if (v < 2) {
    await runDb('PRAGMA foreign_keys = OFF');

    const dayTables = ['sleep_data', 'activity_data', 'nutrition_data', 'mood_data', 'body_composition'];
    for (const t of dayTables) {
      try {
        await runDb(
          `DELETE FROM ${t}
            WHERE id NOT IN (
              SELECT MAX(id) FROM ${t} GROUP BY user_id, date
            )`
        );
      } catch {}
    }

    // exercises rebuild
    try {
      await runDb('ALTER TABLE exercises RENAME TO exercises_old');
      await runDb(
        `CREATE TABLE exercises (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          name TEXT NOT NULL COLLATE NOCASE,
          muscle_group TEXT,
          equipment TEXT,
          tags TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
      );
      await runDb(
        `INSERT INTO exercises (id, user_id, name, muscle_group, equipment, tags, updated_at, created_at)
         SELECT id, user_id, name, muscle_group, equipment, tags, updated_at, created_at
           FROM exercises_old`
      );
      await runDb('DROP TABLE exercises_old');
    } catch {}

    // journal_entries rebuild
    try {
      await runDb('ALTER TABLE journal_entries RENAME TO journal_entries_old');
      await runDb(
        `CREATE TABLE journal_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          date TEXT NOT NULL,
          title TEXT,
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
      );
      await runDb(
        `INSERT INTO journal_entries (id, user_id, date, title, content, created_at, updated_at)
         SELECT id, user_id, date, title, content, created_at, updated_at
           FROM journal_entries_old`
      );
      await runDb('DROP TABLE journal_entries_old');
    } catch {}

    // body_composition rebuild
    try {
      await runDb('ALTER TABLE body_composition RENAME TO body_composition_old');
      await runDb(
        `CREATE TABLE body_composition (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          date TEXT NOT NULL,
          weight_kg REAL,
          body_fat_pct REAL,
          bmi REAL,
          hydration_pct REAL,
          muscle_mass_kg REAL,
          visceral_fat REAL,
          source TEXT,
          raw_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
      );
      await runDb(
        `INSERT INTO body_composition (id, user_id, date, weight_kg, body_fat_pct, bmi, hydration_pct, muscle_mass_kg, visceral_fat, source, raw_json, created_at)
         SELECT id, user_id, date, weight_kg, body_fat_pct, bmi, hydration_pct, muscle_mass_kg, visceral_fat, source, raw_json, created_at
           FROM body_composition_old`
      );
      await runDb('DROP TABLE body_composition_old');
    } catch {}

    // exercises dedupe
    try {
      await runDb(
        `DELETE FROM exercises
          WHERE id NOT IN (
            SELECT MAX(id) FROM exercises GROUP BY user_id, name
          )`
      );
    } catch {}

    await runDb('DROP INDEX IF EXISTS idx_sleep_date').catch(() => {});
    await runDb('DROP INDEX IF EXISTS idx_activity_date').catch(() => {});
    await runDb('DROP INDEX IF EXISTS idx_nutrition_date').catch(() => {});
    await runDb('DROP INDEX IF EXISTS idx_mood_date').catch(() => {});

    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_sleep_user_date ON sleep_data(user_id, date)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_user_date ON activity_data(user_id, date)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_nutrition_user_date ON nutrition_data(user_id, date)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_mood_user_date ON mood_data(user_id, date)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_bodycomp_user_date ON body_composition(user_id, date)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_user_date ON journal_entries(user_id, date)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_user_name ON exercises(user_id, name)').catch(() => {});

    await runDb('PRAGMA foreign_keys = ON');

    await runDb('INSERT INTO schema_migrations (version) VALUES (2)');
    v = 2;
  }

  // v3: insights foundation tables (check-ins, biometrics, extracted events, weekly summaries)
  if (v < 3) {
    await runDb(
      `CREATE TABLE IF NOT EXISTS mood_checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        occurred_at DATETIME NOT NULL,
        mood_score INTEGER CHECK(mood_score >= 1 AND mood_score <= 10),
        energy_score INTEGER CHECK(energy_score >= 1 AND energy_score <= 10),
        stress_score INTEGER CHECK(stress_score >= 1 AND stress_score <= 10),
        anxiety_score INTEGER CHECK(anxiety_score >= 1 AND anxiety_score <= 10),
        notes TEXT,
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runDb(
      `CREATE TABLE IF NOT EXISTS biometric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        start_at DATETIME NOT NULL,
        end_at DATETIME,
        value_num REAL,
        unit TEXT,
        source TEXT,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runDb(
      `CREATE TABLE IF NOT EXISTS insight_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        occurred_at DATETIME,
        ref_table TEXT,
        ref_id INTEGER,
        extracted_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runDb(
      `CREATE TABLE IF NOT EXISTS weekly_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        week_start TEXT NOT NULL,
        summary_md TEXT,
        supporting_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runDb('CREATE INDEX IF NOT EXISTS idx_checkins_user_time ON mood_checkins(user_id, occurred_at)').catch(() => {});
    await runDb('CREATE INDEX IF NOT EXISTS idx_biometrics_user_type_time ON biometric_samples(user_id, type, start_at)').catch(() => {});
    await runDb('CREATE INDEX IF NOT EXISTS idx_events_user_time ON insight_events(user_id, occurred_at)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_user_week ON weekly_summaries(user_id, week_start)').catch(() => {});

    await runDb('INSERT INTO schema_migrations (version) VALUES (3)');
    v = 3;
  }

  // v4: API tokens for mobile clients (Bearer auth)
  if (v < 4) {
    await runDb(
      `CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        revoked_at DATETIME
      )`
    );
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)').catch(() => {});
    await runDb('CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)').catch(() => {});
    await runDb('INSERT INTO schema_migrations (version) VALUES (4)');
    v = 4;
  }

  // v5: Morning routine checklist (per-user items + per-day completion)
  if (v < 5) {
    await runDb(
      `CREATE TABLE IF NOT EXISTS routine_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await runDb(
      `CREATE TABLE IF NOT EXISTS routine_item_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 1,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(item_id) REFERENCES routine_items(id) ON DELETE CASCADE
      )`
    );

    await runDb('CREATE INDEX IF NOT EXISTS idx_routine_items_user_active ON routine_items(user_id, is_active, position)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_completion_unique ON routine_item_completions(user_id, date, item_id)').catch(() => {});
    await runDb('CREATE INDEX IF NOT EXISTS idx_routine_completion_user_date ON routine_item_completions(user_id, date)').catch(() => {});

    await runDb('INSERT INTO schema_migrations (version) VALUES (5)');
    v = 5;
  }

  // v6: Typed routine items + per-day values
  if (v < 6) {
    // Add metadata columns to routine_items (safe if already added)
    await addColumnIfMissing({ allDb, runDb }, 'routine_items', 'kind', `kind TEXT NOT NULL DEFAULT 'check'`).catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'routine_items', 'value_unit', `value_unit TEXT`).catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'routine_items', 'value_key', `value_key TEXT`).catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'routine_items', 'value_min', `value_min REAL`).catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'routine_items', 'value_max', `value_max REAL`).catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'routine_items', 'value_step', `value_step REAL`).catch(() => {});

    // Daily values per routine item
    await runDb(
      `CREATE TABLE IF NOT EXISTS routine_item_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        value_num REAL,
        value_text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(item_id) REFERENCES routine_items(id) ON DELETE CASCADE
      )`
    );

    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_values_unique ON routine_item_values(user_id, date, item_id)').catch(() => {});
    await runDb('CREATE INDEX IF NOT EXISTS idx_routine_values_user_date ON routine_item_values(user_id, date)').catch(() => {});

    await runDb('INSERT INTO schema_migrations (version) VALUES (6)');
    v = 6;
  }

  // v7: Extend body_composition for richer metrics (optional inputs from routine)
  if (v < 7) {
    const cols = [
      ['visceral_fat_index', 'visceral_fat_index REAL'],
      ['subcutaneous_fat_mass_kg', 'subcutaneous_fat_mass_kg REAL'],
      ['skeletal_muscle_mass_kg', 'skeletal_muscle_mass_kg REAL'],
      ['body_water_pct', 'body_water_pct REAL'],
      ['extracellular_water_kg', 'extracellular_water_kg REAL'],
      ['intracellular_water_kg', 'intracellular_water_kg REAL'],
      ['mineral_mass_kg', 'mineral_mass_kg REAL'],
      ['bone_mineral_content_kg', 'bone_mineral_content_kg REAL'],
      ['skeletal_mass_kg', 'skeletal_mass_kg REAL'],
      ['lean_mass_kg', 'lean_mass_kg REAL'],
      ['basal_metabolic_rate_kcal', 'basal_metabolic_rate_kcal REAL'],
      ['metabolic_age_years', 'metabolic_age_years REAL'],
      ['body_cell_mass_kg', 'body_cell_mass_kg REAL']
    ];

    for (const [col, defSql] of cols) {
      await addColumnIfMissing({ allDb, runDb }, 'body_composition', col, defSql).catch(() => {});
    }

    await runDb('INSERT INTO schema_migrations (version) VALUES (7)');
    v = 7;
  }

  // v8: Support multiple routines (morning/evening) via routine_id
  if (v < 8) {
    await runDb(
      `CREATE TABLE IF NOT EXISTS routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_user_key ON routines(user_id, key)').catch(() => {});

    await addColumnIfMissing({ allDb, runDb }, 'routine_items', 'routine_id', `routine_id INTEGER`).catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'routine_item_completions', 'routine_id', `routine_id INTEGER`).catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'routine_item_values', 'routine_id', `routine_id INTEGER`).catch(() => {});

    // Create default routines for each user and backfill existing items/rows to morning
    const userRows = await allDb('SELECT DISTINCT user_id AS user_id FROM routine_items');
    for (const ur of userRows) {
      const userId = ur.user_id;
      if (!userId) continue;

      await runDb(
        `INSERT INTO routines (user_id, key, title)
         VALUES (?, 'morning', 'Morning Routine')
         ON CONFLICT(user_id, key) DO NOTHING`,
        [userId]
      ).catch(() => {});
      await runDb(
        `INSERT INTO routines (user_id, key, title)
         VALUES (?, 'evening', 'Evening Routine')
         ON CONFLICT(user_id, key) DO NOTHING`,
        [userId]
      ).catch(() => {});

      const morning = await getDb('SELECT id FROM routines WHERE user_id = ? AND key = ? LIMIT 1', [userId, 'morning']);
      const morningId = morning?.id || null;
      if (!morningId) continue;

      await runDb(
        `UPDATE routine_items
            SET routine_id = COALESCE(routine_id, ?)
          WHERE user_id = ?`,
        [morningId, userId]
      ).catch(() => {});

      await runDb(
        `UPDATE routine_item_completions
            SET routine_id = COALESCE(routine_id, ?)
          WHERE user_id = ?`,
        [morningId, userId]
      ).catch(() => {});

      await runDb(
        `UPDATE routine_item_values
            SET routine_id = COALESCE(routine_id, ?)
          WHERE user_id = ?`,
        [morningId, userId]
      ).catch(() => {});
    }

    await runDb('CREATE INDEX IF NOT EXISTS idx_routine_items_user_routine ON routine_items(user_id, routine_id, is_active, position)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_completion_unique2 ON routine_item_completions(user_id, routine_id, date, item_id)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_values_unique2 ON routine_item_values(user_id, routine_id, date, item_id)').catch(() => {});

    await runDb('INSERT INTO schema_migrations (version) VALUES (8)');
    v = 8;
  }

  // v9: Replace checkbox "check" items with explicit yes/no values
  if (v < 9) {
    // Ensure values table exists (older DBs)
    await runDb(
      `CREATE TABLE IF NOT EXISTS routine_item_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        routine_id INTEGER,
        date TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        value_num REAL,
        value_text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(item_id) REFERENCES routine_items(id) ON DELETE CASCADE
      )`
    ).catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_values_unique2 ON routine_item_values(user_id, routine_id, date, item_id)').catch(() => {});

    // Convert existing completed checkboxes into yes values
    try {
      const rows = await allDb(
        `SELECT c.user_id, c.routine_id, c.date, c.item_id, c.completed_at
           FROM routine_item_completions c`
      );
      for (const r of rows) {
        // upsert value_text='yes'
        await runDb(
          `INSERT INTO routine_item_values (user_id, routine_id, date, item_id, value_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'yes', COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
           ON CONFLICT(user_id, routine_id, date, item_id) DO UPDATE SET
             value_text = 'yes',
             updated_at = CURRENT_TIMESTAMP`,
          [r.user_id, r.routine_id ?? null, r.date, r.item_id, r.completed_at ?? null]
        ).catch(() => {});
      }
    } catch {}

    // Flip kind from 'check' to 'yesno'
    await runDb(`UPDATE routine_items SET kind = 'yesno' WHERE kind = 'check'`).catch(() => {});

    await runDb('INSERT INTO schema_migrations (version) VALUES (9)');
    v = 9;
  }

  // v10: Garmin imports + richer daily metrics + external workout ids
  if (v < 10) {
    // activity_data: richer daily fields
    const activityCols = [
      ['distance_km', 'distance_km REAL'],
      ['floors_up', 'floors_up REAL'],
      ['floors_down', 'floors_down REAL'],
      ['calories_total', 'calories_total INTEGER'],
      ['calories_active', 'calories_active INTEGER'],
      ['calories_consumed', 'calories_consumed INTEGER'],
      ['stress_avg', 'stress_avg INTEGER'],
      ['spo2_avg', 'spo2_avg REAL'],
      ['spo2_min', 'spo2_min REAL'],
      ['rr_waking_avg', 'rr_waking_avg REAL'],
      ['body_battery_charged', 'body_battery_charged INTEGER'],
      ['body_battery_max', 'body_battery_max INTEGER'],
      ['body_battery_min', 'body_battery_min INTEGER'],
      ['hydration_intake', 'hydration_intake INTEGER'],
      ['hydration_goal', 'hydration_goal INTEGER'],
      ['source', 'source TEXT']
    ];
    for (const [col, defSql] of activityCols) {
      await addColumnIfMissing({ allDb, runDb }, 'activity_data', col, defSql).catch(() => {});
    }

    // sleep_data: mark source (manual/import/garmin/etc)
    await addColumnIfMissing({ allDb, runDb }, 'sleep_data', 'source', 'source TEXT').catch(() => {});

    // workout_sessions: external id + source so we can import Garmin activities without dupes
    await addColumnIfMissing({ allDb, runDb }, 'workout_sessions', 'source', 'source TEXT').catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'workout_sessions', 'external_id', 'external_id TEXT').catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'workout_sessions', 'raw_json', 'raw_json TEXT').catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'workout_sessions', 'avg_hr', 'avg_hr INTEGER').catch(() => {});
    await addColumnIfMissing({ allDb, runDb }, 'workout_sessions', 'max_hr', 'max_hr INTEGER').catch(() => {});

    // Avoid duplicate imports of samples and workouts
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_biometrics_user_type_source_time ON biometric_samples(user_id, type, source, start_at)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_user_source_external ON workout_sessions(user_id, source, external_id)').catch(() => {});

    await runDb('INSERT INTO schema_migrations (version) VALUES (10)');
    v = 10;
  }

  // v11: Expand Garmin daily + workout training metrics
  if (v < 11) {
    const moreActivityCols = [
      ['hr_min', 'hr_min INTEGER'],
      ['hr_max', 'hr_max INTEGER'],
      ['rhr', 'rhr INTEGER'],
      ['step_goal', 'step_goal INTEGER'],
      ['floors_goal', 'floors_goal REAL'],
      ['calories_goal', 'calories_goal INTEGER'],
      ['calories_bmr', 'calories_bmr INTEGER'],
      ['intensity_time_goal_minutes', 'intensity_time_goal_minutes REAL'],
      ['sweat_loss', 'sweat_loss INTEGER'],
      ['rr_max', 'rr_max REAL'],
      ['rr_min', 'rr_min REAL'],
      ['notes', 'notes TEXT']
    ];
    for (const [col, defSql] of moreActivityCols) {
      await addColumnIfMissing({ allDb, runDb }, 'activity_data', col, defSql).catch(() => {});
    }

    const workoutCols = [
      ['training_load', 'training_load REAL'],
      ['training_effect', 'training_effect REAL'],
      ['anaerobic_training_effect', 'anaerobic_training_effect REAL'],
      ['vo2_max', 'vo2_max REAL']
    ];
    for (const [col, defSql] of workoutCols) {
      await addColumnIfMissing({ allDb, runDb }, 'workout_sessions', col, defSql).catch(() => {});
    }

    await runDb('INSERT INTO schema_migrations (version) VALUES (11)');
    v = 11;
  }

  // v12: Lab / biomarker results (blood tests)
  if (v < 12) {
    await runDb(
      `CREATE TABLE IF NOT EXISTS lab_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        biomarker TEXT NOT NULL,
        value_num REAL,
        value_text TEXT,
        unit TEXT,
        ref_low REAL,
        ref_high REAL,
        notes TEXT,
        source TEXT,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ).catch(() => {});

    await runDb('CREATE INDEX IF NOT EXISTS idx_labs_user_date ON lab_results(user_id, date)').catch(() => {});
    await runDb('CREATE INDEX IF NOT EXISTS idx_labs_user_biomarker ON lab_results(user_id, biomarker)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_labs_user_date_biomarker ON lab_results(user_id, date, biomarker)').catch(() => {});

    await runDb('INSERT INTO schema_migrations (version) VALUES (12)');
    v = 12;
  }

  // v13: Supplement regimens + per-day overrides (assume taken unless overridden)
  if (v < 13) {
    await runDb(
      `CREATE TABLE IF NOT EXISTS supplement_regimens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        dose_value REAL,
        dose_unit TEXT,
        dose_text TEXT,
        frequency TEXT NOT NULL DEFAULT 'daily', -- daily | weekdays | custom
        days_of_week_json TEXT, -- e.g. [1,2,3,4,5] for Mon-Fri (optional)
        default_times_json TEXT, -- e.g. ["08:00","20:00"]
        start_date TEXT,
        end_date TEXT,
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ).catch(() => {});

    await runDb(
      `CREATE TABLE IF NOT EXISTS supplement_day_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        regimen_id INTEGER NOT NULL,
        taken INTEGER, -- 1 yes, 0 no
        time_text TEXT, -- HH:MM
        dose_value REAL,
        dose_unit TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(regimen_id) REFERENCES supplement_regimens(id) ON DELETE CASCADE
      )`
    ).catch(() => {});

    await runDb('CREATE INDEX IF NOT EXISTS idx_supp_regimens_user ON supplement_regimens(user_id, is_active, name)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_supp_override_unique ON supplement_day_overrides(user_id, date, regimen_id)').catch(() => {});

    // Best-effort backfill from legacy `supplements` rows into regimens
    try {
      const legacy = await allDb('SELECT * FROM supplements');
      for (const r of legacy) {
        if (!r?.user_id || !r?.name) continue;
        const timing = String(r.timing || '').toLowerCase();
        const times = [];
        if (timing.includes('morning')) times.push('08:00');
        if (timing.includes('evening') || timing.includes('night')) times.push('20:00');
        if (timing.includes('midday') || timing.includes('lunch')) times.push('12:30');
        const default_times_json = times.length ? JSON.stringify(times) : null;
        await runDb(
          `INSERT INTO supplement_regimens
            (user_id, name, dose_text, default_times_json, start_date, end_date, notes, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
          [
            r.user_id,
            r.name,
            r.dosage || null,
            default_times_json,
            r.start_date || null,
            r.end_date || null,
            r.notes || null,
            r.created_at || null
          ]
        ).catch(() => {});
      }
    } catch {}

    await runDb('INSERT INTO schema_migrations (version) VALUES (13)');
    v = 13;
  }

  // v14: Medication regimens + per-day overrides (assume taken unless overridden)
  if (v < 14) {
    await runDb(
      `CREATE TABLE IF NOT EXISTS medication_regimens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        dose_value REAL,
        dose_unit TEXT,
        dose_text TEXT,
        frequency TEXT NOT NULL DEFAULT 'daily', -- daily | weekdays | custom
        days_of_week_json TEXT,
        default_times_json TEXT, -- e.g. ["08:00","20:00"]
        start_date TEXT,
        end_date TEXT,
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ).catch(() => {});

    await runDb(
      `CREATE TABLE IF NOT EXISTS medication_day_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        regimen_id INTEGER NOT NULL,
        taken INTEGER, -- 1 yes, 0 no
        time_text TEXT, -- HH:MM
        dose_value REAL,
        dose_unit TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(regimen_id) REFERENCES medication_regimens(id) ON DELETE CASCADE
      )`
    ).catch(() => {});

    await runDb('CREATE INDEX IF NOT EXISTS idx_med_regimens_user ON medication_regimens(user_id, is_active, name)').catch(() => {});
    await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_med_override_unique ON medication_day_overrides(user_id, date, regimen_id)').catch(() => {});

    // Best-effort backfill from legacy `medications` rows into regimens
    try {
      const legacy = await allDb('SELECT * FROM medications');
      for (const r of legacy) {
        if (!r?.user_id || !r?.name) continue;
        const freqRaw = String(r.frequency || '').toLowerCase();
        const frequency = (freqRaw.includes('weekday') || freqRaw.includes('mon') || freqRaw.includes('tue') || freqRaw.includes('wed') || freqRaw.includes('thu') || freqRaw.includes('fri'))
          ? 'weekdays'
          : 'daily';
        const times = [];
        if (freqRaw.includes('morning') || freqRaw.includes('am')) times.push('08:00');
        if (freqRaw.includes('evening') || freqRaw.includes('night') || freqRaw.includes('pm')) times.push('20:00');
        if (freqRaw.includes('midday') || freqRaw.includes('noon') || freqRaw.includes('lunch')) times.push('12:30');
        const default_times_json = times.length ? JSON.stringify(times) : null;
        await runDb(
          `INSERT INTO medication_regimens
            (user_id, name, dose_text, frequency, default_times_json, start_date, end_date, notes, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
          [
            r.user_id,
            r.name,
            r.dosage || null,
            frequency,
            default_times_json,
            r.start_date || null,
            r.end_date || null,
            r.notes || null,
            r.created_at || null
          ]
        ).catch(() => {});
      }
    } catch {}

    await runDb('INSERT INTO schema_migrations (version) VALUES (14)');
    v = 14;
  }

  // v15: User daily calorie goal (kcal)
  if (v < 15) {
    try {
      await addColumnIfMissing({ allDb, runDb }, 'users', 'calorie_goal_kcal', 'calorie_goal_kcal INTEGER');
    } catch {}
    await runDb('INSERT INTO schema_migrations (version) VALUES (15)');
    v = 15;
  }

  // v16: Food log time (HH:MM)
  if (v < 16) {
    try {
      await addColumnIfMissing({ allDb, runDb }, 'food_log', 'time', 'time TEXT');
    } catch {}
    await runDb('INSERT INTO schema_migrations (version) VALUES (16)');
    v = 16;
  }
}

module.exports = {
  initializeDatabase,
  runMigrations
};

