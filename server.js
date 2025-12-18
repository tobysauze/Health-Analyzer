// Load environment variables
require('dotenv').config(); // .env (if present)
require('dotenv').config({ path: 'env.local', override: true }); // local override (recommended)

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const GarminParser = require('./garmin-parser');
const crypto = require('crypto');
const readline = require('readline');
const yauzl = require('yauzl');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const bcrypt = require('bcryptjs');
const os = require('os');
const { spawn } = require('child_process');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const { attachAuthRateLimit, attachApiAuthGuard, registerAuthRoutes } = require('./server/auth');
const { initializeDatabase, runMigrations } = require('./server/migrations');
const { extractJournalSignalsLLM, generateMarkdownLLM, analyzeFoodPackagingLLM, estimateFoodFromTextLLM } = require('./server/llm');
const { startOfWeekMonday, parseIsoDate, computeWeekRollup } = require('./server/insights');

// Global handles so both SQLite and Postgres modes can access them
let db = null;
let pgPool = null;
let serverHandle = null;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// Security headers (safe defaults)
app.use(helmet({
  contentSecurityPolicy: false // static inline scripts/styles exist; we can harden later
}));

// If deployed behind a proxy (Render/Heroku/Nginx), allow secure cookies
app.set('trust proxy', 1);

// CORS: for public hosting, prefer same-origin. If needed, set CORS_ORIGIN.
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) : [];
app.use(corsOrigin.length ? cors({ origin: corsOrigin, credentials: true }) : cors());

app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
// IMPORTANT: Do not serve uploads statically in a public deployment.
// We serve files via authenticated endpoints instead.

// Sessions (cookie-based)
const SQLiteStore = SQLiteStoreFactory(session);
const PgSession = require('connect-pg-simple')(session);

// Persist session secret across restarts (so "remember me" actually works)
const SESSION_SECRET_PATH = path.join(process.cwd(), 'session-secret.local');
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  try {
    if (fs.existsSync(SESSION_SECRET_PATH)) {
      sessionSecret = String(fs.readFileSync(SESSION_SECRET_PATH, 'utf8')).trim();
    }
  } catch {}
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(SESSION_SECRET_PATH, sessionSecret + '\n', { mode: 0o600 });
    } catch {}
  }
}

// We consider Postgres/Supabase "on" if either DATABASE_URL or PGHOST is defined.
// Prefer the discrete PG* vars when available to avoid URL parsing issues.
const USE_PG = !!(process.env.PGHOST || process.env.DATABASE_URL);

// Build Postgres Pool config for sessions (same logic as main DB pool below)
function buildPgPoolConfig() {
  if (process.env.PGHOST) {
    return {
      host: process.env.PGHOST,
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'postgres',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      ssl: { rejectUnauthorized: false }
    };
  }
  // Fallback to DATABASE_URL if PGHOST not set
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  };
}

const sessionStore = USE_PG
  ? new PgSession({
      pool: new Pool(buildPgPoolConfig()),
      tableName: 'sessions'
    })
  : new SQLiteStore({
      db: process.env.SESSION_DB || 'sessions.sqlite',
      dir: process.cwd(),
      table: 'sessions'
    });

app.use(session({
  store: sessionStore,
  name: process.env.SESSION_COOKIE_NAME || 'ha.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true, // refresh expiry on activity
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 90 // 90 days
  }
}));

// CSRF protection (session-based). Frontend fetches token via GET /api/auth/csrf.
const csrfProtection = csrf({ cookie: false });
app.use((req, res, next) => {
  // Only protect state-changing methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Mobile clients using Bearer tokens should not require CSRF
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return next();
  // Mobile login is cookie-less and should not require CSRF
  if (req.path === '/api/auth/mobile-login') return next();
  return csrfProtection(req, res, next);
});

// Auth-related rate limiting + API auth guard
attachAuthRateLimit(app);
attachApiAuthGuard(app, { getDb, runDb });

function safeExtFromName(original) {
  const ext = path.extname(original || '').toLowerCase();
  // Keep a conservative allowlist; default to .bin
  const allowed = ['.csv', '.xlsx', '.xls', '.tcx', '.gpx', '.xml', '.json', '.txt'];
  return allowed.includes(ext) ? ext : '.bin';
}

function randomUploadName(originalName) {
  const ext = safeExtFromName(originalName);
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

// Configure multer for non-public uploads (imports, files that are deleted after processing)
const tmpStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/tmp/');
  },
  filename: function (req, file, cb) {
    cb(null, randomUploadName(file.originalname));
  }
});

const upload = multer({ 
  storage: tmpStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for Excel files
  fileFilter: function (req, file, cb) {
    // Accept CSV and Excel files
    const allowedExtensions = ['.csv', '.xlsx', '.xls'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a CSV or Excel file (.csv, .xlsx, .xls)'));
    }
  }
});

// Configure multer for Garmin file uploads (accepts more formats)
const garminUpload = multer({ 
  storage: tmpStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for Garmin files
  fileFilter: function (req, file, cb) {
    // Accept Garmin file formats: CSV, TCX, GPX, Excel
    const allowedExtensions = ['.csv', '.xlsx', '.xls', '.tcx', '.gpx'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a Garmin file (.csv, .xlsx, .xls, .tcx, .gpx)'));
    }
  }
});

// Configure multer for food photo uploads
const photoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/photos/');
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'].includes(ext) ? ext : '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
  }
});

const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'];
    if (allowed.includes(ext) || (file.mimetype || '').startsWith('image/')) cb(null, true);
    else cb(new Error('Invalid file type. Please upload an image.'));
  }
});

// Configure multer for BodyPod/Hume CSV uploads
const bodyCompUpload = multer({
  storage: tmpStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.csv', '.xlsx', '.xls'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Invalid file type. Please upload a CSV or Excel file.'));
  }
});

// Configure multer for lab/blood test uploads
const labsUpload = multer({
  storage: tmpStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.csv', '.xlsx', '.xls'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Invalid file type. Please upload a CSV or Excel file.'));
  }
});

// Configure multer for Apple Health export.xml uploads
const appleHealthUpload = multer({
  storage: tmpStorage,
  limits: { fileSize: 600 * 1024 * 1024 }, // 600MB (Apple exports can be large)
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.xml') cb(null, true);
    else cb(new Error('Invalid file type. Please upload Apple Health export.xml (.xml)'));
  }
});

// Configure multer for Android exports (Google Takeout ZIP or extracted CSV)
const androidHealthUpload = multer({
  storage: tmpStorage,
  limits: { fileSize: 1000 * 1024 * 1024 }, // up to 1GB
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.zip', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('Invalid file type. Please upload a .zip or .csv file'));
  }
});

// Initialize database (SQLite locally, Postgres in production when DATABASE_URL is set)
// SQLite DB path (used only when not running against Postgres)
const DB_PATH = process.env.DB_PATH || process.env.HEALTH_DB || 'health_data.db';
if (!USE_PG) {
  try {
    // Ensure DB parent directory exists when using a path like /data/health_data.db
    const dir = path.dirname(DB_PATH);
    if (dir && dir !== '.' && dir !== '/') fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

// Ensure upload directories exist (required for multer destinations)
try { fs.mkdirSync(path.join(process.cwd(), 'uploads', 'tmp'), { recursive: true }); } catch {}
try { fs.mkdirSync(path.join(process.cwd(), 'uploads', 'photos'), { recursive: true }); } catch {}

if (USE_PG) {
  if (process.env.PGHOST) {
    pgPool = new Pool({
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      database: process.env.PGDATABASE || 'postgres',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD,
      ssl: { rejectUnauthorized: false }
    });
    console.log('Using Supabase/Postgres via discrete PG* environment variables');
  } else {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    console.log('Using Supabase/Postgres via DATABASE_URL');
  }
  // In Postgres mode we assume the schema already exists in the remote DB.
  bootstrap().catch((e) => {
    console.error('Fatal bootstrap error (Postgres mode):', e.message);
    process.exit(1);
  });
} else {
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('Error opening database:', err.message);
    } else {
      console.log('Connected to SQLite database', DB_PATH);
      // Bootstrap in the background; server will start after migrations complete.
      bootstrap().catch((e) => {
        console.error('Fatal bootstrap error:', e.message);
        process.exit(1);
      });
    }
  });
}

// Legacy schema init (kept temporarily during refactor)
async function _initializeDatabaseLegacy() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS sleep_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      date TEXT NOT NULL,
      steps INTEGER,
      calories_burned INTEGER,
      heart_rate_avg INTEGER,
      active_minutes INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS nutrition_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      filename TEXT,
      data TEXT,
      analysis_results TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS correlations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      date TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS food_photo_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

    // Exercise library (used by Fitness page) - per user
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
    ,
    // Product catalog (barcode-first)
    `CREATE TABLE IF NOT EXISTS products (
      gtin TEXT PRIMARY KEY,
      name TEXT,
      brand TEXT,
      retailer TEXT,
      image_url TEXT,
      ingredients TEXT,
      serving_size TEXT,
      source TEXT,
      source_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS product_nutrition (
      gtin TEXT PRIMARY KEY,
      calories_kcal_100g REAL,
      protein_g_100g REAL,
      carbs_g_100g REAL,
      fat_g_100g REAL,
      fiber_g_100g REAL,
      sugar_g_100g REAL,
      salt_g_100g REAL,
      saturated_fat_g_100g REAL,
      sodium_mg_100g REAL,
      micronutrients_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(gtin) REFERENCES products(gtin) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gtin TEXT NOT NULL,
      image_url TEXT,
      local_path TEXT,
      kind TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(gtin) REFERENCES products(gtin) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS product_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gtin TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      source_url TEXT,
      raw_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(gtin) REFERENCES products(gtin) ON DELETE CASCADE
    )`
  ];

  for (const table of tables) {
    try {
      await runDb(table);
    } catch (err) {
      // If the DB already contains duplicate dates, creating UNIQUE indexes will fail.
      // We keep the server running and surface a clearer warning (dedupe is handled by migrations).
      const stmt = String(table || '').trim().toUpperCase();
      const isUniqueIndex = stmt.startsWith('CREATE UNIQUE INDEX');
      if (isUniqueIndex && err.code === 'SQLITE_CONSTRAINT') {
        console.warn('Skipping UNIQUE index due to existing duplicate rows:', err.message);
        continue;
      }
      console.error('Error applying schema statement:', err.message);
    }
  }
}

// Simple helper to convert "?" placeholders to Postgres-style "$1, $2, ..."
function toPgParams(sql, params) {
  let i = 0;
  const text = sql.replace(/\?/g, () => {
    i += 1;
    return `$${i}`;
  });
  return { text, values: params };
}

function runDb(sql, params = []) {
  if (USE_PG) {
    let { text, values } = toPgParams(sql, params);
    // Automatically add RETURNING id for INSERT statements to get lastID
    if (/^\s*INSERT\s+INTO\s+/i.test(text) && !/RETURNING\s+/i.test(text)) {
      text = text.replace(/;?\s*$/, ' RETURNING id');
    }
    return pgPool.query(text, values).then(res => ({
      lastID: res.rows?.[0]?.id ?? null,
      changes: res.rowCount
    }));
  }
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getDb(sql, params = []) {
  if (USE_PG) {
    const { text, values } = toPgParams(sql, params);
    return pgPool.query(text, values).then(res => res.rows[0] || null);
  }
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allDb(sql, params = []) {
  if (USE_PG) {
    const { text, values } = toPgParams(sql, params);
    return pgPool.query(text, values).then(res => res.rows);
  }
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function ensureAtLeastOneUser() {
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

async function columnExists(table, col) {
  const rows = await allDb(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === col);
}

async function addColumnIfMissing(table, col, defSql) {
  const exists = await columnExists(table, col);
  if (exists) return false;
  await runDb(`ALTER TABLE ${table} ADD COLUMN ${defSql}`);
  return true;
}

async function backfillUserId(table, userId) {
  await runDb(`UPDATE ${table} SET user_id = COALESCE(user_id, ?)`, [userId]);
}

async function _runMigrationsLegacy() {
  await runDb(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`);
  const row = await getDb('SELECT MAX(version) AS v FROM schema_migrations');
  let v = Number(row?.v || 0);

  // v1: add user_id columns (per-user data isolation)
  if (v < 1) {
    const defaultUserId = await ensureAtLeastOneUser();

    const userTables = [
      'sleep_data',
      'activity_data',
      'nutrition_data',
      'food_log',
      'mood_data',
      'supplements',
      'medications',
      'genetic_data',
      'correlations',
      'journal_entries',
      'journal_insights',
      'food_photos',
      'food_photo_insights',
      'workout_sessions',
      'workout_sets',
      'body_composition',
      'products',
      'product_nutrition',
      'product_images',
      'product_sources',
      'integrations',
      'exercises'
    ];

    for (const t of userTables) {
      try {
        await addColumnIfMissing(t, 'user_id', 'user_id INTEGER');
      } catch (e) {
        // ignore if table doesn't exist in older schema
      }
    }

    for (const t of userTables) {
      try {
        await backfillUserId(t, defaultUserId);
      } catch (e) {
        // ignore
      }
    }

    await runDb('INSERT INTO schema_migrations (version) VALUES (1)');
    v = 1;
  }

  // v2: dedupe day-based tables and add composite unique indexes (user_id, date),
  // and rebuild tables that had global UNIQUE constraints.
  if (v < 2) {
    // Temporarily disable FK checks during table rebuilds
    await runDb('PRAGMA foreign_keys = OFF');

    // Dedupe day-based tables (keep newest row per user+date)
    const dayTables = ['sleep_data', 'activity_data', 'nutrition_data', 'mood_data', 'body_composition'];
    for (const t of dayTables) {
      try {
        await runDb(
          `DELETE FROM ${t}
            WHERE id NOT IN (
              SELECT MAX(id) FROM ${t} GROUP BY user_id, date
            )`
        );
      } catch (e) {
        // ignore
      }
    }

    // Rebuild exercises to remove global UNIQUE(name)
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
    } catch (e) {
      // ignore if already rebuilt
    }

    // Rebuild journal_entries to remove global UNIQUE(date)
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
    } catch (e) {
      // ignore if already rebuilt
    }

    // Rebuild body_composition to remove global UNIQUE(date)
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
    } catch (e) {
      // ignore if already rebuilt
    }

    // Dedupe exercises per user+name (keep newest)
    try {
      await runDb(
        `DELETE FROM exercises
          WHERE id NOT IN (
            SELECT MAX(id) FROM exercises GROUP BY user_id, name
          )`
      );
    } catch (e) {
      // ignore
    }

    // Drop old single-column unique indexes (if present)
    await runDb('DROP INDEX IF EXISTS idx_sleep_date').catch(() => {});
    await runDb('DROP INDEX IF EXISTS idx_activity_date').catch(() => {});
    await runDb('DROP INDEX IF EXISTS idx_nutrition_date').catch(() => {});
    await runDb('DROP INDEX IF EXISTS idx_mood_date').catch(() => {});

    // Create composite unique indexes
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
}

function reqUserId(req) {
  return req.session?.user?.id || req.authUser?.id;
}

async function bootstrap() {
  // In Postgres/Supabase mode we assume schema is managed via migrations in the DB itself.
  // SQLite mode keeps the existing automatic schema migration behavior.
  if (!USE_PG) {
    await initializeDatabase({ runDb });
    await runMigrations({ runDb, getDb, allDb, bcrypt, crypto, normalizeEmail });
  }

  serverHandle = app.listen(PORT, () => {
    console.log(`Health Analytics Dashboard running on http://localhost:${PORT}`);
  });
}

function clampInt(val, min, max) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return Math.min(max, Math.max(min, r));
}

function normalizeExerciseName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function safeJsonParse(v, fallback) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function normalizeRoutineTitle(title) {
  return String(title || '').trim().replace(/\s+/g, ' ');
}

function isIsoDateOnly(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isTimeHHMM(s) {
  return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
}

async function ensureRoutineId({ userId, routineKey }) {
  const key = (routineKey || 'morning').toString().trim().toLowerCase();
  const allowed = new Set(['morning', 'evening']);
  const finalKey = allowed.has(key) ? key : 'morning';
  const title = finalKey === 'evening' ? 'Evening Routine' : 'Morning Routine';
  await runDb(
    `CREATE TABLE IF NOT EXISTS routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ).catch(() => {});
  await runDb('CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_user_key ON routines(user_id, key)').catch(() => {});
  await runDb(
    `INSERT INTO routines (user_id, key, title)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET title = excluded.title, updated_at = CURRENT_TIMESTAMP`,
    [userId, finalKey, title]
  );
  const row = await getDb('SELECT id FROM routines WHERE user_id = ? AND key = ? LIMIT 1', [userId, finalKey]);
  return { routineKey: finalKey, routineId: row?.id || null };
}

async function upsertBodyCompByDate({ userId, date, patch, source }) {
  const existing = await getDb('SELECT id FROM body_composition WHERE user_id = ? AND date = ? LIMIT 1', [userId, date]);
  const keys = Object.keys(patch || {});
  if (!keys.length) return;

  const colMap = {
    weight_kg: 'weight_kg',
    bmi: 'bmi',
    visceral_fat: 'visceral_fat',
    hydration_pct: 'hydration_pct',
    muscle_mass_kg: 'muscle_mass_kg',
    visceral_fat_index: 'visceral_fat_index',
    subcutaneous_fat_mass_kg: 'subcutaneous_fat_mass_kg',
    skeletal_muscle_mass_kg: 'skeletal_muscle_mass_kg',
    body_water_pct: 'body_water_pct',
    extracellular_water_kg: 'extracellular_water_kg',
    intracellular_water_kg: 'intracellular_water_kg',
    mineral_mass_kg: 'mineral_mass_kg',
    bone_mineral_content_kg: 'bone_mineral_content_kg',
    skeletal_mass_kg: 'skeletal_mass_kg',
    lean_mass_kg: 'lean_mass_kg',
    basal_metabolic_rate_kcal: 'basal_metabolic_rate_kcal',
    metabolic_age_years: 'metabolic_age_years',
    body_cell_mass_kg: 'body_cell_mass_kg'
  };

  const sets = [];
  const params = [];
  for (const k of keys) {
    const col = colMap[k];
    if (!col) continue;
    sets.push(`${col} = COALESCE(?, ${col})`);
    params.push(patch[k]);
  }
  if (!sets.length) return;

  if (existing?.id) {
    await runDb(
      `UPDATE body_composition
          SET ${sets.join(', ')},
              source = COALESCE(source, ?)
        WHERE id = ? AND user_id = ?`,
      [...params, source || 'routine', existing.id, userId]
    );
  } else {
    // Insert with known columns only (others default null)
    const cols = ['user_id', 'date', 'source'];
    const qs = ['?', '?', '?'];
    const vals = [userId, date, source || 'routine'];
    for (const k of keys) {
      const col = colMap[k];
      if (!col) continue;
      cols.push(col);
      qs.push('?');
      vals.push(patch[k]);
    }
    await runDb(`INSERT INTO body_composition (${cols.join(', ')}) VALUES (${qs.join(', ')})`, vals);
  }
}

async function upsertSleepByDate({ userId, date, patch }) {
  const existing = await getDb('SELECT id FROM sleep_data WHERE user_id = ? AND date = ? LIMIT 1', [userId, date]);
  if (existing?.id) {
    await runDb(
      `UPDATE sleep_data
          SET score = COALESCE(?, score),
              wake_time = COALESCE(?, wake_time)
        WHERE id = ? AND user_id = ?`,
      [patch.score ?? null, patch.wake_time ?? null, existing.id, userId]
    );
  } else {
    await runDb(
      `INSERT INTO sleep_data (user_id, date, score, wake_time)
       VALUES (?, ?, ?, ?)`,
      [userId, date, patch.score ?? null, patch.wake_time ?? null]
    );
  }
}

async function insertBiometricSample({ userId, type, date, value_num, unit, source }) {
  const start_at = `${date}T07:00:00.000Z`; // deterministic placeholder time; can be refined later
  await runDb(
    `INSERT INTO biometric_samples (user_id, type, start_at, end_at, value_num, unit, source, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, type, start_at, start_at, value_num, unit || null, source || 'routine', null]
  );
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function coerceIsoDate(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  if (typeof v === 'number') {
    // unix seconds/ms heuristic
    const ms = v > 10_000_000_000 ? v : v * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  return null;
}

function parseHHMMSSToMinutes(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  // common sqlite TIME string from GarminDB: HH:MM:SS or HH:MM:SS.ffffff
  // Example: 06:54:00.000000
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const ss = parts.length === 3 ? Number(String(parts[2]).split('.')[0] || '0') : 0;
  if (![hh, mm, ss].every(Number.isFinite)) return null;
  return hh * 60 + mm + ss / 60;
}

function parseHHMMSSToHours(v) {
  const mins = parseHHMMSSToMinutes(v);
  if (mins == null) return null;
  return mins / 60;
}

async function importFromGarminDbSqlite({ userId, garminDbPath, days = 30 }) {
  const gdb = new sqlite3.Database(garminDbPath, sqlite3.OPEN_READONLY);
  const gAll = (sql, params = []) => new Promise((resolve, reject) => gdb.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
  const gGet = (sql, params = []) => new Promise((resolve, reject) => gdb.get(sql, params, (e, row) => e ? reject(e) : resolve(row)));

  const tables = (await gAll(`SELECT name FROM sqlite_master WHERE type='table'`)).map(r => r.name);

  async function tableCols(t) {
    const rows = await gAll(`PRAGMA table_info(${quoteIdent(t)})`);
    return rows.map(r => r.name);
  }

  function pickCol(cols, patterns) {
    const lower = cols.map(c => [c, c.toLowerCase()]);
    for (const p of patterns) {
      const found = lower.find(([orig, lo]) => lo.includes(p));
      if (found) return found[0];
    }
    return null;
  }

  function hasAny(cols, pats) {
    const s = cols.map(c => c.toLowerCase());
    return pats.some(p => s.some(c => c.includes(p)));
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, Math.min(365, Number(days) || 30)));
  const cutoffIso = cutoff.toISOString().split('T')[0];

  let activity_upserts = 0;
  let sleep_upserts = 0;
  let weight_upserts = 0;
  let hr_samples = 0;

  // Prefer known GarminDB tables when present (more reliable than heuristics)
  const hasTable = (name) => tables.includes(name);

  if (hasTable('daily_summary')) {
    const rows = await gAll(
      `SELECT day AS d,
              hr_min AS hr_min,
              hr_max AS hr_max,
              rhr AS rhr,
              step_goal AS step_goal,
              floors_goal AS floors_goal,
              calories_goal AS calories_goal,
              steps AS steps,
              calories_total AS calories_total,
              calories_bmr AS calories_bmr,
              calories_active AS calories_active,
              calories_consumed AS calories_consumed,
              distance AS distance,
              floors_up AS floors_up,
              floors_down AS floors_down,
              stress_avg AS stress_avg,
              spo2_avg AS spo2_avg,
              spo2_min AS spo2_min,
              rr_waking_avg AS rr_waking_avg,
              rr_max AS rr_max,
              rr_min AS rr_min,
              bb_charged AS bb_charged,
              bb_max AS bb_max,
              bb_min AS bb_min,
              hydration_intake AS hydration_intake,
              hydration_goal AS hydration_goal,
              sweat_loss AS sweat_loss,
              intensity_time_goal AS intensity_time_goal,
              description AS description,
              moderate_activity_time AS mod_time,
              vigorous_activity_time AS vig_time
         FROM daily_summary`
    ).catch(() => []);

    for (const r of rows) {
      const date = coerceIsoDate(r.d);
      if (!date || date < cutoffIso) continue;
      const modMin = parseHHMMSSToMinutes(r.mod_time);
      const vigMin = parseHHMMSSToMinutes(r.vig_time);
      const intensityGoalMin = parseHHMMSSToMinutes(r.intensity_time_goal);
      const patch = {
        source: 'garmin',
        hr_min: r.hr_min != null ? Number(r.hr_min) : null,
        hr_max: r.hr_max != null ? Number(r.hr_max) : null,
        rhr: r.rhr != null ? Number(r.rhr) : null,
        step_goal: r.step_goal != null ? Number(r.step_goal) : null,
        floors_goal: r.floors_goal != null ? Number(r.floors_goal) : null,
        calories_goal: r.calories_goal != null ? Number(r.calories_goal) : null,
        steps: r.steps != null ? Number(r.steps) : null,
        // total calories is typically more useful for "burned" on Garmin
        calories_burned: r.calories_total != null ? Number(r.calories_total) : (r.calories_active != null ? Number(r.calories_active) : null),
        calories_total: r.calories_total != null ? Number(r.calories_total) : null,
        calories_bmr: r.calories_bmr != null ? Number(r.calories_bmr) : null,
        calories_active: r.calories_active != null ? Number(r.calories_active) : null,
        calories_consumed: r.calories_consumed != null ? Number(r.calories_consumed) : null,
        distance_km: r.distance != null ? Number(r.distance) : null,
        floors_up: r.floors_up != null ? Number(r.floors_up) : null,
        floors_down: r.floors_down != null ? Number(r.floors_down) : null,
        stress_avg: r.stress_avg != null ? Number(r.stress_avg) : null,
        spo2_avg: r.spo2_avg != null ? Number(r.spo2_avg) : null,
        spo2_min: r.spo2_min != null ? Number(r.spo2_min) : null,
        rr_waking_avg: r.rr_waking_avg != null ? Number(r.rr_waking_avg) : null,
        rr_max: r.rr_max != null ? Number(r.rr_max) : null,
        rr_min: r.rr_min != null ? Number(r.rr_min) : null,
        body_battery_charged: r.bb_charged != null ? Number(r.bb_charged) : null,
        body_battery_max: r.bb_max != null ? Number(r.bb_max) : null,
        body_battery_min: r.bb_min != null ? Number(r.bb_min) : null,
        hydration_intake: r.hydration_intake != null ? Number(r.hydration_intake) : null,
        hydration_goal: r.hydration_goal != null ? Number(r.hydration_goal) : null,
        sweat_loss: r.sweat_loss != null ? Number(r.sweat_loss) : null,
        intensity_time_goal_minutes: intensityGoalMin != null ? Number(intensityGoalMin) : null,
        notes: r.description != null ? String(r.description) : null,
        active_minutes: (modMin != null || vigMin != null) ? (Number(modMin || 0) + Number(vigMin || 0)) : null
      };
      const result = await upsertDayActivity(userId, date, patch).catch(() => null);
      if (result) activity_upserts++;
    }
  } else if (hasTable('days_summary')) {
    // Some GarminDB builds store step/calorie rollups in garmin_summary.db (days_summary)
    const rows = await gAll(
      `SELECT day AS d,
              steps AS steps,
              calories_avg AS calories,
              hr_avg AS hr,
              intensity_time AS intensity_time
         FROM days_summary`
    ).catch(() => []);
    for (const r of rows) {
      const date = coerceIsoDate(r.d);
      if (!date || date < cutoffIso) continue;
      const activeMin = parseHHMMSSToMinutes(r.intensity_time);
      const patch = {
        source: 'garmin',
        steps: r.steps != null ? Number(r.steps) : null,
        calories_burned: r.calories != null ? Number(r.calories) : null,
        heart_rate_avg: r.hr != null ? Number(r.hr) : null,
        active_minutes: activeMin != null ? Number(activeMin) : null
      };
      const result = await upsertDayActivity(userId, date, patch).catch(() => null);
      if (result) activity_upserts++;
    }
  } else {
  // Heuristic: pick an "activity daily" table
  for (const t of tables) {
    const cols = await tableCols(t).catch(() => []);
    if (!cols.length) continue;
    if (!hasAny(cols, ['step'])) continue;
    if (!hasAny(cols, ['date', 'day', 'calendar'])) continue;

    const dateCol = pickCol(cols, ['date', 'day', 'calendar']);
    const stepsCol = pickCol(cols, ['steps', 'step']);
    const calCol = pickCol(cols, ['calories', 'kcal']);
    const hrCol = pickCol(cols, ['avg_heart', 'average_heart', 'heart_rate_avg', 'avg_hr', 'heartrate']);
    const activeCol = pickCol(cols, ['active_min', 'intensity', 'active_minutes', 'active_time']);
    if (!dateCol || !stepsCol) continue;

    const rows = await gAll(
      `SELECT ${quoteIdent(dateCol)} AS d, ${quoteIdent(stepsCol)} AS steps,
              ${calCol ? `${quoteIdent(calCol)} AS calories,` : ''} 
              ${hrCol ? `${quoteIdent(hrCol)} AS hr,` : ''} 
              ${activeCol ? `${quoteIdent(activeCol)} AS active` : 'NULL AS active'}
         FROM ${quoteIdent(t)}`
    ).catch(() => []);
    if (!rows.length) continue;

    for (const r of rows) {
      const date = coerceIsoDate(r.d);
      if (!date || date < cutoffIso) continue;
      const patch = {
        source: 'garmin',
        steps: r.steps != null ? Number(r.steps) : null,
        calories_burned: r.calories != null ? Number(r.calories) : null,
        heart_rate_avg: r.hr != null ? Number(r.hr) : null,
        active_minutes: r.active != null ? Number(r.active) : null
      };
      const result = await upsertDayActivity(userId, date, patch).catch(() => null);
      if (result) activity_upserts++;
    }
    break; // stop after first good match
  }
  }

  if (hasTable('sleep')) {
    const rows = await gAll(
      `SELECT day AS d,
              score AS score,
              total_sleep AS dur,
              deep_sleep AS deep,
              rem_sleep AS rem,
              start AS bed,
              end AS wake
         FROM sleep`
    ).catch(() => []);
    for (const r of rows) {
      const date = coerceIsoDate(r.d);
      if (!date || date < cutoffIso) continue;
      await upsertDaySleep(userId, date, {
        source: 'garmin',
        score: r.score != null ? Number(r.score) : null,
        duration_hours: parseHHMMSSToHours(r.dur),
        deep_sleep_hours: parseHHMMSSToHours(r.deep),
        rem_sleep_hours: parseHHMMSSToHours(r.rem),
        bedtime: r.bed ? String(r.bed).slice(11, 16) : null,
        wake_time: r.wake ? String(r.wake).slice(11, 16) : null
      }).catch(() => {});
      sleep_upserts++;
    }
  } else {
  // Heuristic: pick a sleep table
  for (const t of tables) {
    const cols = await tableCols(t).catch(() => []);
    if (!cols.length) continue;
    if (!hasAny(cols, ['sleep'])) continue;
    if (!hasAny(cols, ['date', 'day'])) continue;
    const dateCol = pickCol(cols, ['date', 'day']);
    if (!dateCol) continue;

    const scoreCol = pickCol(cols, ['score']);
    const durCol = pickCol(cols, ['duration', 'total_sleep', 'sleep_time']);
    const deepCol = pickCol(cols, ['deep']);
    const remCol = pickCol(cols, ['rem']);
    const bedCol = pickCol(cols, ['bed', 'start']);
    const wakeCol = pickCol(cols, ['wake', 'end']);

    const sel = [
      `${quoteIdent(dateCol)} AS d`,
      scoreCol ? `${quoteIdent(scoreCol)} AS score` : 'NULL AS score',
      durCol ? `${quoteIdent(durCol)} AS dur` : 'NULL AS dur',
      deepCol ? `${quoteIdent(deepCol)} AS deep` : 'NULL AS deep',
      remCol ? `${quoteIdent(remCol)} AS rem` : 'NULL AS rem',
      bedCol ? `${quoteIdent(bedCol)} AS bed` : 'NULL AS bed',
      wakeCol ? `${quoteIdent(wakeCol)} AS wake` : 'NULL AS wake'
    ].join(', ');

    const rows = await gAll(`SELECT ${sel} FROM ${quoteIdent(t)}`).catch(() => []);
    if (!rows.length) continue;

    for (const r of rows) {
      const date = coerceIsoDate(r.d);
      if (!date || date < cutoffIso) continue;
      await upsertDaySleep(userId, date, {
        source: 'garmin',
        score: r.score != null ? Number(r.score) : null,
        duration_hours: r.dur != null ? Number(r.dur) : null,
        deep_sleep_hours: r.deep != null ? Number(r.deep) : null,
        rem_sleep_hours: r.rem != null ? Number(r.rem) : null,
        bedtime: r.bed ? String(r.bed).slice(0, 5) : null,
        wake_time: r.wake ? String(r.wake).slice(0, 5) : null
      }).catch(() => {});
      sleep_upserts++;
    }
    break;
  }
  }

  // weight + resting HR (prefer known tables)
  if (hasTable('weight')) {
    const rows = await gAll(`SELECT day AS d, weight AS w FROM weight`).catch(() => []);
    for (const r of rows) {
      const date = coerceIsoDate(r.d);
      if (!date || date < cutoffIso) continue;
      const w = r.w != null ? Number(r.w) : null;
      if (w != null && Number.isFinite(w)) {
        await upsertBodyCompByDate({ userId, date, patch: { weight_kg: w }, source: 'garmin' }).catch(() => {});
        weight_upserts++;
      }
    }
  }

  if (hasTable('resting_hr')) {
    const rows = await gAll(`SELECT day AS d, resting_heart_rate AS hr FROM resting_hr`).catch(() => []);
    for (const r of rows) {
      const date = coerceIsoDate(r.d);
      if (!date || date < cutoffIso) continue;
      const hr = r.hr != null ? Number(r.hr) : null;
      if (hr != null && Number.isFinite(hr)) {
        await insertBiometricSample({ userId, type: 'resting_heart_rate', date, value_num: hr, unit: 'bpm', source: 'garmin' }).catch(() => {});
        hr_samples++;
      }
    }
  }

  // Heuristic fallback: weight / resting HR
  if (!hasTable('weight') || !hasTable('resting_hr')) {
  // Heuristic: weight / resting HR
  for (const t of tables) {
    const cols = await tableCols(t).catch(() => []);
    if (!cols.length) continue;
    const dateCol = pickCol(cols, ['date', 'day']);
    if (!dateCol) continue;

    // weight
    if (hasAny(cols, ['weight'])) {
      const wCol = pickCol(cols, ['weight']);
      const rows = await gAll(`SELECT ${quoteIdent(dateCol)} AS d, ${quoteIdent(wCol)} AS w FROM ${quoteIdent(t)}`).catch(() => []);
      for (const r of rows) {
        const date = coerceIsoDate(r.d);
        if (!date || date < cutoffIso) continue;
        const w = r.w != null ? Number(r.w) : null;
        if (w != null && Number.isFinite(w)) {
          await upsertBodyCompByDate({ userId, date, patch: { weight_kg: w }, source: 'garmin' }).catch(() => {});
          weight_upserts++;
        }
      }
      continue;
    }

    // resting HR
    if (hasAny(cols, ['resting']) && hasAny(cols, ['heart'])) {
      const hrCol = pickCol(cols, ['resting', 'hr']);
      const rows = await gAll(`SELECT ${quoteIdent(dateCol)} AS d, ${quoteIdent(hrCol)} AS hr FROM ${quoteIdent(t)}`).catch(() => []);
      for (const r of rows) {
        const date = coerceIsoDate(r.d);
        if (!date || date < cutoffIso) continue;
        const hr = r.hr != null ? Number(r.hr) : null;
        if (hr != null && Number.isFinite(hr)) {
          await insertBiometricSample({ userId, type: 'resting_heart_rate', date, value_num: hr, unit: 'bpm', source: 'garmin' }).catch(() => {});
          hr_samples++;
        }
      }
    }
  }
  }

  gdb.close();
  return { activity_upserts, sleep_upserts, weight_upserts, hr_samples };
}

async function importFromGarminMonitoringDb({ userId, garminMonitoringPath, days = 7 }) {
  const gdb = new sqlite3.Database(garminMonitoringPath, sqlite3.OPEN_READONLY);
  const gAll = (sql, params = []) => new Promise((resolve, reject) => gdb.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, Math.min(365, Number(days) || 7)));
  const cutoffSql = `${cutoff.toISOString().split('T')[0]} 00:00:00`;

  let hr_samples = 0;

  const rows = await gAll(
    `SELECT timestamp AS ts, heart_rate AS hr
       FROM monitoring_hr
      WHERE timestamp >= ?
      ORDER BY timestamp ASC`,
    [cutoffSql]
  ).catch(() => []);

  for (const r of rows) {
    const ts = r.ts ? String(r.ts) : null;
    const hr = r.hr != null ? Number(r.hr) : null;
    if (!ts || hr == null || !Number.isFinite(hr)) continue;
    const start_at = ts.includes('T') ? ts : ts.replace(' ', 'T');
    await runDb(
      `INSERT INTO biometric_samples (user_id, type, start_at, end_at, value_num, unit, source, raw_json)
       VALUES (?, 'heart_rate', ?, ?, ?, 'bpm', 'garmin', NULL)
       ON CONFLICT(user_id, type, source, start_at) DO NOTHING`,
      [userId, start_at, start_at, hr]
    ).catch(() => {});
    hr_samples++;
  }

  gdb.close();
  return { hr_samples };
}

async function importFromGarminActivitiesDb({ userId, garminActivitiesPath, days = 30 }) {
  const gdb = new sqlite3.Database(garminActivitiesPath, sqlite3.OPEN_READONLY);
  const gAll = (sql, params = []) => new Promise((resolve, reject) => gdb.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, Math.min(365, Number(days) || 30)));
  const cutoffSql = `${cutoff.toISOString().split('T')[0]} 00:00:00`;

  let sessions_upserts = 0;

  const rows = await gAll(
    `SELECT activity_id, name, description, type, sport, sub_sport,
            start_time, stop_time, elapsed_time, moving_time,
            distance, calories, avg_hr, max_hr,
            training_load, training_effect, anaerobic_training_effect
       FROM activities
      WHERE start_time >= ?
      ORDER BY start_time ASC`,
    [cutoffSql]
  ).catch(() => []);

  function pickSessionType(sport, type) {
    const s = String(sport || '').toLowerCase();
    const t = String(type || '').toLowerCase();
    if (s.includes('running') || t.includes('running')) return 'run';
    if (s.includes('strength') || t.includes('strength')) return 'strength';
    return 'other';
  }

  for (const r of rows) {
    const external_id = r.activity_id != null ? String(r.activity_id) : null;
    if (!external_id) continue;
    const start_time = r.start_time ? String(r.start_time) : null;
    const date = start_time ? coerceIsoDate(start_time) : null;
    if (!date) continue;

    const existing = await getDb(
      'SELECT id FROM workout_sessions WHERE user_id = ? AND source = ? AND external_id = ? LIMIT 1',
      [userId, 'garmin', external_id]
    ).catch(() => null);
    if (existing?.id) continue;

    const distKm = r.distance != null ? Number(r.distance) : null; // GarminDB distance here appears to be km
    const durMin = parseHHMMSSToMinutes(r.moving_time || r.elapsed_time);
    const pace = (durMin != null && distKm != null && distKm > 0) ? (durMin / distKm) : null;

    const type = pickSessionType(r.sport, r.type);
    const name = r.name || r.sub_sport || r.sport || 'Garmin Activity';
    const raw_json = JSON.stringify({
      activity_id: external_id,
      type: r.type,
      sport: r.sport,
      sub_sport: r.sub_sport,
      start_time: r.start_time,
      stop_time: r.stop_time,
      elapsed_time: r.elapsed_time,
      moving_time: r.moving_time,
      distance: r.distance,
      calories: r.calories,
      avg_hr: r.avg_hr,
      max_hr: r.max_hr,
      training_load: r.training_load,
      training_effect: r.training_effect,
      anaerobic_training_effect: r.anaerobic_training_effect
    });

    await runDb(
      `INSERT INTO workout_sessions
        (user_id, date, type, name, notes, duration_minutes, distance_km, pace_min_per_km, calories,
         source, external_id, avg_hr, max_hr,
         training_load, training_effect, anaerobic_training_effect,
         raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
         'garmin', ?, ?, ?,
         ?, ?, ?,
         ?)
       ON CONFLICT(user_id, source, external_id) DO NOTHING`,
      [
        userId,
        date,
        type,
        String(name),
        r.description ? String(r.description) : null,
        durMin != null ? Number(durMin) : null,
        distKm != null ? Number(distKm) : null,
        pace != null ? Number(pace) : null,
        r.calories != null ? Number(r.calories) : null,
        external_id,
        r.avg_hr != null ? Number(r.avg_hr) : null,
        r.max_hr != null ? Number(r.max_hr) : null,
        r.training_load != null ? Number(r.training_load) : null,
        r.training_effect != null ? Number(r.training_effect) : null,
        r.anaerobic_training_effect != null ? Number(r.anaerobic_training_effect) : null,
        raw_json
      ]
    ).catch(() => {});
    sessions_upserts++;
  }

  gdb.close();
  return { sessions_upserts };
}

async function runGarminDbCli({ args, cwd, timeoutMs = 10 * 60 * 1000 }) {
  return await new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 50_000) stdout = stdout.slice(-50_000); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 50_000) stderr = stderr.slice(-50_000); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// Authenticated serving of food photos
app.get('/api/uploads/photos/:filename', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const filename = String(req.params.filename || '').trim();
    if (!filename) return res.status(400).send('Bad request');
    const row = await getDb('SELECT id FROM food_photos WHERE user_id = ? AND filename = ? LIMIT 1', [userId, filename]);
    if (!row) return res.status(404).send('Not found');
    const abs = path.join(__dirname, 'uploads', 'photos', filename);
    return res.sendFile(abs);
  } catch (e) {
    return res.status(500).send('Server error');
  }
});

// Auth API (implemented in server/auth.js)
registerAuthRoutes(app, { csrfProtection, getDb, runDb, bcrypt, normalizeEmail });

// Local (offline) journal insight extractor. This is an LLM-ready seam:
// Later you can replace this with a provider that calls an LLM and returns the same shape.
function extractJournalInsightsLocal(text) {
  const t = (text || '').toLowerCase();
  const positive = ['great', 'good', 'amazing', 'happy', 'energized', 'productive', 'calm', 'relaxed', 'excited', 'confident'];
  const negative = ['bad', 'terrible', 'sad', 'angry', 'anxious', 'stressed', 'tired', 'exhausted', 'overwhelmed', 'depressed'];

  let score = 0;
  positive.forEach(w => { if (t.includes(w)) score += 1; });
  negative.forEach(w => { if (t.includes(w)) score -= 1; });
  const sentiment = Math.max(-1, Math.min(1, score / 6));

  // Map sentiment to mood 1..10
  const mood = clampInt(5 + sentiment * 4, 1, 10);

  // Simple heuristics for energy/stress/anxiety
  const energyHintsLow = ['tired', 'exhausted', 'sleepy', 'fatigued', 'drained'];
  const energyHintsHigh = ['energized', 'energetic', 'wired', 'motivated'];
  let energy = 5;
  energyHintsLow.forEach(w => { if (t.includes(w)) energy -= 2; });
  energyHintsHigh.forEach(w => { if (t.includes(w)) energy += 2; });
  energy = clampInt(energy, 1, 10);

  const stressHints = ['stressed', 'overwhelmed', 'pressure', 'deadline', 'stress'];
  const calmHints = ['calm', 'relaxed', 'peaceful', 'grounded'];
  let stress = 5;
  stressHints.forEach(w => { if (t.includes(w)) stress += 2; });
  calmHints.forEach(w => { if (t.includes(w)) stress -= 2; });
  stress = clampInt(stress, 1, 10);

  const anxietyHints = ['anxious', 'panic', 'worried', 'ruminating', 'nervous', 'anxiety'];
  let anxiety = 5;
  anxietyHints.forEach(w => { if (t.includes(w)) anxiety += 2; });
  anxiety = clampInt(anxiety, 1, 10);

  const tags = [];
  if (t.includes('workout') || t.includes('gym') || t.includes('run')) tags.push('exercise');
  if (t.includes('sleep')) tags.push('sleep');
  if (t.includes('work')) tags.push('work');
  if (t.includes('family') || t.includes('friends')) tags.push('relationships');

  const summary = text ? (text.length > 220 ? text.slice(0, 220) + '…' : text) : '';

  return {
    mood_score: mood,
    energy_score: energy,
    stress_score: stress,
    anxiety_score: anxiety,
    sentiment,
    tags,
    summary,
    extracted: { sentiment, tags }
  };
}

// Local (offline) food photo estimator. LLM-ready seam.
// Current behavior: uses notes + simple keyword mapping; confidence is low.
function estimateFoodFromNotesLocal(notes) {
  const n = (notes || '').toLowerCase();
  const presets = [
    { key: 'salad', dish: 'Salad', cal: 350, p: 20, c: 25, f: 18, micro: { vitamin_c_mg: 35, potassium_mg: 700 }, conf: 0.25 },
    { key: 'burrito', dish: 'Burrito / Bowl', cal: 750, p: 35, c: 85, f: 28, micro: { sodium_mg: 1400, fiber_g: 12 }, conf: 0.28 },
    { key: 'pizza', dish: 'Pizza', cal: 800, p: 28, c: 90, f: 35, micro: { sodium_mg: 1600, calcium_mg: 350 }, conf: 0.25 },
    { key: 'pasta', dish: 'Pasta', cal: 700, p: 25, c: 95, f: 22, micro: { iron_mg: 4, fiber_g: 8 }, conf: 0.24 },
    { key: 'chicken', dish: 'Chicken + sides', cal: 600, p: 45, c: 45, f: 22, micro: { niacin_mg: 14, selenium_ug: 50 }, conf: 0.24 },
    { key: 'steak', dish: 'Steak + sides', cal: 750, p: 55, c: 35, f: 40, micro: { iron_mg: 6, zinc_mg: 8 }, conf: 0.24 },
    { key: 'sandwich', dish: 'Sandwich', cal: 650, p: 30, c: 70, f: 26, micro: { sodium_mg: 1200, fiber_g: 6 }, conf: 0.23 },
    { key: 'sushi', dish: 'Sushi', cal: 550, p: 28, c: 75, f: 14, micro: { iodine_ug: 120, omega3_g: 1.2 }, conf: 0.24 },
    { key: 'breakfast', dish: 'Breakfast', cal: 550, p: 25, c: 55, f: 25, micro: { calcium_mg: 250, fiber_g: 7 }, conf: 0.22 }
  ];

  const found = presets.find(p => n.includes(p.key));
  if (found) return found;

  // Default generic meal estimate
  return { dish: notes ? `Meal (${notes.slice(0, 24)}…)` : 'Meal (unknown)', cal: 650, p: 25, c: 70, f: 25, micro: { fiber_g: 6 }, conf: 0.18 };
}

async function upsertNutritionAdd(userId, date, delta) {
  const existing = await getDb('SELECT * FROM nutrition_data WHERE user_id = ? AND date = ?', [userId, date]);
  if (!existing) {
    await runDb(
      `INSERT INTO nutrition_data (user_id, date, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        date,
        delta.calories || 0,
        delta.protein_g || 0,
        delta.carbs_g || 0,
        delta.fat_g || 0,
        delta.fiber_g || 0,
        delta.sugar_g || 0
      ]
    );
    return;
  }
  await runDb(
    `UPDATE nutrition_data
        SET calories = COALESCE(calories,0) + ?,
            protein_g = COALESCE(protein_g,0) + ?,
            carbs_g = COALESCE(carbs_g,0) + ?,
            fat_g = COALESCE(fat_g,0) + ?,
            fiber_g = COALESCE(fiber_g,0) + ?,
            sugar_g = COALESCE(sugar_g,0) + ?
      WHERE user_id = ? AND date = ?`,
    [
      delta.calories || 0,
      delta.protein_g || 0,
      delta.carbs_g || 0,
      delta.fat_g || 0,
      delta.fiber_g || 0,
      delta.sugar_g || 0,
      userId,
      date
    ]
  );
}

function normalizeHeader(h) {
  return (h || '')
    .toString()
    .trim()
    .toLowerCase()
    .replaceAll('%', ' pct')
    .replaceAll(/\s+/g, ' ')
    .replaceAll('_', ' ');
}

function parseNumberLoose(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replaceAll(',', '').replaceAll(/[^\d.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDateLoose(v) {
  if (!v) return null;
  const s = String(v).trim();
  // try native Date
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  // try dd/mm/yyyy
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const dd = String(m1[1]).padStart(2, '0');
    const mm = String(m1[2]).padStart(2, '0');
    const yy = m1[3];
    return `${yy}-${mm}-${dd}`;
  }
  // try yyyy-mm-dd
  const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m2) {
    const yy = m2[1];
    const mm = String(m2[2]).padStart(2, '0');
    const dd = String(m2[3]).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
  return null;
}

function parseAppleHealthDate(s) {
  if (!s) return null;
  const raw = String(s).trim();
  // Apple Health export often uses "YYYY-MM-DD HH:mm:ss ZZZZ"
  // JS Date is inconsistent here; normalize timezone if possible.
  const normalized = raw.replace(/(\+\d{4})$/, (m) => {
    // "+0000" -> "+00:00"
    return m.slice(0, 3) + ':' + m.slice(3);
  });
  const d = new Date(normalized);
  if (!Number.isNaN(d.getTime())) return d;
  const d2 = new Date(raw);
  if (!Number.isNaN(d2.getTime())) return d2;
  return null;
}

function isoDateKey(d) {
  try {
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

function parseXmlAttributesFromLine(line) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function parseCsvLineLoose(line) {
  // CSV with basic quote support
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' ) {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => String(s ?? '').trim());
}

function pickField(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k];
  }
  return null;
}

function normalizeHeaderKey(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '');
}

async function parseDailyMetricsCsvStream(stream, stepsByDay) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  let idx = {};
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLineLoose(line);
      idx = Object.fromEntries(headers.map((h, i) => [normalizeHeaderKey(h), i]));
      continue;
    }
    if (!line.trim()) continue;
    const cols = parseCsvLineLoose(line);
    const dateVal = cols[idx['date']] ?? cols[idx['day']] ?? cols[idx['start date']] ?? cols[idx['start time']] ?? null;
    const stepsVal = cols[idx['steps']] ?? cols[idx['step count']] ?? cols[idx['stepcount']] ?? null;
    const d = dateVal ? parseDateLoose(dateVal) : null;
    const v = parseNumberLoose(stepsVal);
    if (d && v != null) stepsByDay[d] = (stepsByDay[d] || 0) + v;
  }
}

async function parseHeartRateCsvStream(stream, hrSumByDay, hrCountByDay) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  let idx = {};
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLineLoose(line);
      idx = Object.fromEntries(headers.map((h, i) => [normalizeHeaderKey(h), i]));
      continue;
    }
    if (!line.trim()) continue;
    const cols = parseCsvLineLoose(line);
    const tsVal =
      cols[idx['time']] ?? cols[idx['start time']] ?? cols[idx['start']] ?? cols[idx['date']] ?? cols[idx['timestamp']] ?? null;
    const bpmVal =
      cols[idx['bpm']] ?? cols[idx['heart rate']] ?? cols[idx['heartrate']] ?? cols[idx['value']] ?? null;
    const d = tsVal ? parseAppleHealthDate(tsVal) : null;
    const key = d ? isoDateKey(d) : null;
    const v = parseNumberLoose(bpmVal);
    if (key && v != null) {
      hrSumByDay[key] = (hrSumByDay[key] || 0) + v;
      hrCountByDay[key] = (hrCountByDay[key] || 0) + 1;
    }
  }
}

async function parseSleepCsvStream(stream, sleepHoursByDay) {
  // best-effort: if we see start/end timestamps, compute duration.
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  let idx = {};
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLineLoose(line);
      idx = Object.fromEntries(headers.map((h, i) => [normalizeHeaderKey(h), i]));
      continue;
    }
    if (!line.trim()) continue;
    const cols = parseCsvLineLoose(line);
    const startVal = cols[idx['start time']] ?? cols[idx['start']] ?? cols[idx['sleep start']] ?? null;
    const endVal = cols[idx['end time']] ?? cols[idx['end']] ?? cols[idx['sleep end']] ?? null;
    const durVal = cols[idx['duration']] ?? cols[idx['duration minutes']] ?? cols[idx['minutes']] ?? null;
    const start = startVal ? parseAppleHealthDate(startVal) : null;
    const end = endVal ? parseAppleHealthDate(endVal) : null;
    if (start && end && end > start) {
      addDurationHoursByDay(sleepHoursByDay, start, end);
      continue;
    }
    const dateVal = cols[idx['date']] ?? cols[idx['day']] ?? null;
    const dateKey = dateVal ? parseDateLoose(dateVal) : null;
    const durMin = parseNumberLoose(durVal);
    if (dateKey && durMin != null) {
      sleepHoursByDay[dateKey] = (sleepHoursByDay[dateKey] || 0) + (durMin / 60);
    }
  }
}

async function peekFirstLineFromStream(stream, maxBytes = 65536) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    function onData(chunk) {
      chunks.push(chunk);
      bytes += chunk.length;
      const buf = Buffer.concat(chunks);
      const idx = buf.indexOf(0x0a); // '\n'
      if (idx !== -1 || bytes >= maxBytes) {
        stream.pause();
        stream.removeListener('data', onData);
        // push everything back so downstream sees full content
        stream.unshift(buf);
        const line = buf.slice(0, idx !== -1 ? idx : buf.length).toString('utf8').replace(/\r$/, '');
        resolve(line);
        stream.resume();
      }
    }
    stream.on('data', onData);
    stream.on('end', () => resolve(''));
    stream.on('error', () => resolve(''));
  });
}

function addDurationHoursByDay(map, start, end) {
  if (!start || !end) return;
  let cur = start;
  while (cur < end) {
    const next = new Date(cur);
    next.setHours(24, 0, 0, 0);
    const chunkEnd = next < end ? next : end;
    const key = isoDateKey(cur);
    if (key) {
      const hrs = (chunkEnd.getTime() - cur.getTime()) / (1000 * 60 * 60);
      map[key] = (map[key] || 0) + hrs;
    }
    cur = chunkEnd;
  }
}

async function upsertDayActivity(userId, date, patch) {
  const existing = await getDb(
    'SELECT id FROM activity_data WHERE user_id = ? AND date = ? ORDER BY created_at DESC LIMIT 1',
    [userId, date]
  );
  const steps = patch.steps !== undefined ? patch.steps : null;
  const hr = patch.heart_rate_avg !== undefined ? patch.heart_rate_avg : null;
  const active = patch.active_minutes !== undefined ? patch.active_minutes : null;
  const cal = patch.calories_burned !== undefined ? patch.calories_burned : null;
  const hr_min = patch.hr_min !== undefined ? patch.hr_min : null;
  const hr_max = patch.hr_max !== undefined ? patch.hr_max : null;
  const rhr = patch.rhr !== undefined ? patch.rhr : null;
  const step_goal = patch.step_goal !== undefined ? patch.step_goal : null;
  const floors_goal = patch.floors_goal !== undefined ? patch.floors_goal : null;
  const calories_goal = patch.calories_goal !== undefined ? patch.calories_goal : null;
  const calories_bmr = patch.calories_bmr !== undefined ? patch.calories_bmr : null;
  const intensity_time_goal_minutes = patch.intensity_time_goal_minutes !== undefined ? patch.intensity_time_goal_minutes : null;
  const sweat_loss = patch.sweat_loss !== undefined ? patch.sweat_loss : null;
  const rr_max = patch.rr_max !== undefined ? patch.rr_max : null;
  const rr_min = patch.rr_min !== undefined ? patch.rr_min : null;
  const notes = patch.notes !== undefined ? patch.notes : null;
  const distance_km = patch.distance_km !== undefined ? patch.distance_km : null;
  const floors_up = patch.floors_up !== undefined ? patch.floors_up : null;
  const floors_down = patch.floors_down !== undefined ? patch.floors_down : null;
  const calories_total = patch.calories_total !== undefined ? patch.calories_total : null;
  const calories_active = patch.calories_active !== undefined ? patch.calories_active : null;
  const calories_consumed = patch.calories_consumed !== undefined ? patch.calories_consumed : null;
  const stress_avg = patch.stress_avg !== undefined ? patch.stress_avg : null;
  const spo2_avg = patch.spo2_avg !== undefined ? patch.spo2_avg : null;
  const spo2_min = patch.spo2_min !== undefined ? patch.spo2_min : null;
  const rr_waking_avg = patch.rr_waking_avg !== undefined ? patch.rr_waking_avg : null;
  const body_battery_charged = patch.body_battery_charged !== undefined ? patch.body_battery_charged : null;
  const body_battery_max = patch.body_battery_max !== undefined ? patch.body_battery_max : null;
  const body_battery_min = patch.body_battery_min !== undefined ? patch.body_battery_min : null;
  const hydration_intake = patch.hydration_intake !== undefined ? patch.hydration_intake : null;
  const hydration_goal = patch.hydration_goal !== undefined ? patch.hydration_goal : null;
  const source = patch.source !== undefined ? patch.source : null;
  if (existing?.id) {
    await runDb(
      `UPDATE activity_data
          SET steps = COALESCE(?, steps),
              heart_rate_avg = COALESCE(?, heart_rate_avg),
              active_minutes = COALESCE(?, active_minutes),
              calories_burned = COALESCE(?, calories_burned),
              hr_min = COALESCE(?, hr_min),
              hr_max = COALESCE(?, hr_max),
              rhr = COALESCE(?, rhr),
              step_goal = COALESCE(?, step_goal),
              floors_goal = COALESCE(?, floors_goal),
              calories_goal = COALESCE(?, calories_goal),
              calories_bmr = COALESCE(?, calories_bmr),
              intensity_time_goal_minutes = COALESCE(?, intensity_time_goal_minutes),
              sweat_loss = COALESCE(?, sweat_loss),
              rr_max = COALESCE(?, rr_max),
              rr_min = COALESCE(?, rr_min),
              notes = COALESCE(?, notes),
              distance_km = COALESCE(?, distance_km),
              floors_up = COALESCE(?, floors_up),
              floors_down = COALESCE(?, floors_down),
              calories_total = COALESCE(?, calories_total),
              calories_active = COALESCE(?, calories_active),
              calories_consumed = COALESCE(?, calories_consumed),
              stress_avg = COALESCE(?, stress_avg),
              spo2_avg = COALESCE(?, spo2_avg),
              spo2_min = COALESCE(?, spo2_min),
              rr_waking_avg = COALESCE(?, rr_waking_avg),
              body_battery_charged = COALESCE(?, body_battery_charged),
              body_battery_max = COALESCE(?, body_battery_max),
              body_battery_min = COALESCE(?, body_battery_min),
              hydration_intake = COALESCE(?, hydration_intake),
              hydration_goal = COALESCE(?, hydration_goal),
              source = COALESCE(?, source)
        WHERE id = ?`,
      [
        steps, hr, active, cal,
        hr_min, hr_max, rhr, step_goal, floors_goal, calories_goal, calories_bmr,
        intensity_time_goal_minutes, sweat_loss, rr_max, rr_min, notes,
        distance_km, floors_up, floors_down,
        calories_total, calories_active, calories_consumed,
        stress_avg, spo2_avg, spo2_min, rr_waking_avg,
        body_battery_charged, body_battery_max, body_battery_min,
        hydration_intake, hydration_goal,
        source,
        existing.id
      ]
    );
    return 'updated';
  }
  await runDb(
    `INSERT INTO activity_data
      (user_id, date, steps, heart_rate_avg, active_minutes, calories_burned,
       hr_min, hr_max, rhr, step_goal, floors_goal, calories_goal, calories_bmr, intensity_time_goal_minutes, sweat_loss, rr_max, rr_min, notes,
       distance_km, floors_up, floors_down,
       calories_total, calories_active, calories_consumed,
       stress_avg, spo2_avg, spo2_min, rr_waking_avg,
       body_battery_charged, body_battery_max, body_battery_min,
       hydration_intake, hydration_goal,
       source)
     VALUES
      (?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?,
       ?)`,
    [
      userId, date, steps, hr, active, cal,
      hr_min, hr_max, rhr, step_goal, floors_goal, calories_goal, calories_bmr, intensity_time_goal_minutes, sweat_loss, rr_max, rr_min, notes,
      distance_km, floors_up, floors_down,
      calories_total, calories_active, calories_consumed,
      stress_avg, spo2_avg, spo2_min, rr_waking_avg,
      body_battery_charged, body_battery_max, body_battery_min,
      hydration_intake, hydration_goal,
      source
    ]
  );
  return 'inserted';
}

async function upsertDaySleep(userId, date, patch) {
  const existing = await getDb(
    'SELECT id FROM sleep_data WHERE user_id = ? AND date = ? ORDER BY created_at DESC LIMIT 1',
    [userId, date]
  );
  const score = patch.score !== undefined ? patch.score : null;
  const duration = patch.duration_hours !== undefined ? patch.duration_hours : null;
  const deep = patch.deep_sleep_hours !== undefined ? patch.deep_sleep_hours : null;
  const rem = patch.rem_sleep_hours !== undefined ? patch.rem_sleep_hours : null;
  const bedtime = patch.bedtime !== undefined ? patch.bedtime : null;
  const wake = patch.wake_time !== undefined ? patch.wake_time : null;
  const source = patch.source !== undefined ? patch.source : null;
  if (existing?.id) {
    await runDb(
      `UPDATE sleep_data
          SET score = COALESCE(?, score),
              duration_hours = COALESCE(?, duration_hours),
              deep_sleep_hours = COALESCE(?, deep_sleep_hours),
              rem_sleep_hours = COALESCE(?, rem_sleep_hours),
              bedtime = COALESCE(?, bedtime),
              wake_time = COALESCE(?, wake_time),
              source = COALESCE(?, source)
        WHERE id = ?`,
      [score, duration, deep, rem, bedtime, wake, source, existing.id]
    );
    return 'updated';
  }
  await runDb(
    `INSERT INTO sleep_data
      (user_id, date, score, duration_hours, deep_sleep_hours, rem_sleep_hours, bedtime, wake_time, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, date, score, duration, deep, rem, bedtime, wake, source]
  );
  return 'inserted';
}

// API Routes

// Sleep data endpoints
app.get('/api/sleep', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM sleep_data WHERE user_id = ? ORDER BY date DESC', [userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sleep', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { date, score, duration_hours, deep_sleep_hours, rem_sleep_hours, bedtime, wake_time } = req.body;
    const result = await runDb(
      'INSERT INTO sleep_data (user_id, date, score, duration_hours, deep_sleep_hours, rem_sleep_hours, bedtime, wake_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, date, score, duration_hours, deep_sleep_hours, rem_sleep_hours, bedtime, wake_time]
    );
    res.json({ id: result.lastID, message: 'Sleep data added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity data endpoints
app.get('/api/activity', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM activity_data WHERE user_id = ? ORDER BY date DESC', [userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Biometrics: list types + aggregated time series (used by Trends tab)
app.get('/api/biometrics/types', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb(
      `SELECT DISTINCT type
         FROM biometric_samples
        WHERE user_id = ?
     ORDER BY type ASC`,
      [userId]
    );
    res.json(rows.map(r => r.type).filter(Boolean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/biometrics/series', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const type = String(req.query.type || '').trim();
    if (!type) return res.status(400).json({ error: 'type is required' });

    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;

    const where = ['user_id = ?', 'type = ?', 'value_num IS NOT NULL'];
    const params = [userId, type];
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push(`date(start_at) >= date(?)`);
      params.push(from);
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push(`date(start_at) <= date(?)`);
      params.push(to);
    }

    const rows = await allDb(
      `SELECT date(start_at) AS day,
              AVG(value_num) AS avg,
              MIN(value_num) AS min,
              MAX(value_num) AS max,
              COUNT(*) AS count
         FROM biometric_samples
        WHERE ${where.join(' AND ')}
     GROUP BY date(start_at)
     ORDER BY day ASC`,
      params
    );
    res.json(rows.map(r => ({
      day: r.day,
      avg: r.avg != null ? Number(r.avg) : null,
      min: r.min != null ? Number(r.min) : null,
      max: r.max != null ? Number(r.max) : null,
      count: r.count != null ? Number(r.count) : 0
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/activity', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { date, steps, calories_burned, heart_rate_avg, active_minutes } = req.body;
    const result = await runDb(
      'INSERT INTO activity_data (user_id, date, steps, calories_burned, heart_rate_avg, active_minutes) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, date, steps, calories_burned, heart_rate_avg, active_minutes]
    );
    res.json({ id: result.lastID, message: 'Activity data added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Labs / Biomarkers
app.get('/api/labs', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit || 500)));
    const biomarker = req.query.biomarker ? String(req.query.biomarker).trim() : '';
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;

    const where = ['user_id = ?'];
    const params = [userId];
    if (biomarker) {
      where.push('lower(biomarker) = lower(?)');
      params.push(biomarker);
    }
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push('date >= ?');
      params.push(from);
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push('date <= ?');
      params.push(to);
    }

    const rows = await allDb(
      `SELECT * FROM lab_results
        WHERE ${where.join(' AND ')}
     ORDER BY date DESC, biomarker ASC
        LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/labs/biomarkers', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb(
      `SELECT biomarker, COUNT(*) AS n, MIN(date) AS first_date, MAX(date) AS last_date
         FROM lab_results
        WHERE user_id = ?
     GROUP BY biomarker
     ORDER BY lower(biomarker) ASC`,
      [userId]
    );
    res.json(rows.map(r => ({
      biomarker: r.biomarker,
      n: Number(r.n || 0),
      first_date: r.first_date,
      last_date: r.last_date
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/labs', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    const biomarker = String(req.body?.biomarker || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!biomarker) return res.status(400).json({ error: 'biomarker is required' });

    const value_num = req.body?.value_num != null && req.body.value_num !== '' ? Number(req.body.value_num) : null;
    const value_text = req.body?.value_text != null && String(req.body.value_text).trim() !== '' ? String(req.body.value_text).trim() : null;
    const unit = req.body?.unit != null && String(req.body.unit).trim() !== '' ? String(req.body.unit).trim() : null;
    const ref_low = req.body?.ref_low != null && req.body.ref_low !== '' ? Number(req.body.ref_low) : null;
    const ref_high = req.body?.ref_high != null && req.body.ref_high !== '' ? Number(req.body.ref_high) : null;
    const notes = req.body?.notes != null && String(req.body.notes).trim() !== '' ? String(req.body.notes).trim() : null;
    const source = req.body?.source != null && String(req.body.source).trim() !== '' ? String(req.body.source).trim() : 'manual';

    await runDb(
      `INSERT INTO lab_results
        (user_id, date, biomarker, value_num, value_text, unit, ref_low, ref_high, notes, source, raw_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, date, biomarker) DO UPDATE SET
         value_num = COALESCE(excluded.value_num, lab_results.value_num),
         value_text = COALESCE(excluded.value_text, lab_results.value_text),
         unit = COALESCE(excluded.unit, lab_results.unit),
         ref_low = COALESCE(excluded.ref_low, lab_results.ref_low),
         ref_high = COALESCE(excluded.ref_high, lab_results.ref_high),
         notes = COALESCE(excluded.notes, lab_results.notes),
         source = COALESCE(excluded.source, lab_results.source),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, date, biomarker, value_num, value_text, unit, ref_low, ref_high, notes, source]
    );

    const row = await getDb(
      'SELECT * FROM lab_results WHERE user_id = ? AND date = ? AND biomarker = ? LIMIT 1',
      [userId, date, biomarker]
    );
    res.json({ message: 'Lab result saved', row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/labs/import', labsUpload.single('file'), async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const source = req.body?.source ? String(req.body.source) : 'upload';

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    let rows = [];
    if (ext === '.csv') {
      const text = fs.readFileSync(filePath, 'utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return res.status(400).json({ error: 'Empty CSV' });
      const header = lines[0].split(',').map(s => s.trim());
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const obj = {};
        header.forEach((h, idx) => { obj[h] = cols[idx] != null ? cols[idx].trim() : ''; });
        rows.push(obj);
      }
    } else {
      const wb = XLSX.readFile(filePath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }

    const normKey = (k) => String(k || '').trim().toLowerCase();
    const parseNum = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      const n = Number(s.replace(/[^0-9.+-]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const parseDate = (v) => {
      const s = String(v || '').trim();
      if (!s) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
      return null;
    };

    let inserted = 0;
    const errors = [];
    for (const r of rows) {
      const map = {};
      for (const k of Object.keys(r || {})) map[normKey(k)] = k;

      const dateKey = map['date'] || map['day'] || map['sample date'] || map['collection date'];
      const biomKey = map['biomarker'] || map['marker'] || map['analyte'] || map['test'] || map['name'];
      const valKey = map['value'] || map['result'] || map['value_num'] || map['numeric value'];
      const unitKey = map['unit'] || map['units'];
      const lowKey = map['ref_low'] || map['low'] || map['reference low'] || map['range low'];
      const highKey = map['ref_high'] || map['high'] || map['reference high'] || map['range high'];
      const notesKey = map['notes'] || map['comment'];

      const date = dateKey ? parseDate(r[dateKey]) : null;
      const biomarker = biomKey ? String(r[biomKey]).trim() : '';
      if (!date || !biomarker) {
        errors.push({ row: r, error: 'Missing date or biomarker' });
        continue;
      }

      const value_num = valKey ? parseNum(r[valKey]) : null;
      const value_text = (value_num == null && valKey) ? String(r[valKey] || '').trim() || null : null;
      const unit = unitKey ? String(r[unitKey] || '').trim() || null : null;
      const ref_low = lowKey ? parseNum(r[lowKey]) : null;
      const ref_high = highKey ? parseNum(r[highKey]) : null;
      const notes = notesKey ? String(r[notesKey] || '').trim() || null : null;

      await runDb(
        `INSERT INTO lab_results
          (user_id, date, biomarker, value_num, value_text, unit, ref_low, ref_high, notes, source, raw_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, date, biomarker) DO UPDATE SET
           value_num = COALESCE(excluded.value_num, lab_results.value_num),
           value_text = COALESCE(excluded.value_text, lab_results.value_text),
           unit = COALESCE(excluded.unit, lab_results.unit),
           ref_low = COALESCE(excluded.ref_low, lab_results.ref_low),
           ref_high = COALESCE(excluded.ref_high, lab_results.ref_high),
           notes = COALESCE(excluded.notes, lab_results.notes),
           source = COALESCE(excluded.source, lab_results.source),
           raw_json = COALESCE(excluded.raw_json, lab_results.raw_json),
           updated_at = CURRENT_TIMESTAMP`,
        [userId, date, biomarker, value_num, value_text, unit, ref_low, ref_high, notes, source, JSON.stringify(r)]
      ).catch((e) => {
        errors.push({ row: r, error: e.message });
      });
      inserted++;
    }

    res.json({ message: 'Labs imported', inserted, rows_parsed: rows.length, errors: errors.slice(0, 25) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Nutrition data endpoints
app.get('/api/nutrition', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM nutrition_data WHERE user_id = ? ORDER BY date DESC', [userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nutrition', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { date, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g } = req.body;
    const result = await runDb(
      'INSERT INTO nutrition_data (user_id, date, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, date, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g]
    );
    res.json({ id: result.lastID, message: 'Nutrition data added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Food log endpoints
app.get('/api/food-log', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM food_log WHERE user_id = ? ORDER BY date DESC', [userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/food-log', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { date, time, food_name, calories, protein_g, carbs_g, fat_g, serving_size } = req.body;
    const result = await runDb(
      'INSERT INTO food_log (user_id, date, time, food_name, calories, protein_g, carbs_g, fat_g, serving_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, date, time || null, food_name, calories, protein_g, carbs_g, fat_g, serving_size]
    );
    res.json({ id: result.lastID, message: 'Food log entry added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI estimate for manual food log entry (name + quantity)
app.post('/api/food/estimate', async (req, res) => {
  try {
    reqUserId(req); // enforce auth
    const food_name = String(req.body?.food_name || '').trim();
    const qv = req.body?.quantity_value;
    const quantity_value = qv === null || qv === '' || qv === undefined ? null : Number(qv);
    const quantity_unit = String(req.body?.quantity_unit || '').trim() || 'g';
    if (!food_name) return res.status(400).json({ error: 'food_name is required' });
    if (quantity_value != null && (!Number.isFinite(quantity_value) || quantity_value <= 0)) {
      return res.status(400).json({ error: 'quantity_value must be a positive number' });
    }

    const text = `${food_name}${quantity_value != null ? `, ${quantity_value} ${quantity_unit}` : ''}`;
    const llm = await estimateFoodFromTextLLM({ text }).catch(e => ({ ok: false, error: e.message }));
    if (!llm?.ok) return res.status(500).json({ error: llm?.error || 'Estimate failed' });

    const out = llm.extracted || {};
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Mood data endpoints
app.get('/api/mood', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM mood_data WHERE user_id = ? ORDER BY date DESC', [userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mood', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { date, mood_score, energy_score, stress_score, anxiety_score, notes } = req.body;
    const result = await runDb(
      'INSERT INTO mood_data (user_id, date, mood_score, energy_score, stress_score, anxiety_score, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, date, mood_score, energy_score, stress_score, anxiety_score, notes]
    );
    res.json({ id: result.lastID, message: 'Mood data added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supplements endpoints
app.get('/api/supplements', async (req, res) => {
  try {
    // Backward-compatible: return regimens list (new model)
    const userId = reqUserId(req);
    const rows = await allDb(
      'SELECT * FROM supplement_regimens WHERE user_id = ? AND is_active = 1 ORDER BY lower(name) ASC',
      [userId]
    );
    res.json(rows.map(r => ({
      ...r,
      default_times: r.default_times_json ? (safeJsonParse(r.default_times_json) || []) : [],
      days_of_week: r.days_of_week_json ? (safeJsonParse(r.days_of_week_json) || []) : []
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supplements', async (req, res) => {
  try {
    // Backward-compatible create: treat as a regimen (dosage/timing as free text)
    const userId = reqUserId(req);
    const { name, dosage, timing, notes, start_date, end_date } = req.body;
    const times = [];
    const t = String(timing || '').toLowerCase();
    if (t.includes('morning')) times.push('08:00');
    if (t.includes('evening') || t.includes('night')) times.push('20:00');
    if (t.includes('midday') || t.includes('lunch')) times.push('12:30');
    const timesJson = times.length ? JSON.stringify(times) : null;

    const result = await runDb(
      `INSERT INTO supplement_regimens
        (user_id, name, dose_text, default_times_json, start_date, end_date, notes, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      [userId, name, dosage || null, timesJson, start_date || null, end_date || null, notes || null]
    );
    res.json({ id: result.lastID, message: 'Supplement regimen added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New supplements model
app.get('/api/supplements/regimens', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb(
      `SELECT * FROM supplement_regimens
        WHERE user_id = ?
          AND is_active = 1
     ORDER BY lower(name) ASC`,
      [userId]
    );
    res.json(rows.map(r => ({
      ...r,
      default_times: r.default_times_json ? (safeJsonParse(r.default_times_json) || []) : [],
      days_of_week: r.days_of_week_json ? (safeJsonParse(r.days_of_week_json) || []) : []
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/supplements/regimens', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const dose_value = req.body?.dose_value != null && req.body.dose_value !== '' ? Number(req.body.dose_value) : null;
    const dose_unit = req.body?.dose_unit != null && String(req.body.dose_unit).trim() !== '' ? String(req.body.dose_unit).trim() : null;
    const dose_text = req.body?.dose_text != null && String(req.body.dose_text).trim() !== '' ? String(req.body.dose_text).trim() : null;
    const frequency = ['daily', 'weekdays', 'custom'].includes(String(req.body?.frequency || 'daily')) ? String(req.body?.frequency || 'daily') : 'daily';
    const days_of_week = Array.isArray(req.body?.days_of_week) ? req.body.days_of_week : null;
    const default_times = Array.isArray(req.body?.default_times) ? req.body.default_times : [];
    const start_date = req.body?.start_date ? String(req.body.start_date) : null;
    const end_date = req.body?.end_date ? String(req.body.end_date) : null;
    const notes = req.body?.notes ? String(req.body.notes) : null;

    const r = await runDb(
      `INSERT INTO supplement_regimens
        (user_id, name, dose_value, dose_unit, dose_text, frequency, days_of_week_json, default_times_json, start_date, end_date, notes, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      [
        userId,
        name,
        Number.isFinite(dose_value) ? dose_value : null,
        dose_unit,
        dose_text,
        frequency,
        days_of_week ? JSON.stringify(days_of_week) : null,
        default_times?.length ? JSON.stringify(default_times) : null,
        start_date,
        end_date,
        notes
      ]
    );
    const row = await getDb('SELECT * FROM supplement_regimens WHERE id = ? AND user_id = ?', [r.lastID, userId]);
    res.json({ message: 'Regimen created', regimen: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/supplements/regimens/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    const existing = await getDb('SELECT * FROM supplement_regimens WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const patch = req.body || {};
    const name = patch.name != null ? String(patch.name).trim() : null;
    const dose_value = patch.dose_value != null && patch.dose_value !== '' ? Number(patch.dose_value) : null;
    const dose_unit = patch.dose_unit != null ? String(patch.dose_unit).trim() : null;
    const dose_text = patch.dose_text != null ? String(patch.dose_text).trim() : null;
    const frequency = patch.frequency != null ? String(patch.frequency) : null;
    const default_times = Array.isArray(patch.default_times) ? patch.default_times : null;
    const notes = patch.notes != null ? String(patch.notes) : null;
    const is_active = patch.is_active != null ? (patch.is_active ? 1 : 0) : null;

    await runDb(
      `UPDATE supplement_regimens
          SET name = COALESCE(?, name),
              dose_value = COALESCE(?, dose_value),
              dose_unit = COALESCE(?, dose_unit),
              dose_text = COALESCE(?, dose_text),
              frequency = COALESCE(?, frequency),
              default_times_json = COALESCE(?, default_times_json),
              notes = COALESCE(?, notes),
              is_active = COALESCE(?, is_active),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?`,
      [
        name || null,
        Number.isFinite(dose_value) ? dose_value : null,
        dose_unit || null,
        dose_text || null,
        (['daily', 'weekdays', 'custom'].includes(frequency) ? frequency : null),
        default_times ? (default_times.length ? JSON.stringify(default_times) : null) : null,
        notes || null,
        is_active,
        id,
        userId
      ]
    );
    const row = await getDb('SELECT * FROM supplement_regimens WHERE id = ? AND user_id = ?', [id, userId]);
    res.json({ message: 'Regimen updated', regimen: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/supplements/regimens/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    await runDb(`UPDATE supplement_regimens SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [id, userId]);
    res.json({ message: 'Regimen archived' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/supplements/day', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const regs = await allDb(
      `SELECT * FROM supplement_regimens
        WHERE user_id = ?
          AND is_active = 1
          AND (start_date IS NULL OR start_date <= ?)
          AND (end_date IS NULL OR end_date >= ?)
     ORDER BY lower(name) ASC`,
      [userId, date, date]
    );
    const ovs = await allDb(
      `SELECT * FROM supplement_day_overrides
        WHERE user_id = ? AND date = ?`,
      [userId, date]
    );
    const ovMap = new Map(ovs.map(o => [o.regimen_id, o]));

    const items = regs.map(r => {
      const ov = ovMap.get(r.id);
      const default_times = r.default_times_json ? (safeJsonParse(r.default_times_json) || []) : [];
      const default_time = default_times[0] || null;
      const effective_taken = ov?.taken != null ? !!ov.taken : true; // assume taken by default
      const effective_time = ov?.time_text != null ? ov.time_text : default_time;
      const effective_dose_value = ov?.dose_value != null ? ov.dose_value : r.dose_value;
      const effective_dose_unit = ov?.dose_unit != null ? ov.dose_unit : r.dose_unit;
      const effective_dose_text = r.dose_text || null;
      return {
        regimen: {
          id: r.id,
          name: r.name,
          dose_value: r.dose_value,
          dose_unit: r.dose_unit,
          dose_text: r.dose_text,
          default_times
        },
        date,
        overridden: !!ov,
        taken: effective_taken,
        time_text: effective_time,
        dose_value: effective_dose_value,
        dose_unit: effective_dose_unit,
        notes: ov?.notes ?? null
      };
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/supplements/day', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    const regimen_id = Number(req.body?.regimen_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!Number.isFinite(regimen_id)) return res.status(400).json({ error: 'regimen_id is required' });

    const taken = req.body?.taken != null ? (req.body.taken ? 1 : 0) : null;
    const time_text = req.body?.time_text != null && String(req.body.time_text).trim() !== '' ? String(req.body.time_text).trim() : null;
    const dose_value = req.body?.dose_value != null && req.body.dose_value !== '' ? Number(req.body.dose_value) : null;
    const dose_unit = req.body?.dose_unit != null && String(req.body.dose_unit).trim() !== '' ? String(req.body.dose_unit).trim() : null;
    const notes = req.body?.notes != null && String(req.body.notes).trim() !== '' ? String(req.body.notes).trim() : null;

    await runDb(
      `INSERT INTO supplement_day_overrides (user_id, date, regimen_id, taken, time_text, dose_value, dose_unit, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, date, regimen_id) DO UPDATE SET
         taken = COALESCE(excluded.taken, supplement_day_overrides.taken),
         time_text = COALESCE(excluded.time_text, supplement_day_overrides.time_text),
         dose_value = COALESCE(excluded.dose_value, supplement_day_overrides.dose_value),
         dose_unit = COALESCE(excluded.dose_unit, supplement_day_overrides.dose_unit),
         notes = COALESCE(excluded.notes, supplement_day_overrides.notes),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, date, regimen_id, taken, time_text, Number.isFinite(dose_value) ? dose_value : null, dose_unit, notes]
    );
    res.json({ message: 'Saved day override' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/supplements/day/clear', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    const regimen_id = Number(req.body?.regimen_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!Number.isFinite(regimen_id)) return res.status(400).json({ error: 'regimen_id is required' });
    await runDb('DELETE FROM supplement_day_overrides WHERE user_id = ? AND date = ? AND regimen_id = ?', [userId, date, regimen_id]);
    res.json({ message: 'Cleared override' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Medications endpoints
app.get('/api/medications', async (req, res) => {
  try {
    // Backward-compatible: return regimens list (new model)
    const userId = reqUserId(req);
    const rows = await allDb(
      'SELECT * FROM medication_regimens WHERE user_id = ? AND is_active = 1 ORDER BY lower(name) ASC',
      [userId]
    );
    res.json(rows.map(r => ({
      ...r,
      default_times: r.default_times_json ? (safeJsonParse(r.default_times_json) || []) : [],
      days_of_week: r.days_of_week_json ? (safeJsonParse(r.days_of_week_json) || []) : []
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/medications', async (req, res) => {
  try {
    // Backward-compatible create: treat as a regimen (dosage/frequency as free text)
    const userId = reqUserId(req);
    const { name, dosage, frequency, start_date, end_date, notes } = req.body;
    const times = [];
    const f = String(frequency || '').toLowerCase();
    if (f.includes('morning') || f.includes('am')) times.push('08:00');
    if (f.includes('evening') || f.includes('night') || f.includes('pm')) times.push('20:00');
    if (f.includes('midday') || f.includes('noon') || f.includes('lunch')) times.push('12:30');
    const timesJson = times.length ? JSON.stringify(times) : null;
    const freqNorm = (f.includes('weekday') || f.includes('mon') || f.includes('tue') || f.includes('wed') || f.includes('thu') || f.includes('fri')) ? 'weekdays' : 'daily';

    const result = await runDb(
      `INSERT INTO medication_regimens
        (user_id, name, dose_text, frequency, default_times_json, start_date, end_date, notes, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      [userId, name, dosage || null, freqNorm, timesJson, start_date || null, end_date || null, notes || null]
    );
    res.json({ id: result.lastID, message: 'Medication regimen added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New medications model
app.get('/api/medications/regimens', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb(
      `SELECT * FROM medication_regimens
        WHERE user_id = ?
          AND is_active = 1
     ORDER BY lower(name) ASC`,
      [userId]
    );
    res.json(rows.map(r => ({
      ...r,
      default_times: r.default_times_json ? (safeJsonParse(r.default_times_json) || []) : [],
      days_of_week: r.days_of_week_json ? (safeJsonParse(r.days_of_week_json) || []) : []
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/medications/regimens', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const dose_value = req.body?.dose_value != null && req.body.dose_value !== '' ? Number(req.body.dose_value) : null;
    const dose_unit = req.body?.dose_unit != null && String(req.body.dose_unit).trim() !== '' ? String(req.body.dose_unit).trim() : null;
    const dose_text = req.body?.dose_text != null && String(req.body.dose_text).trim() !== '' ? String(req.body.dose_text).trim() : null;
    const frequency = ['daily', 'weekdays', 'custom'].includes(String(req.body?.frequency || 'daily')) ? String(req.body?.frequency || 'daily') : 'daily';
    const days_of_week = Array.isArray(req.body?.days_of_week) ? req.body.days_of_week : null;
    const default_times = Array.isArray(req.body?.default_times) ? req.body.default_times : [];
    const start_date = req.body?.start_date ? String(req.body.start_date) : null;
    const end_date = req.body?.end_date ? String(req.body.end_date) : null;
    const notes = req.body?.notes ? String(req.body.notes) : null;

    const r = await runDb(
      `INSERT INTO medication_regimens
        (user_id, name, dose_value, dose_unit, dose_text, frequency, days_of_week_json, default_times_json, start_date, end_date, notes, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      [
        userId,
        name,
        Number.isFinite(dose_value) ? dose_value : null,
        dose_unit,
        dose_text,
        frequency,
        days_of_week ? JSON.stringify(days_of_week) : null,
        default_times?.length ? JSON.stringify(default_times) : null,
        start_date,
        end_date,
        notes
      ]
    );
    const row = await getDb('SELECT * FROM medication_regimens WHERE id = ? AND user_id = ?', [r.lastID, userId]);
    res.json({ message: 'Regimen created', regimen: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/medications/regimens/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    const existing = await getDb('SELECT * FROM medication_regimens WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const patch = req.body || {};
    const name = patch.name != null ? String(patch.name).trim() : null;
    const dose_value = patch.dose_value != null && patch.dose_value !== '' ? Number(patch.dose_value) : null;
    const dose_unit = patch.dose_unit != null ? String(patch.dose_unit).trim() : null;
    const dose_text = patch.dose_text != null ? String(patch.dose_text).trim() : null;
    const frequency = patch.frequency != null ? String(patch.frequency) : null;
    const default_times = Array.isArray(patch.default_times) ? patch.default_times : null;
    const notes = patch.notes != null ? String(patch.notes) : null;
    const is_active = patch.is_active != null ? (patch.is_active ? 1 : 0) : null;

    await runDb(
      `UPDATE medication_regimens
          SET name = COALESCE(?, name),
              dose_value = COALESCE(?, dose_value),
              dose_unit = COALESCE(?, dose_unit),
              dose_text = COALESCE(?, dose_text),
              frequency = COALESCE(?, frequency),
              default_times_json = COALESCE(?, default_times_json),
              notes = COALESCE(?, notes),
              is_active = COALESCE(?, is_active),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?`,
      [
        name || null,
        Number.isFinite(dose_value) ? dose_value : null,
        dose_unit || null,
        dose_text || null,
        (['daily', 'weekdays', 'custom'].includes(frequency) ? frequency : null),
        default_times ? (default_times.length ? JSON.stringify(default_times) : null) : null,
        notes || null,
        is_active,
        id,
        userId
      ]
    );
    const row = await getDb('SELECT * FROM medication_regimens WHERE id = ? AND user_id = ?', [id, userId]);
    res.json({ message: 'Regimen updated', regimen: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/medications/regimens/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    await runDb(`UPDATE medication_regimens SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [id, userId]);
    res.json({ message: 'Regimen archived' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/medications/day', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const regs = await allDb(
      `SELECT * FROM medication_regimens
        WHERE user_id = ?
          AND is_active = 1
          AND (start_date IS NULL OR start_date <= ?)
          AND (end_date IS NULL OR end_date >= ?)
     ORDER BY lower(name) ASC`,
      [userId, date, date]
    );
    const ovs = await allDb(
      `SELECT * FROM medication_day_overrides
        WHERE user_id = ? AND date = ?`,
      [userId, date]
    );
    const ovMap = new Map(ovs.map(o => [o.regimen_id, o]));

    const items = regs.map(r => {
      const ov = ovMap.get(r.id);
      const default_times = r.default_times_json ? (safeJsonParse(r.default_times_json) || []) : [];
      const default_time = default_times[0] || null;
      const effective_taken = ov?.taken != null ? !!ov.taken : true; // assume taken by default
      const effective_time = ov?.time_text != null ? ov.time_text : default_time;
      const effective_dose_value = ov?.dose_value != null ? ov.dose_value : r.dose_value;
      const effective_dose_unit = ov?.dose_unit != null ? ov.dose_unit : r.dose_unit;
      const effective_dose_text = r.dose_text || null;
      return {
        regimen: {
          id: r.id,
          name: r.name,
          dose_value: r.dose_value,
          dose_unit: r.dose_unit,
          dose_text: r.dose_text,
          default_times
        },
        date,
        overridden: !!ov,
        taken: effective_taken,
        time_text: effective_time,
        dose_value: effective_dose_value,
        dose_unit: effective_dose_unit,
        notes: ov?.notes ?? null
      };
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/medications/day', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    const regimen_id = Number(req.body?.regimen_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!Number.isFinite(regimen_id)) return res.status(400).json({ error: 'regimen_id is required' });

    const taken = req.body?.taken != null ? (req.body.taken ? 1 : 0) : null;
    const time_text = req.body?.time_text != null && String(req.body.time_text).trim() !== '' ? String(req.body.time_text).trim() : null;
    const dose_value = req.body?.dose_value != null && req.body.dose_value !== '' ? Number(req.body.dose_value) : null;
    const dose_unit = req.body?.dose_unit != null && String(req.body.dose_unit).trim() !== '' ? String(req.body.dose_unit).trim() : null;
    const notes = req.body?.notes != null && String(req.body.notes).trim() !== '' ? String(req.body.notes).trim() : null;

    await runDb(
      `INSERT INTO medication_day_overrides (user_id, date, regimen_id, taken, time_text, dose_value, dose_unit, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, date, regimen_id) DO UPDATE SET
         taken = COALESCE(excluded.taken, medication_day_overrides.taken),
         time_text = COALESCE(excluded.time_text, medication_day_overrides.time_text),
         dose_value = COALESCE(excluded.dose_value, medication_day_overrides.dose_value),
         dose_unit = COALESCE(excluded.dose_unit, medication_day_overrides.dose_unit),
         notes = COALESCE(excluded.notes, medication_day_overrides.notes),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, date, regimen_id, taken, time_text, Number.isFinite(dose_value) ? dose_value : null, dose_unit, notes]
    );
    res.json({ message: 'Saved day override' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/medications/day/clear', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    const regimen_id = Number(req.body?.regimen_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!Number.isFinite(regimen_id)) return res.status(400).json({ error: 'regimen_id is required' });
    await runDb('DELETE FROM medication_day_overrides WHERE user_id = ? AND date = ? AND regimen_id = ?', [userId, date, regimen_id]);
    res.json({ message: 'Cleared override' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Genetic data upload endpoint
app.post('/api/genetic-upload', upload.single('geneticFile'), (req, res) => {
  const userId = reqUserId(req);
  console.log('File upload received:', req.file ? {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  } : 'No file');
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Please make sure you selected a file.' });
  }

  const filePath = req.file.path;
  const filename = req.file.originalname;
  const fileExtension = path.extname(filename).toLowerCase();
  
  console.log('Processing file:', filename, 'Extension:', fileExtension);
  
  // Handle Excel files (.xlsx, .xls)
  if (fileExtension === '.xlsx' || fileExtension === '.xls') {
    try {
      // Read Excel file
      const workbook = XLSX.readFile(filePath);
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      
      // Convert to CSV format
      const csvData = XLSX.utils.sheet_to_csv(worksheet);
      
      // Analyze the data
      const analysisResults = analyzeGeneticData(csvData);
      
      // Store in database
      db.run(
        'INSERT INTO genetic_data (user_id, filename, data, analysis_results) VALUES (?, ?, ?, ?)',
        [userId, filename, csvData, JSON.stringify(analysisResults)],
        function(err) {
          if (err) {
            // Clean up uploaded file
            fs.unlink(filePath, (unlinkErr) => {
              if (unlinkErr) console.error('Error deleting file:', unlinkErr);
            });
            return res.status(500).json({ error: err.message });
          }
          
          // Clean up uploaded file
          fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error('Error deleting file:', unlinkErr);
          });
          
          res.json({ 
            id: this.lastID, 
            message: 'Genetic data uploaded and analyzed successfully',
            analysis: analysisResults
          });
        }
      );
    } catch (error) {
      // Clean up uploaded file
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting file:', unlinkErr);
      });
      return res.status(500).json({ error: `Error processing Excel file: ${error.message}` });
    }
  } else {
    // Handle CSV files
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        return res.status(500).json({ error: 'Error reading file' });
      }

      // Basic genetic data analysis (placeholder)
      const analysisResults = analyzeGeneticData(data);

      db.run(
        'INSERT INTO genetic_data (user_id, filename, data, analysis_results) VALUES (?, ?, ?, ?)',
        [userId, filename, data, JSON.stringify(analysisResults)],
        function(err) {
          if (err) {
            // Clean up uploaded file
            fs.unlink(filePath, (unlinkErr) => {
              if (unlinkErr) console.error('Error deleting file:', unlinkErr);
            });
            return res.status(500).json({ error: err.message });
          }
          
          // Clean up uploaded file
          fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error('Error deleting file:', unlinkErr);
          });
          
          res.json({ 
            id: this.lastID, 
            message: 'Genetic data uploaded and analyzed successfully',
            analysis: analysisResults
          });
        }
      );
    });
  }
});

// Journal endpoints
app.get('/api/journal', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb(
      `SELECT j.*, 
              ji.mood_score, ji.energy_score, ji.stress_score, ji.anxiety_score, ji.sentiment, ji.tags, ji.summary
         FROM journal_entries j
    LEFT JOIN (
      SELECT ji1.*
        FROM journal_insights ji1
        JOIN (
          SELECT journal_id, MAX(created_at) AS max_created
            FROM journal_insights
        GROUP BY journal_id
        ) latest
          ON latest.journal_id = ji1.journal_id AND latest.max_created = ji1.created_at
    ) ji
           ON ji.journal_id = j.id
        WHERE j.user_id = ?
     ORDER BY j.date DESC`,
      [userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/journal/:date', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = req.params.date;
    const row = await getDb('SELECT * FROM journal_entries WHERE user_id = ? AND date = ?', [userId, date]);
    if (!row) return res.status(404).json({ error: 'Journal entry not found' });
    const insights = await allDb(
      'SELECT * FROM journal_insights WHERE user_id = ? AND journal_id = ? ORDER BY created_at DESC',
      [userId, row.id]
    );
    res.json({ ...row, insights: insights.map(i => ({...i, extracted_json: i.extracted_json ? JSON.parse(i.extracted_json) : null, tags: i.tags ? JSON.parse(i.tags) : [] })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/journal', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { date, title, content, run_insights } = req.body;
    if (!date || !content) return res.status(400).json({ error: 'date and content are required' });

    // Upsert entry (per-user)
    const existing = await getDb('SELECT id FROM journal_entries WHERE user_id = ? AND date = ?', [userId, date]);
    if (existing?.id) {
      await runDb(
        `UPDATE journal_entries
            SET title = ?,
                content = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?`,
        [title || null, content, existing.id, userId]
      );
    } else {
      await runDb(
        `INSERT INTO journal_entries (user_id, date, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, date, title || null, content]
      );
    }

    const entry = await getDb('SELECT * FROM journal_entries WHERE user_id = ? AND date = ?', [userId, date]);

    let insights = null;
    if (String(run_insights) === 'true' || run_insights === true) {
      const extracted = extractJournalInsightsLocal(content);
      await runDb(
        `INSERT INTO journal_insights
          (user_id, journal_id, mood_score, energy_score, stress_score, anxiety_score, sentiment, tags, summary, extracted_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          entry.id,
          extracted.mood_score,
          extracted.energy_score,
          extracted.stress_score,
          extracted.anxiety_score,
          extracted.sentiment,
          JSON.stringify(extracted.tags || []),
          extracted.summary,
          JSON.stringify(extracted.extracted || {})
        ]
      );

      // Push into mood_data (per-user) for correlations
      const moodExisting = await getDb('SELECT id FROM mood_data WHERE user_id = ? AND date = ? ORDER BY created_at DESC LIMIT 1', [userId, date]);
      if (moodExisting?.id) {
        await runDb(
          `UPDATE mood_data
              SET mood_score = ?,
                  energy_score = ?,
                  stress_score = ?,
                  anxiety_score = ?,
                  notes = COALESCE(notes, ?)
            WHERE id = ? AND user_id = ?`,
          [extracted.mood_score, extracted.energy_score, extracted.stress_score, extracted.anxiety_score, 'Auto-extracted from journal', moodExisting.id, userId]
        );
      } else {
        await runDb(
          `INSERT INTO mood_data (user_id, date, mood_score, energy_score, stress_score, anxiety_score, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, date, extracted.mood_score, extracted.energy_score, extracted.stress_score, extracted.anxiety_score, 'Auto-extracted from journal']
        );
      }

      insights = extracted;
    }

    // LLM extraction (optional; uses OPENAI_API_KEY)
    const llm = await extractJournalSignalsLLM({ text: content }).catch(e => ({ ok: false, error: e.message }));
    if (llm?.ok && llm.extracted) {
      await runDb(
        `INSERT INTO insight_events (user_id, kind, occurred_at, ref_table, ref_id, extracted_json)
         VALUES (?, 'journal_extraction', ?, 'journal_entries', ?, ?)`,
        [userId, `${date}T12:00:00.000Z`, entry.id, JSON.stringify(llm.extracted)]
      ).catch(() => {});

      // Optionally mirror inferred scores into journal_insights (latest)
      const inf = llm.extracted.inferred || {};
      const mood_score = inf.mood_score_1_10 ?? null;
      const stress_score = inf.stress_score_1_10 ?? null;
      const energy_score = inf.energy_score_1_10 ?? null;
      const anxiety_score = inf.anxiety_score_1_10 ?? null;
      if ([mood_score, stress_score, energy_score, anxiety_score].some(v => v != null)) {
        await runDb(
          `INSERT INTO journal_insights
            (user_id, journal_id, mood_score, energy_score, stress_score, anxiety_score, sentiment, tags, summary, extracted_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            entry.id,
            mood_score,
            energy_score,
            stress_score,
            anxiety_score,
            llm.extracted.confidence_0_1 ?? null,
            JSON.stringify(llm.extracted.tags || []),
            llm.extracted.summary || null,
            JSON.stringify(llm.extracted)
          ]
        ).catch(() => {});
      }
    }

    res.json({ message: 'Journal saved', entry, insights, llm_ok: !!llm?.ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/journal/:date/analyze', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = req.params.date;
    const entry = await getDb('SELECT * FROM journal_entries WHERE user_id = ? AND date = ?', [userId, date]);
    if (!entry) return res.status(404).json({ error: 'Journal entry not found' });

    const extracted = extractJournalInsightsLocal(entry.content);
    await runDb(
      `INSERT INTO journal_insights
        (user_id, journal_id, mood_score, energy_score, stress_score, anxiety_score, sentiment, tags, summary, extracted_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        entry.id,
        extracted.mood_score,
        extracted.energy_score,
        extracted.stress_score,
        extracted.anxiety_score,
        extracted.sentiment,
        JSON.stringify(extracted.tags || []),
        extracted.summary,
        JSON.stringify(extracted.extracted || {})
      ]
    );
    // LLM extraction (optional)
    const llm = await extractJournalSignalsLLM({ text: entry.content }).catch(e => ({ ok: false, error: e.message }));
    if (llm?.ok && llm.extracted) {
      await runDb(
        `INSERT INTO insight_events (user_id, kind, occurred_at, ref_table, ref_id, extracted_json)
         VALUES (?, 'journal_extraction', ?, 'journal_entries', ?, ?)`,
        [userId, `${date}T12:00:00.000Z`, entry.id, JSON.stringify(llm.extracted)]
      ).catch(() => {});
    }
    res.json({ message: 'Journal analyzed', date, insights: extracted, llm_ok: !!llm?.ok, llm: llm?.ok ? llm.extracted : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Food photo upload + analysis
app.post('/api/food-photo/upload', photoUpload.single('photo'), async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const date = req.body.date;
    if (!date) return res.status(400).json({ error: 'date is required' });

    const notes = req.body.notes || '';
    const addToNutrition = String(req.body.addToNutrition) === 'true';
    const addToFoodLog = String(req.body.addToFoodLog) === 'true';

    const photoRow = await runDb(
      `INSERT INTO food_photos (user_id, date, filename, original_name, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, date, req.file.filename, req.file.originalname || null, req.file.mimetype || null, req.file.size || null]
    );

    const estimate = estimateFoodFromNotesLocal(notes);
    const insightRow = await runDb(
      `INSERT INTO food_photo_insights
        (user_id, photo_id, dish_name, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, micronutrients_json, confidence, extracted_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        photoRow.lastID,
        estimate.dish,
        estimate.cal,
        estimate.p,
        estimate.c,
        estimate.f,
        estimate.micro?.fiber_g || null,
        estimate.micro?.sugar_g || null,
        JSON.stringify(estimate.micro || {}),
        estimate.conf,
        JSON.stringify({ notes })
      ]
    );

    const logged = { nutrition: false, food_log: false };
    if (addToNutrition) {
      await upsertNutritionAdd(userId, date, {
        calories: estimate.cal,
        protein_g: estimate.p,
        carbs_g: estimate.c,
        fat_g: estimate.f,
        fiber_g: estimate.micro?.fiber_g || 0,
        sugar_g: estimate.micro?.sugar_g || 0
      });
      logged.nutrition = true;
    }
    if (addToFoodLog) {
      await runDb(
        `INSERT INTO food_log (user_id, date, time, food_name, calories, protein_g, carbs_g, fat_g, serving_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, date, null, estimate.dish, estimate.cal, estimate.p, estimate.c, estimate.f, notes ? `Notes: ${notes}` : null]
      );
      logged.food_log = true;
    }

    res.json({
      message: 'Food photo uploaded and analyzed',
      photo: {
        id: photoRow.lastID,
        url: `/api/uploads/photos/${req.file.filename}`,
        date
      },
      insight: {
        id: insightRow.lastID,
        dish_name: estimate.dish,
        calories: estimate.cal,
        protein_g: estimate.p,
        carbs_g: estimate.c,
        fat_g: estimate.f,
        fiber_g: estimate.micro?.fiber_g || null,
        sugar_g: estimate.micro?.sugar_g || null,
        micronutrients: estimate.micro || {},
        confidence: estimate.conf
      },
      logged
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Packaging photo upload + AI extraction (ingredients + nutrition label)
app.post('/api/food-packaging/analyze', photoUpload.array('photos', 6), async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    if (!date) return res.status(400).json({ error: 'date is required' });
    const gtin = String(req.body?.gtin || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const model = String(req.body?.model || '').trim();
    const addToNutrition = String(req.body?.addToNutrition) === 'true';
    const addToFoodLog = String(req.body?.addToFoodLog) === 'true';

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No images uploaded' });

    // Convert to data URLs for vision models
    const imageDataUrls = [];
    for (const f of files.slice(0, 6)) {
      const mime = f.mimetype || 'image/jpeg';
      const buf = fs.readFileSync(f.path);
      const b64 = buf.toString('base64');
      imageDataUrls.push(`data:${mime};base64,${b64}`);
    }

    const llm = await analyzeFoodPackagingLLM({ imageDataUrls, hints: notes, model: model || undefined }).catch(e => ({ ok: false, error: e.message }));
    if (!llm?.ok) {
      return res.status(500).json({ error: llm?.error || 'Packaging analysis failed (LLM not configured?)' });
    }
    const a = llm.extracted || {};
    const nutrition = a.nutrition || {};
    const perServing = nutrition.per_serving || {};
    const per100 = nutrition.per_100g || {};

    const saved = { product: false };
    if (gtin) {
      // Upsert to local product catalog so barcode lookups work later
      const prodPayload = {
        gtin,
        name: a.product_name || null,
        brand: a.brand || null,
        retailer: null,
        image_url: null,
        ingredients: a.ingredients || null,
        serving_size: a.serving_size || null,
        source: 'packaging_scan',
        nutrition: {
          calories_kcal_100g: per100.calories_kcal ?? null,
          protein_g_100g: per100.protein_g ?? null,
          carbs_g_100g: per100.carbs_g ?? null,
          fat_g_100g: per100.fat_g ?? null,
          fiber_g_100g: per100.fiber_g ?? null,
          sugar_g_100g: per100.sugar_g ?? null,
          salt_g_100g: per100.salt_g ?? null,
          saturated_fat_g_100g: per100.sat_fat_g ?? null,
          micronutrients: { allergens: a.allergens || null }
        }
      };
      await runDb(
        `INSERT INTO products (gtin, name, brand, retailer, image_url, ingredients, serving_size, source, source_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(gtin) DO UPDATE SET
           name = COALESCE(excluded.name, products.name),
           brand = COALESCE(excluded.brand, products.brand),
           ingredients = COALESCE(excluded.ingredients, products.ingredients),
           serving_size = COALESCE(excluded.serving_size, products.serving_size),
           source = COALESCE(excluded.source, products.source),
           source_json = COALESCE(excluded.source_json, products.source_json),
           updated_at = CURRENT_TIMESTAMP`,
        [gtin, prodPayload.name, prodPayload.brand, null, null, prodPayload.ingredients, prodPayload.serving_size, 'packaging_scan', JSON.stringify(prodPayload)]
      ).catch(() => {});
      if (prodPayload.nutrition) {
        const n = prodPayload.nutrition;
        await runDb(
          `INSERT INTO product_nutrition
            (gtin, calories_kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, sugar_g_100g, salt_g_100g, saturated_fat_g_100g, sodium_mg_100g, micronutrients_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(gtin) DO UPDATE SET
             calories_kcal_100g = COALESCE(excluded.calories_kcal_100g, product_nutrition.calories_kcal_100g),
             protein_g_100g = COALESCE(excluded.protein_g_100g, product_nutrition.protein_g_100g),
             carbs_g_100g = COALESCE(excluded.carbs_g_100g, product_nutrition.carbs_g_100g),
             fat_g_100g = COALESCE(excluded.fat_g_100g, product_nutrition.fat_g_100g),
             fiber_g_100g = COALESCE(excluded.fiber_g_100g, product_nutrition.fiber_g_100g),
             sugar_g_100g = COALESCE(excluded.sugar_g_100g, product_nutrition.sugar_g_100g),
             salt_g_100g = COALESCE(excluded.salt_g_100g, product_nutrition.salt_g_100g),
             saturated_fat_g_100g = COALESCE(excluded.saturated_fat_g_100g, product_nutrition.saturated_fat_g_100g),
             micronutrients_json = COALESCE(excluded.micronutrients_json, product_nutrition.micronutrients_json),
             updated_at = CURRENT_TIMESTAMP`,
          [
            gtin,
            n.calories_kcal_100g ?? null,
            n.protein_g_100g ?? null,
            n.carbs_g_100g ?? null,
            n.fat_g_100g ?? null,
            n.fiber_g_100g ?? null,
            n.sugar_g_100g ?? null,
            n.salt_g_100g ?? null,
            n.saturated_fat_g_100g ?? null,
            null,
            JSON.stringify(n.micronutrients || {})
          ]
        ).catch(() => {});
      }
      saved.product = true;
    }

    // If logging: prefer per-serving, else per-100g (as a fallback)
    const logged = { nutrition: false, food_log: false };
    const use = (perServing.calories_kcal != null || perServing.protein_g != null || perServing.carbs_g != null || perServing.fat_g != null) ? perServing : per100;
    const servingLabel = a.serving_size || (use === per100 ? '100g' : null);
    const cal = use.calories_kcal != null ? Number(use.calories_kcal) : null;
    const p = use.protein_g != null ? Number(use.protein_g) : null;
    const c = use.carbs_g != null ? Number(use.carbs_g) : null;
    const f = use.fat_g != null ? Number(use.fat_g) : null;

    if (addToNutrition && cal != null) {
      await upsertNutritionAdd(userId, date, {
        calories: cal,
        protein_g: p || 0,
        carbs_g: c || 0,
        fat_g: f || 0,
        fiber_g: use.fiber_g || 0,
        sugar_g: use.sugar_g || 0
      });
      logged.nutrition = true;
    }
    if (addToFoodLog) {
      await runDb(
        `INSERT INTO food_log (user_id, date, time, food_name, calories, protein_g, carbs_g, fat_g, serving_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          date,
          null,
          a.product_name || (gtin ? `Product (GTIN ${gtin})` : 'Product'),
          cal,
          p,
          c,
          f,
          servingLabel
        ]
      ).catch(() => {});
      logged.food_log = true;
    }

    return res.json({
      message: 'Packaging analyzed',
      gtin: gtin || null,
      model_used: model || null,
      analysis: a,
      saved,
      logged
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Model listing (OpenRouter) for client-side dropdowns (pricing included)
app.get('/api/llm/models', async (req, res) => {
  try {
    const provider = String(process.env.LLM_PROVIDER || '').toLowerCase();
    if (provider !== 'openrouter') {
      return res.json({ provider: provider || 'unknown', defaultModel: process.env.LLM_MODEL || null, models: [] });
    }
    const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    const defaultModel = process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || null;

    const resp = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
        ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
        ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {})
      }
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return res.status(502).json({ error: `OpenRouter /models failed: ${resp.status} ${t.slice(0, 200)}` });
    }
    const data = await resp.json().catch(() => ({}));
    const rows = Array.isArray(data?.data) ? data.data : [];

    const models = rows
      .map(m => ({
        id: m?.id || null,
        name: m?.name || null,
        context_length: m?.context_length ?? null,
        pricing: m?.pricing || {},
        architecture: m?.architecture || {}
      }))
      .filter(m => m.id)
      .filter(m => Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.includes('image'))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return res.json({ provider: 'openrouter', defaultModel, models });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// User settings (minimal for now)
app.get('/api/user/settings', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const row = await getDb('SELECT calorie_goal_kcal FROM users WHERE id = ? LIMIT 1', [userId]);
    return res.json({ calorie_goal_kcal: row?.calorie_goal_kcal ?? null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/user/settings', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const v = req.body?.calorie_goal_kcal;
    const goal = v === null || v === '' || v === undefined ? null : Number(v);
    if (goal != null && (!Number.isFinite(goal) || goal <= 0 || goal > 20000)) {
      return res.status(400).json({ error: 'calorie_goal_kcal must be a positive number' });
    }
    await runDb('UPDATE users SET calorie_goal_kcal = ? WHERE id = ?', [goal != null ? Math.round(goal) : null, userId]);
    const row = await getDb('SELECT calorie_goal_kcal FROM users WHERE id = ? LIMIT 1', [userId]);
    return res.json({ message: 'Saved', calorie_goal_kcal: row?.calorie_goal_kcal ?? null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// List recent food photos with latest insights
app.get('/api/food-photos', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb(
      `SELECT p.id, p.date, p.filename, p.original_name, p.created_at,
              i.dish_name, i.calories, i.protein_g, i.carbs_g, i.fat_g, i.confidence
         FROM food_photos p
    LEFT JOIN food_photo_insights i
           ON i.photo_id = p.id AND i.user_id = p.user_id
        WHERE p.user_id = ?
     ORDER BY p.created_at DESC
     LIMIT 200`,
      [userId]
    );
    res.json(rows.map(r => ({
      ...r,
      url: r.filename ? `/api/uploads/photos/${r.filename}` : null
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/food-photos/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = req.params.id;
    const photo = await getDb('SELECT * FROM food_photos WHERE user_id = ? AND id = ?', [userId, id]);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const insight = await getDb(
      'SELECT * FROM food_photo_insights WHERE user_id = ? AND photo_id = ? ORDER BY created_at DESC LIMIT 1',
      [userId, id]
    );
    res.json({
      id: photo.id,
      date: photo.date,
      original_name: photo.original_name,
      url: `/api/uploads/photos/${photo.filename}`,
      insight: insight ? {
        dish_name: insight.dish_name,
        calories: insight.calories,
        protein_g: insight.protein_g,
        carbs_g: insight.carbs_g,
        fat_g: insight.fat_g,
        fiber_g: insight.fiber_g,
        sugar_g: insight.sugar_g,
        confidence: insight.confidence,
        micronutrients: insight.micronutrients_json ? JSON.parse(insight.micronutrients_json) : {}
      } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Workouts (Fitness) API
// Exercise library API
app.get('/api/exercises', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));

    let rows = [];
    if (q) {
      rows = await allDb(
        `SELECT id, name, muscle_group, equipment, tags, created_at, updated_at
           FROM exercises
          WHERE user_id = ? AND lower(name) LIKE ?
       ORDER BY name ASC
          LIMIT ?`,
        [userId, `%${q}%`, limit]
      );
    } else {
      rows = await allDb(
        `SELECT id, name, muscle_group, equipment, tags, created_at, updated_at
           FROM exercises
          WHERE user_id = ?
       ORDER BY name ASC
          LIMIT ?`,
        [userId, limit]
      );
    }
    res.json(rows.map(r => ({
      ...r,
      tags: r.tags ? (safeJsonParse(r.tags, []) || []) : []
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mood check-ins (manual + mobile)
app.post('/api/checkins', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const occurred_at = req.body?.occurred_at || new Date().toISOString();
    const mood_score = req.body?.mood_score ?? null;
    const energy_score = req.body?.energy_score ?? null;
    const stress_score = req.body?.stress_score ?? null;
    const anxiety_score = req.body?.anxiety_score ?? null;
    const notes = req.body?.notes ? String(req.body.notes) : null;
    const source = req.body?.source ? String(req.body.source) : 'web';

    const r = await runDb(
      `INSERT INTO mood_checkins (user_id, occurred_at, mood_score, energy_score, stress_score, anxiety_score, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, occurred_at, mood_score, energy_score, stress_score, anxiety_score, notes, source]
    );
    res.json({ message: 'Check-in saved', id: r.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Morning routine checklist
app.get('/api/routine/items', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const routineKey = String(req.query.routine || 'morning');
    const { routineId } = await ensureRoutineId({ userId, routineKey });
    const includeInactive = String(req.query.include_inactive || 'false') === 'true';
    const rows = await allDb(
      `SELECT id, title, kind, value_unit, value_key, value_min, value_max, value_step,
              position, is_active, created_at, updated_at
         FROM routine_items
        WHERE user_id = ? AND routine_id = ? ${includeInactive ? '' : 'AND is_active = 1'}
     ORDER BY position ASC, created_at ASC`,
      [userId, routineId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routine/items', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const routineKey = String(req.body?.routine || 'morning');
    const { routineId } = await ensureRoutineId({ userId, routineKey });
    const title = normalizeRoutineTitle(req.body?.title);
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (title.length > 120) return res.status(400).json({ error: 'title is too long' });

    const kind = String(req.body?.kind || 'yesno').trim().toLowerCase();
    const allowedKinds = new Set(['yesno', 'number', 'text', 'time', 'check']);
    if (!allowedKinds.has(kind)) return res.status(400).json({ error: 'invalid kind' });
    const value_unit = req.body?.value_unit != null ? String(req.body.value_unit).trim() : null;
    const value_key = req.body?.value_key != null ? String(req.body.value_key).trim() : null;
    const value_min = req.body?.value_min != null && Number.isFinite(Number(req.body.value_min)) ? Number(req.body.value_min) : null;
    const value_max = req.body?.value_max != null && Number.isFinite(Number(req.body.value_max)) ? Number(req.body.value_max) : null;
    const value_step = req.body?.value_step != null && Number.isFinite(Number(req.body.value_step)) ? Number(req.body.value_step) : null;

    const maxPosRow = await getDb('SELECT MAX(position) AS max_pos FROM routine_items WHERE user_id = ? AND routine_id = ?', [userId, routineId]);
    const nextPos = Number.isFinite(Number(maxPosRow?.max_pos)) ? Number(maxPosRow.max_pos) + 1 : 0;
    const position = req.body?.position != null && Number.isFinite(Number(req.body.position)) ? Math.round(Number(req.body.position)) : nextPos;

    const r = await runDb(
      `INSERT INTO routine_items (user_id, routine_id, title, kind, value_unit, value_key, value_min, value_max, value_step, position, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [userId, routineId, title, kind, value_unit || null, value_key || null, value_min, value_max, value_step, position]
    );
    res.json({ id: r.lastID, routine_id: routineId, title, kind, value_unit: value_unit || null, value_key: value_key || null, value_min, value_max, value_step, position, is_active: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/routine/items/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const existing = await getDb('SELECT id, routine_id, title, kind, position, is_active FROM routine_items WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const title = req.body?.title != null ? normalizeRoutineTitle(req.body.title) : null;
    const position = req.body?.position != null && Number.isFinite(Number(req.body.position)) ? Math.round(Number(req.body.position)) : null;
    const isActive = req.body?.is_active != null ? (Number(req.body.is_active) ? 1 : 0) : null;
    const kind = req.body?.kind != null ? String(req.body.kind).trim().toLowerCase() : null;
    const allowedKinds = new Set(['yesno', 'number', 'text', 'time', 'check']);
    if (kind !== null && !allowedKinds.has(kind)) return res.status(400).json({ error: 'invalid kind' });
    const value_unit = req.body?.value_unit != null ? String(req.body.value_unit).trim() : null;
    const value_key = req.body?.value_key != null ? String(req.body.value_key).trim() : null;
    const value_min = req.body?.value_min != null && Number.isFinite(Number(req.body.value_min)) ? Number(req.body.value_min) : null;
    const value_max = req.body?.value_max != null && Number.isFinite(Number(req.body.value_max)) ? Number(req.body.value_max) : null;
    const value_step = req.body?.value_step != null && Number.isFinite(Number(req.body.value_step)) ? Number(req.body.value_step) : null;
    if (title !== null && !title) return res.status(400).json({ error: 'title cannot be empty' });
    if (title && title.length > 120) return res.status(400).json({ error: 'title is too long' });

    await runDb(
      `UPDATE routine_items
          SET title = COALESCE(?, title),
              kind = COALESCE(?, kind),
              value_unit = COALESCE(?, value_unit),
              value_key = COALESCE(?, value_key),
              value_min = COALESCE(?, value_min),
              value_max = COALESCE(?, value_max),
              value_step = COALESCE(?, value_step),
              position = COALESCE(?, position),
              is_active = COALESCE(?, is_active),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?`,
      [title, kind, value_unit, value_key, value_min, value_max, value_step, position, isActive, id, userId]
    );

    const updated = await getDb('SELECT id, routine_id, title, kind, value_unit, value_key, value_min, value_max, value_step, position, is_active, created_at, updated_at FROM routine_items WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/routine/items/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const r = await runDb('DELETE FROM routine_items WHERE id = ? AND user_id = ?', [id, userId]);
    if (!r.changes) return res.status(404).json({ error: 'not found' });
    res.json({ message: 'deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/routine/day', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.query.date || '').trim();
    const routineKey = String(req.query.routine || 'morning');
    const { routineId, routineKey: finalKey } = await ensureRoutineId({ userId, routineKey });
    if (!isIsoDateOnly(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const items = await allDb(
      `SELECT i.id, i.title, i.kind, i.value_unit, i.value_key, i.value_min, i.value_max, i.value_step, i.position,
              CASE WHEN v.id IS NULL THEN 0 ELSE 1 END AS completed,
              c.completed_at,
              v.value_num,
              v.value_text,
              v.updated_at AS value_updated_at
         FROM routine_items i
    LEFT JOIN routine_item_completions c
           ON c.user_id = i.user_id AND c.routine_id = i.routine_id AND c.item_id = i.id AND c.date = ?
    LEFT JOIN routine_item_values v
           ON v.user_id = i.user_id AND v.routine_id = i.routine_id AND v.item_id = i.id AND v.date = ?
        WHERE i.user_id = ? AND i.routine_id = ? AND i.is_active = 1
     ORDER BY i.position ASC, i.created_at ASC`,
      [date, date, userId, routineId]
    );

    res.json({ routine: finalKey, date, items: items.map(r => ({ ...r, completed: !!r.completed })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routine/day/toggle', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    const routineKey = String(req.body?.routine || 'morning');
    const { routineId } = await ensureRoutineId({ userId, routineKey });
    const itemId = Number(req.body?.item_id);
    const completed = !!req.body?.completed;
    if (!isIsoDateOnly(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'item_id is required' });

    const item = await getDb('SELECT id, kind FROM routine_items WHERE id = ? AND user_id = ? AND routine_id = ? AND is_active = 1 LIMIT 1', [itemId, userId, routineId]);
    if (!item) return res.status(404).json({ error: 'item not found' });
    if (String(item.kind || 'yesno') !== 'check') return res.status(400).json({ error: 'toggle only applies to legacy check items' });

    if (!completed) {
      await runDb('DELETE FROM routine_item_completions WHERE user_id = ? AND routine_id = ? AND date = ? AND item_id = ?', [userId, routineId, date, itemId]);
      return res.json({ date, item_id: itemId, completed: false });
    }

    await runDb(
      `INSERT INTO routine_item_completions (user_id, routine_id, date, item_id, completed, completed_at)
       VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, routine_id, date, item_id) DO UPDATE SET
         completed = 1,
         completed_at = CURRENT_TIMESTAMP`,
      [userId, routineId, date, itemId]
    );

    const row = await getDb(
      'SELECT completed_at FROM routine_item_completions WHERE user_id = ? AND routine_id = ? AND date = ? AND item_id = ? LIMIT 1',
      [userId, routineId, date, itemId]
    );
    return res.json({ date, item_id: itemId, completed: true, completed_at: row?.completed_at || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routine/day/value', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const date = String(req.body?.date || '').trim();
    const routineKey = String(req.body?.routine || 'morning');
    const { routineId } = await ensureRoutineId({ userId, routineKey });
    const itemId = Number(req.body?.item_id);
    if (!isIsoDateOnly(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'item_id is required' });

    const item = await getDb(
      'SELECT id, kind, value_key, value_min, value_max FROM routine_items WHERE id = ? AND user_id = ? AND routine_id = ? AND is_active = 1 LIMIT 1',
      [itemId, userId, routineId]
    );
    if (!item) return res.status(404).json({ error: 'item not found' });

    const kind = String(item.kind || 'check');
    if (kind === 'check') return res.status(400).json({ error: 'value not applicable for legacy check items' });

    let value_num = null;
    let value_text = null;
    if (kind === 'number') {
      if (req.body?.value_num === '' || req.body?.value_num == null) {
        // clear value
        await runDb('DELETE FROM routine_item_values WHERE user_id = ? AND routine_id = ? AND date = ? AND item_id = ?', [userId, routineId, date, itemId]);
        return res.json({ date, item_id: itemId, value_num: null, completed: false });
      }
      const n = Number(req.body.value_num);
      if (!Number.isFinite(n)) return res.status(400).json({ error: 'value_num must be a number' });
      if (item.value_min != null && n < Number(item.value_min)) return res.status(400).json({ error: 'value_num below min' });
      if (item.value_max != null && n > Number(item.value_max)) return res.status(400).json({ error: 'value_num above max' });
      value_num = n;
    } else if (kind === 'text' || kind === 'time') {
      const t = req.body?.value_text == null ? '' : String(req.body.value_text);
      const trimmed = t.trim();
      if (!trimmed) {
        await runDb('DELETE FROM routine_item_values WHERE user_id = ? AND routine_id = ? AND date = ? AND item_id = ?', [userId, routineId, date, itemId]);
        return res.json({ date, item_id: itemId, value_text: null, completed: false });
      }
      if (kind === 'time' && !isTimeHHMM(trimmed)) return res.status(400).json({ error: 'value_text must be HH:MM' });
      if (trimmed.length > 500) return res.status(400).json({ error: 'value_text too long' });
      value_text = trimmed;
    } else if (kind === 'yesno') {
      const t = req.body?.value_text == null ? '' : String(req.body.value_text);
      const trimmed = t.trim().toLowerCase();
      if (!trimmed) {
        await runDb('DELETE FROM routine_item_values WHERE user_id = ? AND routine_id = ? AND date = ? AND item_id = ?', [userId, routineId, date, itemId]);
        return res.json({ date, item_id: itemId, value_text: null, completed: false });
      }
      if (trimmed !== 'yes' && trimmed !== 'no') return res.status(400).json({ error: 'value_text must be yes or no' });
      value_text = trimmed;
    } else {
      return res.status(400).json({ error: 'invalid item kind' });
    }

    await runDb(
      `INSERT INTO routine_item_values (user_id, routine_id, date, item_id, value_num, value_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, routine_id, date, item_id) DO UPDATE SET
         value_num = excluded.value_num,
         value_text = excluded.value_text,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, routineId, date, itemId, value_num, value_text]
    );

    // Map common keys into first-class tables for baselines/correlations
    const key = item.value_key ? String(item.value_key) : '';

    // Sleep
    if (key === 'wake_time') {
      await upsertSleepByDate({ userId, date, patch: { wake_time: value_text } });
    }
    if (key === 'sleep_score') {
      await upsertSleepByDate({ userId, date, patch: { score: value_num } });
    }

    // Biometrics
    if (key === 'heart_rate_bpm') {
      await insertBiometricSample({ userId, type: 'heart_rate', date, value_num, unit: 'bpm', source: 'routine' });
    }
    if (key === 'resting_hr_bpm') {
      await insertBiometricSample({ userId, type: 'resting_heart_rate', date, value_num, unit: 'bpm', source: 'routine' });
    }
    if (key === 'body_temp_c') {
      await insertBiometricSample({ userId, type: 'body_temp', date, value_num, unit: 'C', source: 'routine' });
    }
    if (key === 'bp_systolic_mmhg') {
      await insertBiometricSample({ userId, type: 'blood_pressure_systolic', date, value_num, unit: 'mmHg', source: 'routine' });
    }
    if (key === 'bp_diastolic_mmhg') {
      await insertBiometricSample({ userId, type: 'blood_pressure_diastolic', date, value_num, unit: 'mmHg', source: 'routine' });
    }

    // Body composition (expanded)
    const bodyKeys = new Set([
      'weight_kg', 'bmi', 'visceral_fat', 'hydration_pct', 'muscle_mass_kg',
      'visceral_fat_index', 'subcutaneous_fat_mass_kg', 'skeletal_muscle_mass_kg',
      'body_water_pct', 'extracellular_water_kg', 'intracellular_water_kg', 'mineral_mass_kg',
      'bone_mineral_content_kg', 'skeletal_mass_kg', 'lean_mass_kg', 'basal_metabolic_rate_kcal',
      'metabolic_age_years', 'body_cell_mass_kg'
    ]);
    if (bodyKeys.has(key) && value_num != null) {
      await upsertBodyCompByDate({ userId, date, patch: { [key]: value_num }, source: 'routine' });
    }

    return res.json({ date, item_id: itemId, value_num, value_text, completed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routine/templates/morning-metrics', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { routineId } = await ensureRoutineId({ userId, routineKey: 'morning' });

    const templates = [
      { title: 'Wake up time', kind: 'time', value_key: 'wake_time' },
      { title: 'Heart rate', kind: 'number', value_key: 'heart_rate_bpm', value_unit: 'bpm', value_step: 1 },
      { title: 'Resting HR', kind: 'number', value_key: 'resting_hr_bpm', value_unit: 'bpm', value_step: 1 },
      { title: 'Blood pressure (systolic)', kind: 'number', value_key: 'bp_systolic_mmhg', value_unit: 'mmHg', value_step: 1 },
      { title: 'Blood pressure (diastolic)', kind: 'number', value_key: 'bp_diastolic_mmhg', value_unit: 'mmHg', value_step: 1 },
      { title: 'Body temp', kind: 'number', value_key: 'body_temp_c', value_unit: '°C', value_step: 0.1 },
      { title: 'Sleep score', kind: 'number', value_key: 'sleep_score', value_unit: '/100', value_step: 1, value_min: 0, value_max: 100 },
      { title: 'Visceral fat index', kind: 'number', value_key: 'visceral_fat_index', value_step: 0.1 },
      { title: 'Subcutaneous fat mass', kind: 'number', value_key: 'subcutaneous_fat_mass_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Skeletal muscle mass', kind: 'number', value_key: 'skeletal_muscle_mass_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Body water %', kind: 'number', value_key: 'body_water_pct', value_unit: '%', value_step: 0.1 },
      { title: 'Extracellular water', kind: 'number', value_key: 'extracellular_water_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Intracellular water', kind: 'number', value_key: 'intracellular_water_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Mineral mass', kind: 'number', value_key: 'mineral_mass_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Bone mineral content', kind: 'number', value_key: 'bone_mineral_content_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Skeletal mass', kind: 'number', value_key: 'skeletal_mass_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Lean mass', kind: 'number', value_key: 'lean_mass_kg', value_unit: 'kg', value_step: 0.1 },
      { title: 'Basal metabolic rate', kind: 'number', value_key: 'basal_metabolic_rate_kcal', value_unit: 'kcal', value_step: 1 },
      { title: 'Metabolic age', kind: 'number', value_key: 'metabolic_age_years', value_unit: 'years', value_step: 1 },
      { title: 'Body cell mass', kind: 'number', value_key: 'body_cell_mass_kg', value_unit: 'kg', value_step: 0.1 }
    ];

    const existing = await allDb('SELECT id, title, value_key FROM routine_items WHERE user_id = ? AND routine_id = ? AND is_active = 1', [userId, routineId]);
    const existingKeys = new Set(existing.map(r => String(r.value_key || '').trim()).filter(Boolean));
    const existingTitles = new Set(existing.map(r => String(r.title || '').trim().toLowerCase()).filter(Boolean));

    const maxPosRow = await getDb('SELECT MAX(position) AS max_pos FROM routine_items WHERE user_id = ? AND routine_id = ?', [userId, routineId]);
    let pos = Number.isFinite(Number(maxPosRow?.max_pos)) ? Number(maxPosRow.max_pos) + 1 : 0;

    let created = 0;
    for (const t of templates) {
      const key = t.value_key ? String(t.value_key).trim() : '';
      const titleKey = String(t.title || '').trim().toLowerCase();
      if ((key && existingKeys.has(key)) || existingTitles.has(titleKey)) continue;

      await runDb(
        `INSERT INTO routine_items (user_id, routine_id, title, kind, value_unit, value_key, value_min, value_max, value_step, position, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          userId,
          routineId,
          t.title,
          t.kind,
          t.value_unit || null,
          t.value_key || null,
          t.value_min ?? null,
          t.value_max ?? null,
          t.value_step ?? null,
          pos++
        ]
      );
      created++;
    }

    res.json({ message: 'Templates applied', created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routine/templates/evening-routine', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { routineId } = await ensureRoutineId({ userId, routineKey: 'evening' });

    const templates = [
      { title: 'Screen time within 2h of bed', kind: 'yesno', value_key: 'screen_time_2h_prebed' },
      { title: 'Caffeine within 6h of bed', kind: 'yesno', value_key: 'caffeine_6h_prebed' },
      { title: 'Sauna (evening)', kind: 'yesno', value_key: 'sauna_evening' },
      { title: 'Hot bath', kind: 'yesno', value_key: 'hot_bath_evening' },
      { title: 'Hot shower', kind: 'yesno', value_key: 'hot_shower_evening' },
      { title: 'Last food intake time', kind: 'time', value_key: 'last_food_time' },
      { title: 'Last drink time', kind: 'time', value_key: 'last_drink_time' }
    ];

    const existing = await allDb('SELECT id, title, value_key FROM routine_items WHERE user_id = ? AND routine_id = ? AND is_active = 1', [userId, routineId]);
    const existingKeys = new Set(existing.map(r => String(r.value_key || '').trim()).filter(Boolean));
    const existingTitles = new Set(existing.map(r => String(r.title || '').trim().toLowerCase()).filter(Boolean));

    const maxPosRow = await getDb('SELECT MAX(position) AS max_pos FROM routine_items WHERE user_id = ? AND routine_id = ?', [userId, routineId]);
    let pos = Number.isFinite(Number(maxPosRow?.max_pos)) ? Number(maxPosRow.max_pos) + 1 : 0;

    let created = 0;
    for (const t of templates) {
      const key = t.value_key ? String(t.value_key).trim() : '';
      const titleKey = String(t.title || '').trim().toLowerCase();
      if ((key && existingKeys.has(key)) || existingTitles.has(titleKey)) continue;

      await runDb(
        `INSERT INTO routine_items (user_id, routine_id, title, kind, value_unit, value_key, value_min, value_max, value_step, position, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          userId,
          routineId,
          t.title,
          t.kind,
          t.value_unit || null,
          t.value_key || null,
          t.value_min ?? null,
          t.value_max ?? null,
          t.value_step ?? null,
          pos++
        ]
      );
      created++;
    }

    res.json({ message: 'Templates applied', created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/checkins', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const where = [
      'user_id = ?',
      from ? 'occurred_at >= ?' : null,
      to ? 'occurred_at <= ?' : null
    ].filter(Boolean).join(' AND ');
    const params = [userId, ...(from ? [from] : []), ...(to ? [to] : [])];
    const rows = await allDb(`SELECT * FROM mood_checkins WHERE ${where} ORDER BY occurred_at DESC LIMIT ${limit}`, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mobile alias: check-ins
app.post('/api/mobile/checkins', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const occurred_at = req.body?.occurred_at || new Date().toISOString();
    const mood_score = req.body?.mood_score ?? null;
    const energy_score = req.body?.energy_score ?? null;
    const stress_score = req.body?.stress_score ?? null;
    const anxiety_score = req.body?.anxiety_score ?? null;
    const notes = req.body?.notes ? String(req.body.notes) : null;
    const source = req.body?.source ? String(req.body.source) : 'mobile';

    const r = await runDb(
      `INSERT INTO mood_checkins (user_id, occurred_at, mood_score, energy_score, stress_score, anxiety_score, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, occurred_at, mood_score, energy_score, stress_score, anxiety_score, notes, source]
    );
    res.json({ message: 'Check-in saved', id: r.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Biometrics samples (mobile ingestion; also usable by uploads later)
app.post('/api/mobile/sync/biometrics', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
    if (!samples.length) return res.status(400).json({ error: 'samples array required' });

    let inserted = 0;
    for (const s of samples) {
      const type = String(s.type || '').trim();
      const start_at = s.start_at ? String(s.start_at) : null;
      if (!type || !start_at) continue;
      await runDb(
        `INSERT INTO biometric_samples (user_id, type, start_at, end_at, value_num, unit, source, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          type,
          start_at,
          s.end_at ? String(s.end_at) : null,
          s.value_num != null ? Number(s.value_num) : null,
          s.unit ? String(s.unit) : null,
          s.source ? String(s.source) : 'mobile',
          s.raw_json ? JSON.stringify(s.raw_json) : null
        ]
      );
      inserted++;
    }
    res.json({ message: 'Biometrics saved', inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Weekly insights (MVP): compute rollup and optionally generate narrative
app.get('/api/insights/week', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const qs = req.query.week_start ? String(req.query.week_start) : null;
    const refresh = String(req.query.refresh || 'false') === 'true';
    const narrative = String(req.query.narrative || 'false') === 'true';
    const baseDate = qs ? parseIsoDate(qs) : new Date();
    const ws = startOfWeekMonday(baseDate || new Date());
    const wsIso = ws.toISOString().split('T')[0];

    if (!refresh) {
      const existing = await getDb('SELECT * FROM weekly_summaries WHERE user_id = ? AND week_start = ? LIMIT 1', [userId, wsIso]);
      if (existing?.summary_md) {
        return res.json({
          week_start: wsIso,
          summary_md: existing.summary_md,
          supporting: existing.supporting_json ? JSON.parse(existing.supporting_json) : null,
          cached: true
        });
      }
    }

    const rollup = await computeWeekRollup({ userId, weekStart: wsIso, allDb, getDb });

    // Narrative (deterministic baseline)
    let summary = [
      `## Weekly summary (${rollup.week_start})`,
      ``,
      `- Calories logged: **${rollup.totals.calories || 0}**`,
      `- Workouts: **${rollup.totals.workouts.count}** (minutes: ${Math.round(rollup.totals.workouts.minutes || 0)})`,
      `- Runs: **${rollup.totals.workouts.runs.count}** (km: ${Number(rollup.totals.workouts.runs.km || 0).toFixed(1)})`,
      `- Weigh-ins: **${rollup.totals.body.weighins}**`,
      rollup.totals.body.weight_delta_kg != null ? `- Weight change: **${rollup.totals.body.weight_delta_kg.toFixed(2)} kg**` : `- Weight change: **n/a**`,
      rollup.totals.checkins.count ? `- Avg mood/stress/energy: **${(rollup.totals.checkins.avg_mood ?? 0).toFixed(1)} / ${(rollup.totals.checkins.avg_stress ?? 0).toFixed(1)} / ${(rollup.totals.checkins.avg_energy ?? 0).toFixed(1)}**` : `- Mood check-ins: **none**`,
      rollup.totals.biometrics.avg_heart_rate != null ? `- Avg heart rate sample: **${rollup.totals.biometrics.avg_heart_rate.toFixed(1)} bpm**` : `- Heart rate samples: **none**`,
      rollup.totals.journal.extractions ? `- Journal signals: **${rollup.totals.journal.extractions}** entries extracted (top: ${rollup.totals.journal.top_event_categories.join(', ') || 'n/a'})` : `- Journal signals: **none**`,
      ``,
      `**Note:** These are correlations and hypotheses, not medical advice.`
    ].join('\n');

    // LLM narrative (optional) via OpenAI or OpenRouter
    if (narrative) {
      const prompt = [
        `You are generating a weekly “why might this have happened?” report for a personal health app.`,
        `Use the provided rollup JSON and produce a concise Markdown report with:`,
        `- 3–6 bullets of likely drivers of stress (tie journal categories + HR/checkins)`,
        `- 2–4 bullets about calories/exercise/weight trend`,
        `- 1–2 actionable suggestions for next week (non-medical)`,
        `Avoid overclaiming; use words like “may”, “likely”, “suggests”.`,
        ``,
        `ROLLUP_JSON:`,
        JSON.stringify(rollup)
      ].join('\n');
      const llmText = await generateMarkdownLLM({ prompt });
      if (llmText.ok && llmText.markdown) {
        summary = llmText.markdown;
      }
    }

    await runDb(
      `INSERT INTO weekly_summaries (user_id, week_start, summary_md, supporting_json)\n       VALUES (?, ?, ?, ?)\n       ON CONFLICT(user_id, week_start) DO UPDATE SET\n         summary_md = excluded.summary_md,\n         supporting_json = excluded.supporting_json,\n         created_at = CURRENT_TIMESTAMP`,
      [userId, wsIso, summary, JSON.stringify(rollup)]
    ).catch(async () => {
      // If ON CONFLICT unsupported in older sqlite, do manual upsert
      const ex = await getDb('SELECT id FROM weekly_summaries WHERE user_id = ? AND week_start = ?', [userId, wsIso]);
      if (ex?.id) {
        await runDb(
          'UPDATE weekly_summaries SET summary_md = ?, supporting_json = ?, created_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
          [summary, JSON.stringify(rollup), ex.id, userId]
        );
      } else {
        await runDb(
          'INSERT INTO weekly_summaries (user_id, week_start, summary_md, supporting_json) VALUES (?, ?, ?, ?)',
          [userId, wsIso, summary, JSON.stringify(rollup)]
        );
      }
    });

    res.json({ week_start: wsIso, summary_md: summary, supporting: rollup, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/exercises', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const name = normalizeExerciseName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });

    const muscle_group = req.body?.muscle_group ? String(req.body.muscle_group).trim() : null;
    const equipment = req.body?.equipment ? String(req.body.equipment).trim() : null;
    let tags = req.body?.tags ?? null;
    if (typeof tags === 'string') {
      // Accept comma-separated tag strings from UI
      tags = tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (Array.isArray(tags)) {
      tags = tags.map(t => String(t).trim()).filter(Boolean).slice(0, 50);
    } else {
      tags = null;
    }

    const existing = await getDb('SELECT id FROM exercises WHERE user_id = ? AND name = ? LIMIT 1', [userId, name]);
    if (existing?.id) {
      await runDb(
        `UPDATE exercises
            SET muscle_group = COALESCE(?, muscle_group),
                equipment = COALESCE(?, equipment),
                tags = COALESCE(?, tags),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?`,
        [muscle_group, equipment, tags ? JSON.stringify(tags) : null, existing.id, userId]
      );
    } else {
      await runDb(
        `INSERT INTO exercises (user_id, name, muscle_group, equipment, tags, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [userId, name, muscle_group, equipment, tags ? JSON.stringify(tags) : null]
      );
    }

    const saved = await getDb(
      'SELECT id, name, muscle_group, equipment, tags, created_at, updated_at FROM exercises WHERE user_id = ? AND name = ?',
      [userId, name]
    );
    res.json({
      message: 'Exercise saved',
      exercise: saved ? { ...saved, tags: saved.tags ? (safeJsonParse(saved.tags, []) || []) : [] } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/workouts/session', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { date, type, name, notes, duration_minutes, distance_km, calories } = req.body;
    if (!date || !type) return res.status(400).json({ error: 'date and type are required' });
    if (!['run', 'strength', 'other'].includes(type)) return res.status(400).json({ error: 'invalid type' });

    const dist = distance_km !== undefined && distance_km !== '' ? Number(distance_km) : null;
    const dur = duration_minutes !== undefined && duration_minutes !== '' ? Number(duration_minutes) : null;
    const pace = (type === 'run' && dist && dur) ? (dur / dist) : null;

    const r = await runDb(
      `INSERT INTO workout_sessions (user_id, date, type, name, notes, duration_minutes, distance_km, pace_min_per_km, calories)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, date, type, name || null, notes || null, dur, dist, pace, calories !== undefined && calories !== '' ? Number(calories) : null]
    );

    const session = await getDb('SELECT * FROM workout_sessions WHERE id = ? AND user_id = ?', [r.lastID, userId]);
    res.json({ message: 'Session created', session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/workouts/session/:id/sets', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const sessionId = Number(req.params.id);
    if (!Number.isFinite(sessionId)) return res.status(400).json({ error: 'invalid session id' });
    const session = await getDb('SELECT * FROM workout_sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
    if (!session) return res.status(404).json({ error: 'session not found' });

    const sets = Array.isArray(req.body.sets) ? req.body.sets : [];
    if (!sets.length) return res.status(400).json({ error: 'sets array required' });

    let inserted = 0;
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i] || {};
      const exercise = (s.exercise || '').trim();
      if (!exercise) continue;
      const reps = s.reps !== undefined && s.reps !== '' ? Number(s.reps) : null;
      const weight = s.weight_kg !== undefined && s.weight_kg !== '' ? Number(s.weight_kg) : null;
      const rpe = s.rpe !== undefined && s.rpe !== '' ? Number(s.rpe) : null;
      await runDb(
        `INSERT INTO workout_sets (user_id, session_id, exercise, set_index, reps, weight_kg, rpe, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, sessionId, exercise, s.set_index ?? i + 1, reps, weight, rpe, s.notes || null]
      );
      inserted++;
    }

    res.json({ message: 'Sets added', inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/workouts', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const type = req.query.type;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const hasType = type && ['run', 'strength', 'other'].includes(type);
    const where = hasType ? 'WHERE user_id = ? AND type = ?' : 'WHERE user_id = ?';
    const params = hasType ? [userId, type] : [userId];
    const sessions = await allDb(`SELECT * FROM workout_sessions ${where} ORDER BY date DESC, id DESC LIMIT ${limit}`, params);
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/workouts/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    const session = await getDb('SELECT * FROM workout_sessions WHERE id = ? AND user_id = ?', [id, userId]);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const sets = await allDb('SELECT * FROM workout_sets WHERE user_id = ? AND session_id = ? ORDER BY set_index ASC, id ASC', [userId, id]);
    res.json({ session, sets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/workouts/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = Number(req.params.id);
    const session = await getDb('SELECT id FROM workout_sessions WHERE id = ? AND user_id = ?', [id, userId]);
    if (!session) return res.status(404).json({ error: 'session not found' });

    await runDb('DELETE FROM workout_sessions WHERE id = ?', [id]);
    res.json({ message: 'Deleted workout' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Progress: runs (distance/pace over time)
app.get('/api/workouts/progress/runs', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb(
      `SELECT date, distance_km, duration_minutes, pace_min_per_km, calories
         FROM workout_sessions
        WHERE user_id = ?
          AND type = 'run'
          AND (distance_km IS NOT NULL OR duration_minutes IS NOT NULL)
     ORDER BY date ASC`,
      [userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Progress: strength summary per exercise (best set weight and estimated 1RM over time)
app.get('/api/workouts/progress/strength', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const exercise = (req.query.exercise || '').trim();
    const where = exercise ? 'AND s.exercise = ?' : '';
    const params = exercise ? [userId, exercise] : [userId];
    const rows = await allDb(
      `SELECT ws.date as date,
              s.exercise as exercise,
              MAX(COALESCE(s.weight_kg,0)) as best_weight_kg,
              MAX(CASE
                    WHEN s.weight_kg IS NOT NULL AND s.reps IS NOT NULL AND s.reps > 0
                    THEN s.weight_kg * (1 + (s.reps / 30.0))
                    ELSE NULL
                  END) as est_1rm_kg,
              SUM(COALESCE(s.weight_kg,0) * COALESCE(s.reps,0)) as volume_kg
         FROM workout_sessions ws
         JOIN workout_sets s ON s.session_id = ws.id
        WHERE ws.user_id = ?
          AND s.user_id = ws.user_id
          AND ws.type = 'strength' ${where}
     GROUP BY ws.date, s.exercise
     ORDER BY ws.date ASC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Product catalog API (barcode-first)
app.get('/api/products/:gtin', async (req, res) => {
  try {
    const gtin = (req.params.gtin || '').trim();
    if (!gtin) return res.status(400).json({ error: 'gtin required' });
    const product = await getDb('SELECT * FROM products WHERE gtin = ?', [gtin]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const nutrition = await getDb('SELECT * FROM product_nutrition WHERE gtin = ?', [gtin]);
    const images = await allDb('SELECT * FROM product_images WHERE gtin = ? ORDER BY created_at DESC', [gtin]);
    res.json({
      product: {
        ...product,
        source_json: product.source_json ? JSON.parse(product.source_json) : null
      },
      nutrition: nutrition ? {
        ...nutrition,
        micronutrients_json: nutrition.micronutrients_json ? JSON.parse(nutrition.micronutrients_json) : {}
      } : null,
      images
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    if (!q) return res.json([]);
    const rows = await allDb(
      `SELECT gtin, name, brand, retailer, image_url, updated_at
         FROM products
        WHERE lower(name) LIKE ? OR lower(brand) LIKE ? OR gtin LIKE ?
     ORDER BY updated_at DESC
        LIMIT ?`,
      [`%${q}%`, `%${q}%`, `%${q}%`, limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/products/upsert', async (req, res) => {
  try {
    const { gtin, name, brand, retailer, image_url, ingredients, serving_size, source, nutrition } = req.body || {};
    const code = (gtin || '').trim();
    if (!code) return res.status(400).json({ error: 'gtin required' });

    await runDb(
      `INSERT INTO products (gtin, name, brand, retailer, image_url, ingredients, serving_size, source, source_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(gtin) DO UPDATE SET
         name = COALESCE(excluded.name, products.name),
         brand = COALESCE(excluded.brand, products.brand),
         retailer = COALESCE(excluded.retailer, products.retailer),
         image_url = COALESCE(excluded.image_url, products.image_url),
         ingredients = COALESCE(excluded.ingredients, products.ingredients),
         serving_size = COALESCE(excluded.serving_size, products.serving_size),
         source = COALESCE(excluded.source, products.source),
         source_json = COALESCE(excluded.source_json, products.source_json),
         updated_at = CURRENT_TIMESTAMP`,
      [code, name || null, brand || null, retailer || null, image_url || null, ingredients || null, serving_size || null, source || null, JSON.stringify(req.body || {})]
    );

    if (nutrition && typeof nutrition === 'object') {
      await runDb(
        `INSERT INTO product_nutrition
          (gtin, calories_kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, sugar_g_100g, salt_g_100g, saturated_fat_g_100g, sodium_mg_100g, micronutrients_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(gtin) DO UPDATE SET
           calories_kcal_100g = COALESCE(excluded.calories_kcal_100g, product_nutrition.calories_kcal_100g),
           protein_g_100g = COALESCE(excluded.protein_g_100g, product_nutrition.protein_g_100g),
           carbs_g_100g = COALESCE(excluded.carbs_g_100g, product_nutrition.carbs_g_100g),
           fat_g_100g = COALESCE(excluded.fat_g_100g, product_nutrition.fat_g_100g),
           fiber_g_100g = COALESCE(excluded.fiber_g_100g, product_nutrition.fiber_g_100g),
           sugar_g_100g = COALESCE(excluded.sugar_g_100g, product_nutrition.sugar_g_100g),
           salt_g_100g = COALESCE(excluded.salt_g_100g, product_nutrition.salt_g_100g),
           saturated_fat_g_100g = COALESCE(excluded.saturated_fat_g_100g, product_nutrition.saturated_fat_g_100g),
           sodium_mg_100g = COALESCE(excluded.sodium_mg_100g, product_nutrition.sodium_mg_100g),
           micronutrients_json = COALESCE(excluded.micronutrients_json, product_nutrition.micronutrients_json),
           updated_at = CURRENT_TIMESTAMP`,
        [
          code,
          nutrition.calories_kcal_100g ?? null,
          nutrition.protein_g_100g ?? null,
          nutrition.carbs_g_100g ?? null,
          nutrition.fat_g_100g ?? null,
          nutrition.fiber_g_100g ?? null,
          nutrition.sugar_g_100g ?? null,
          nutrition.salt_g_100g ?? null,
          nutrition.saturated_fat_g_100g ?? null,
          nutrition.sodium_mg_100g ?? null,
          nutrition.micronutrients ? JSON.stringify(nutrition.micronutrients) : null
        ]
      );
    }

    const saved = await getDb('SELECT * FROM products WHERE gtin = ?', [code]);
    res.json({ message: 'Product upserted', product: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Body composition (Hume/BodyPod) CSV import + charts
app.post('/api/bodycomp/import', bodyCompUpload.single('file'), async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = req.file.originalname || req.file.filename;
    const ext = path.extname(filename).toLowerCase();
    const source = req.body.source || 'hume_csv';

    let rows = [];
    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(req.file.path);
      const sheet = workbook.SheetNames[0];
      const json = XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { defval: '' });
      rows = json;
    } else {
      // quick CSV parse without streaming libs (good enough for typical exports)
      const content = fs.readFileSync(req.file.path, 'utf8');
      const lines = content.split(/\r?\n/).filter(l => l.trim().length);
      if (lines.length < 2) return res.status(400).json({ error: 'CSV appears empty' });
      const headers = lines[0].split(',').map(h => h.trim());
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const row = {};
        headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
        rows.push(row);
      }
    }

    // Map columns loosely
    const mapped = [];
    for (const r of rows) {
      const keys = Object.keys(r);
      const norm = Object.fromEntries(keys.map(k => [normalizeHeader(k), k]));

      const dateKey =
        norm['date'] || norm['measurement date'] || norm['weigh in date'] || norm['timestamp'] || norm['time'] || keys[0];
      const date = parseDateLoose(r[dateKey]);
      if (!date) continue;

      const weightKey = norm['weight'] || norm['weight kg'] || norm['weight (kg)'] || norm['weight(kg)'] || norm['mass'] || null;
      const bfKey = norm['body fat pct'] || norm['body fat'] || norm['bodyfat pct'] || norm['fat pct'] || null;
      const bmiKey = norm['bmi'] || null;
      const hydKey = norm['hydration pct'] || norm['hydration'] || norm['water pct'] || null;
      const muscleKey = norm['muscle mass'] || norm['muscle mass kg'] || norm['skeletal muscle mass'] || null;
      const visceralKey = norm['visceral fat'] || norm['visceral'] || null;

      const record = {
        date,
        weight_kg: weightKey ? parseNumberLoose(r[weightKey]) : null,
        body_fat_pct: bfKey ? parseNumberLoose(r[bfKey]) : null,
        bmi: bmiKey ? parseNumberLoose(r[bmiKey]) : null,
        hydration_pct: hydKey ? parseNumberLoose(r[hydKey]) : null,
        muscle_mass_kg: muscleKey ? parseNumberLoose(r[muscleKey]) : null,
        visceral_fat: visceralKey ? parseNumberLoose(r[visceralKey]) : null,
        source,
        raw_json: JSON.stringify(r)
      };
      mapped.push(record);
    }

    let inserted = 0;
    for (const rec of mapped) {
      const existing = await getDb('SELECT id FROM body_composition WHERE user_id = ? AND date = ? LIMIT 1', [userId, rec.date]);
      if (existing?.id) {
        await runDb(
          `UPDATE body_composition
              SET weight_kg = COALESCE(?, weight_kg),
                  body_fat_pct = COALESCE(?, body_fat_pct),
                  bmi = COALESCE(?, bmi),
                  hydration_pct = COALESCE(?, hydration_pct),
                  muscle_mass_kg = COALESCE(?, muscle_mass_kg),
                  visceral_fat = COALESCE(?, visceral_fat),
                  source = COALESCE(?, source),
                  raw_json = COALESCE(?, raw_json)
            WHERE id = ? AND user_id = ?`,
          [
            rec.weight_kg,
            rec.body_fat_pct,
            rec.bmi,
            rec.hydration_pct,
            rec.muscle_mass_kg,
            rec.visceral_fat,
            rec.source,
            rec.raw_json,
            existing.id,
            userId
          ]
        );
      } else {
        await runDb(
          `INSERT INTO body_composition
            (user_id, date, weight_kg, body_fat_pct, bmi, hydration_pct, muscle_mass_kg, visceral_fat, source, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            rec.date,
            rec.weight_kg,
            rec.body_fat_pct,
            rec.bmi,
            rec.hydration_pct,
            rec.muscle_mass_kg,
            rec.visceral_fat,
            rec.source,
            rec.raw_json
          ]
        );
      }
      inserted++;
    }

    res.json({ message: 'Body composition imported', inserted, rows_parsed: mapped.length, source });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bodycomp', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 365)));
    const rows = await allDb(`SELECT * FROM body_composition WHERE user_id = ? ORDER BY date DESC LIMIT ${limit}`, [userId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bodycomp/progress', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM body_composition WHERE user_id = ? ORDER BY date ASC', [userId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API integration scaffolding: store config for future Hume/BodyPod API sync
app.post('/api/integrations/hume', async (req, res) => {
  try {
    // keep it simple: store config in a single-row JSON file via SQLite products.source_json reuse is ugly;
    // we'll create a tiny table on-demand.
    await runDb(
      `CREATE TABLE IF NOT EXISTS integrations (
        provider TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        config_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );
    const enabled = req.body.enabled ? 1 : 0;
    const config = req.body.config || {};
    await runDb(
      `INSERT INTO integrations (provider, enabled, config_json, updated_at)
       VALUES ('hume', ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = CURRENT_TIMESTAMP`,
      [enabled, JSON.stringify(config)]
    );
    res.json({ message: 'Saved Hume integration config', enabled, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GarminDB Auto Sync (local personal-use)
app.post('/api/garmin/autosync', async (req, res) => {
  try {
    if (String(process.env.ENABLE_GARMINDB_AUTOSYNC || '').toLowerCase() !== 'true') {
      return res.status(403).json({ error: 'GarminDB autosync is disabled. Set ENABLE_GARMINDB_AUTOSYNC=true in env.local and restart.' });
    }
    const userId = reqUserId(req);
    const days = Math.min(5000, Math.max(1, Number(req.body?.days || 30)));
    const includeDaily = req.body?.includeDaily !== false; // default true
    const includeWorkouts = req.body?.includeWorkouts !== false; // default true
    const includeSamples = !!req.body?.includeSamples; // default false (can be huge)
    const samplesDays = Math.min(365, Math.max(1, Number(req.body?.samplesDays || days)));

    const home = os.homedir();
    const garminHome = process.env.GARMINDB_HOME || path.join(home, '.GarminDb');
    const dbCandidates = [
      process.env.GARMINDB_DB_PATH,
      path.join(garminHome, 'DBs', 'garmin.db'),
      path.join(garminHome, 'DBs', 'garmindb.db'),
      path.join(garminHome, 'DBs', 'garmin.sqlite'),
      path.join(garminHome, 'DBs', 'garmindb.sqlite')
    ].filter(Boolean);
    const garminDbPath = dbCandidates.find(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });

    // Run garmindb cli (if installed/configured)
    const cli = process.env.GARMINDB_CLI || 'garmindb_cli.py';
    const cliArgs = [cli, '--all', '--download', '--import', '--analyze', '--latest'];
    const run = await runGarminDbCli({ args: cliArgs, cwd: process.cwd() });
    if (run.code !== 0) {
      return res.status(500).json({
        error: `GarminDB command failed (exit ${run.code}). Make sure GarminDB is installed and configured.`,
        details: (run.stderr || run.stdout || '').slice(-4000)
      });
    }

    if (!garminDbPath) {
      return res.status(500).json({
        error: 'Could not find GarminDB SQLite database. Set GARMINDB_DB_PATH in env.local.',
        note: `Expected something like ${path.join(garminHome, 'DBs', 'garmin.db')}`
      });
    }

    const dbDir = process.env.GARMINDB_DB_DIR || path.dirname(garminDbPath);
    const paths = {
      main: path.join(dbDir, 'garmin.db'),
      monitoring: path.join(dbDir, 'garmin_monitoring.db'),
      activities: path.join(dbDir, 'garmin_activities.db'),
      summary: path.join(dbDir, 'garmin_summary.db')
    };

    const result = {
      daily: null,
      workouts: null,
      samples: null
    };

    if (includeDaily) {
      const mainDb = fs.existsSync(paths.main) ? paths.main : garminDbPath;
      result.daily = await importFromGarminDbSqlite({ userId, garminDbPath: mainDb, days });
    }
    if (includeWorkouts && fs.existsSync(paths.activities)) {
      result.workouts = await importFromGarminActivitiesDb({ userId, garminActivitiesPath: paths.activities, days });
    }
    if (includeSamples && fs.existsSync(paths.monitoring)) {
      result.samples = await importFromGarminMonitoringDb({ userId, garminMonitoringPath: paths.monitoring, days: samplesDays });
    }

    return res.json({
      message: 'GarminDB autosync complete',
      days,
      dbDir,
      paths,
      includeDaily,
      includeWorkouts,
      includeSamples,
      samplesDays,
      summary: {
        activity_days: result.daily?.activity_upserts || 0,
        sleep_days: result.daily?.sleep_upserts || 0,
        weight_days: result.daily?.weight_upserts || 0,
        resting_hr_days: result.daily?.hr_samples || 0,
        workout_sessions: result.workouts?.sessions_upserts || 0,
        hr_samples: result.samples?.hr_samples || 0
      },
      note: includeSamples
        ? 'Raw HR samples can be very large; consider limiting samplesDays.'
        : 'Daily metrics + workouts imported. Enable raw samples only if you need high-resolution HR/SpO2/RR streams.'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/integrations/hume', async (req, res) => {
  try {
    await runDb(
      `CREATE TABLE IF NOT EXISTS integrations (
        provider TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        config_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );
    const row = await getDb('SELECT * FROM integrations WHERE provider = ?', ['hume']);
    if (!row) return res.json({ provider: 'hume', enabled: false, config: null });
    res.json({ provider: 'hume', enabled: !!row.enabled, config: row.config_json ? JSON.parse(row.config_json) : null, updated_at: row.updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apple Health export import (export.xml)
app.post('/api/apple-health/import', appleHealthUpload.single('appleHealthFile'), async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;

    // Aggregate daily values
    const stepsByDay = {};
    const hrSumByDay = {};
    const hrCountByDay = {};
    const sleepAsleepHoursByDay = {};

    let recordsParsed = 0;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.includes('<Record ')) continue;
      const attrs = parseXmlAttributesFromLine(line);
      const type = attrs.type;
      if (!type) continue;

      // Steps
      if (type === 'HKQuantityTypeIdentifierStepCount') {
        const d = parseAppleHealthDate(attrs.startDate || attrs.endDate);
        const key = d ? isoDateKey(d) : null;
        const v = parseNumberLoose(attrs.value);
        if (key && v != null) {
          stepsByDay[key] = (stepsByDay[key] || 0) + v;
        }
        recordsParsed++;
        continue;
      }

      // Heart rate samples
      if (type === 'HKQuantityTypeIdentifierHeartRate') {
        const d = parseAppleHealthDate(attrs.startDate || attrs.endDate);
        const key = d ? isoDateKey(d) : null;
        const v = parseNumberLoose(attrs.value);
        if (key && v != null) {
          hrSumByDay[key] = (hrSumByDay[key] || 0) + v;
          hrCountByDay[key] = (hrCountByDay[key] || 0) + 1;
        }
        recordsParsed++;
        continue;
      }

      // Sleep
      if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
        const value = attrs.value || '';
        if (value.includes('Asleep')) {
          const start = parseAppleHealthDate(attrs.startDate);
          const end = parseAppleHealthDate(attrs.endDate);
          if (start && end && end > start) {
            addDurationHoursByDay(sleepAsleepHoursByDay, start, end);
          }
        }
        recordsParsed++;
        continue;
      }
    }

    // Write into DB
    const activityDays = new Set([...Object.keys(stepsByDay), ...Object.keys(hrSumByDay)]);
    let activityUpserts = 0;
    for (const day of activityDays) {
      const steps = stepsByDay[day] != null ? Math.round(stepsByDay[day]) : null;
      const hrAvg = (hrSumByDay[day] != null && hrCountByDay[day] != null && hrCountByDay[day] > 0)
        ? Math.round((hrSumByDay[day] / hrCountByDay[day]) * 10) / 10
        : null;
      await upsertDayActivity(userId, day, { steps, heart_rate_avg: hrAvg });
      activityUpserts++;
    }

    const sleepDays = Object.keys(sleepAsleepHoursByDay);
    let sleepUpserts = 0;
    for (const day of sleepDays) {
      const hrs = sleepAsleepHoursByDay[day];
      const duration = hrs != null ? Math.round(hrs * 100) / 100 : null;
      if (duration != null) {
        await upsertDaySleep(userId, day, { duration_hours: duration });
        sleepUpserts++;
      }
    }

    // Clean up uploaded file
    fs.unlink(filePath, () => {});

    res.json({
      message: 'Apple Health import complete',
      imported: {
        activity_days: activityUpserts,
        sleep_days: sleepUpserts,
        records_parsed: recordsParsed
      }
    });
  } catch (e) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: e.message });
  }
});

// Android import (Google Fit Takeout ZIP or extracted CSV)
app.post('/api/android-health/import', androidHealthUpload.single('androidHealthFile'), async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname || req.file.filename || '').toLowerCase();

    const stepsByDay = {};
    const hrSumByDay = {};
    const hrCountByDay = {};
    const sleepHoursByDay = {};
    const warnings = [];

    let filesParsed = 0;

    async function parseOneCsvStream(stream, hintName = '') {
      const headerLine = await peekFirstLineFromStream(stream);
      const headerKeys = parseCsvLineLoose(headerLine).map(normalizeHeaderKey);
      const headerSet = new Set(headerKeys);

      const isDailySteps =
        headerSet.has('steps') && (headerSet.has('date') || headerSet.has('day') || headerSet.has('start date'));
      const isHeartRate =
        headerSet.has('bpm') || headerSet.has('heart rate') || (headerSet.has('value') && hintName.toLowerCase().includes('heart'));
      const isSleep =
        hintName.toLowerCase().includes('sleep') || headerSet.has('sleep start') || headerSet.has('sleep end') || (headerSet.has('start time') && headerSet.has('end time'));

      if (isDailySteps) {
        await parseDailyMetricsCsvStream(stream, stepsByDay);
        filesParsed++;
        return;
      }
      if (isHeartRate) {
        await parseHeartRateCsvStream(stream, hrSumByDay, hrCountByDay);
        filesParsed++;
        return;
      }
      if (isSleep) {
        await parseSleepCsvStream(stream, sleepHoursByDay);
        filesParsed++;
        return;
      }

      // Unknown CSV shape - ignore
    }

    if (ext === '.csv') {
      await parseOneCsvStream(fs.createReadStream(filePath), req.file.originalname || 'uploaded.csv');
    } else if (ext === '.zip') {
      await new Promise((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
          if (err) return reject(err);
          zipfile.readEntry();
          zipfile.on('entry', (entry) => {
            const name = entry.fileName || '';
            // directories
            if (/\/$/.test(name)) {
              zipfile.readEntry();
              return;
            }
            // only CSV files, prefer Google Fit related paths
            const lower = name.toLowerCase();
            if (!lower.endsWith('.csv') || (!lower.includes('fit') && !lower.includes('google fit') && !lower.includes('takeout'))) {
              zipfile.readEntry();
              return;
            }

            zipfile.openReadStream(entry, async (err2, stream) => {
              if (err2) {
                warnings.push(`Failed reading ${name}: ${err2.message}`);
                zipfile.readEntry();
                return;
              }
              try {
                await parseOneCsvStream(stream, name);
              } catch (e) {
                warnings.push(`Failed parsing ${name}: ${e.message}`);
              } finally {
                zipfile.readEntry();
              }
            });
          });
          zipfile.on('end', () => resolve());
          zipfile.on('close', () => resolve());
          zipfile.on('error', (e) => reject(e));
        });
      });

      if (filesParsed === 0) {
        warnings.push('No recognizable Google Fit CSVs found in the ZIP. If your export uses JSON only, share one file and we can add support.');
      }
    } else {
      return res.status(400).json({ error: 'Unsupported file type (use .zip or .csv)' });
    }

    // Upsert into DB
    const activityDays = new Set([...Object.keys(stepsByDay), ...Object.keys(hrSumByDay)]);
    let activityUpserts = 0;
    for (const day of activityDays) {
      const steps = stepsByDay[day] != null ? Math.round(stepsByDay[day]) : null;
      const hrAvg = (hrSumByDay[day] != null && hrCountByDay[day] != null && hrCountByDay[day] > 0)
        ? Math.round((hrSumByDay[day] / hrCountByDay[day]) * 10) / 10
        : null;
      await upsertDayActivity(userId, day, { steps, heart_rate_avg: hrAvg });
      activityUpserts++;
    }

    const sleepDays = Object.keys(sleepHoursByDay);
    let sleepUpserts = 0;
    for (const day of sleepDays) {
      const hrs = sleepHoursByDay[day];
      const duration = hrs != null ? Math.round(hrs * 100) / 100 : null;
      if (duration != null) {
        await upsertDaySleep(userId, day, { duration_hours: duration });
        sleepUpserts++;
      }
    }

    fs.unlink(filePath, () => {});

    res.json({
      message: 'Android import complete',
      imported: {
        activity_days: activityUpserts,
        sleep_days: sleepUpserts,
        files_parsed: filesParsed,
        warnings: warnings.length ? warnings : undefined
      }
    });
  } catch (e) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: e.message });
  }
});

// Garmin data upload endpoint
app.post('/api/garmin-upload', garminUpload.single('garminFile'), async (req, res) => {
  const userId = reqUserId(req);
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Please make sure you selected a file.' });
  }

  const filePath = req.file.path;
  const filename = req.file.originalname;
  
  console.log('Garmin file upload received:', filename);
  
  try {
    const parser = new GarminParser();
    const parsedData = await parser.parseFile(filePath, filename);
    
    // Import data into database
    const importResults = {
      activities: 0,
      sleep: 0,
      heartRate: 0,
      stress: 0,
      errors: []
    };

    // Import activities
    for (const activity of parsedData.activities) {
      if (activity.date && (activity.steps || activity.calories_burned || activity.heart_rate_avg)) {
        try {
          // Check if activity for this date already exists
          db.get('SELECT id FROM activity_data WHERE user_id = ? AND date = ?', [userId, activity.date], (err, existing) => {
            if (err) {
              importResults.errors.push(`Error checking existing activity: ${err.message}`);
              return;
            }
            
            if (existing) {
              // Update existing record
              db.run(
                'UPDATE activity_data SET steps = COALESCE(?, steps), calories_burned = COALESCE(?, calories_burned), heart_rate_avg = COALESCE(?, heart_rate_avg), active_minutes = COALESCE(?, active_minutes) WHERE user_id = ? AND date = ?',
                [activity.steps, activity.calories_burned, activity.heart_rate_avg, activity.active_minutes, userId, activity.date],
                function(updateErr) {
                  if (updateErr) {
                    importResults.errors.push(`Error updating activity: ${updateErr.message}`);
                  } else {
                    importResults.activities++;
                  }
                }
              );
            } else {
              // Insert new record
              db.run(
                'INSERT INTO activity_data (user_id, date, steps, calories_burned, heart_rate_avg, active_minutes) VALUES (?, ?, ?, ?, ?, ?)',
                [userId, activity.date, activity.steps, activity.calories_burned, activity.heart_rate_avg, activity.active_minutes],
                function(insertErr) {
                  if (insertErr) {
                    importResults.errors.push(`Error inserting activity: ${insertErr.message}`);
                  } else {
                    importResults.activities++;
                  }
                }
              );
            }
          });
        } catch (error) {
          importResults.errors.push(`Error processing activity: ${error.message}`);
        }
      }
    }

    // Import sleep data
    for (const sleep of parsedData.sleep) {
      if (sleep.date) {
        try {
          db.get('SELECT id FROM sleep_data WHERE user_id = ? AND date = ?', [userId, sleep.date], (err, existing) => {
            if (err) {
              importResults.errors.push(`Error checking existing sleep: ${err.message}`);
              return;
            }
            
            if (existing) {
              db.run(
                'UPDATE sleep_data SET score = COALESCE(?, score), duration_hours = COALESCE(?, duration_hours), deep_sleep_hours = COALESCE(?, deep_sleep_hours), rem_sleep_hours = COALESCE(?, rem_sleep_hours), bedtime = COALESCE(?, bedtime), wake_time = COALESCE(?, wake_time) WHERE user_id = ? AND date = ?',
                [sleep.score, sleep.duration_hours, sleep.deep_sleep_hours, sleep.rem_sleep_hours, sleep.bedtime, sleep.wake_time, userId, sleep.date],
                function(updateErr) {
                  if (updateErr) {
                    importResults.errors.push(`Error updating sleep: ${updateErr.message}`);
                  } else {
                    importResults.sleep++;
                  }
                }
              );
            } else {
              db.run(
                'INSERT INTO sleep_data (user_id, date, score, duration_hours, deep_sleep_hours, rem_sleep_hours, bedtime, wake_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [userId, sleep.date, sleep.score, sleep.duration_hours, sleep.deep_sleep_hours, sleep.rem_sleep_hours, sleep.bedtime, sleep.wake_time],
                function(insertErr) {
                  if (insertErr) {
                    importResults.errors.push(`Error inserting sleep: ${insertErr.message}`);
                  } else {
                    importResults.sleep++;
                  }
                }
              );
            }
          });
        } catch (error) {
          importResults.errors.push(`Error processing sleep: ${error.message}`);
        }
      }
    }

    // Import heart rate data (update activity records)
    for (const hr of parsedData.heartRate) {
      if (hr.date && hr.heart_rate_avg) {
        try {
          db.run(
            'UPDATE activity_data SET heart_rate_avg = ? WHERE user_id = ? AND date = ?',
            [hr.heart_rate_avg, userId, hr.date],
            function(updateErr) {
              if (!updateErr) {
                importResults.heartRate++;
              }
            }
          );
        } catch (error) {
          importResults.errors.push(`Error processing heart rate: ${error.message}`);
        }
      }
    }

    // Import stress data (update mood records)
    for (const stress of parsedData.stress) {
      if (stress.date && stress.stress_score) {
        try {
          db.get('SELECT id FROM mood_data WHERE user_id = ? AND date = ?', [userId, stress.date], (err, existing) => {
            if (err) {
              importResults.errors.push(`Error checking existing mood: ${err.message}`);
              return;
            }
            
            if (existing) {
              db.run(
                'UPDATE mood_data SET stress_score = ? WHERE user_id = ? AND date = ?',
                [stress.stress_score, userId, stress.date],
                function(updateErr) {
                  if (!updateErr) {
                    importResults.stress++;
                  }
                }
              );
            } else {
              // Create new mood entry with just stress score
              db.run(
                'INSERT INTO mood_data (user_id, date, mood_score, energy_score, stress_score, anxiety_score) VALUES (?, ?, 5, 5, ?, 5)',
                [userId, stress.date, stress.stress_score],
                function(insertErr) {
                  if (!insertErr) {
                    importResults.stress++;
                  }
                }
              );
            }
          });
        } catch (error) {
          importResults.errors.push(`Error processing stress: ${error.message}`);
        }
      }
    }

    // Wait a bit for async operations to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Clean up uploaded file
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) console.error('Error deleting file:', unlinkErr);
    });

    res.json({
      message: 'Garmin data imported successfully',
      imported: {
        activities: importResults.activities,
        sleep: importResults.sleep,
        heartRate: importResults.heartRate,
        stress: importResults.stress
      },
      errors: importResults.errors.length > 0 ? importResults.errors : undefined
    });

  } catch (error) {
    // Clean up uploaded file
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) console.error('Error deleting file:', unlinkErr);
    });
    
    console.error('Garmin upload error:', error);
    return res.status(500).json({ error: `Error processing Garmin file: ${error.message}` });
  }
});

// Get all genetic data
app.get('/api/genetic-data', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM genetic_data WHERE user_id = ? ORDER BY uploaded_at DESC', [userId]);
    // Parse analysis_results JSON for each row
    const parsedRows = rows.map(row => ({
      ...row,
      analysis_results: row.analysis_results ? JSON.parse(row.analysis_results) : null
    }));
    res.json(parsedRows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific genetic data by ID
app.get('/api/genetic-data/:id', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const id = req.params.id;
    const row = await getDb('SELECT * FROM genetic_data WHERE user_id = ? AND id = ?', [userId, id]);
    if (!row) {
      return res.status(404).json({ error: 'Genetic data not found' });
    }
    // Parse analysis_results JSON
    row.analysis_results = row.analysis_results ? JSON.parse(row.analysis_results) : null;
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analysis endpoints
app.get('/api/analysis/correlations', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const rows = await allDb('SELECT * FROM correlations WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analysis/correlations', async (req, res) => {
  try {
    const userId = reqUserId(req);
    const { factor1, factor2, correlation_coefficient, p_value, sample_size } = req.body;
    const result = await runDb(
      'INSERT INTO correlations (user_id, factor1, factor2, correlation_coefficient, p_value, sample_size) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, factor1, factor2, correlation_coefficient, p_value, sample_size]
    );
    res.json({ id: result.lastID, message: 'Correlation analysis saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard summary endpoint
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const userId = reqUserId(req);
    
    // Get recent data counts - use CURRENT_DATE for Postgres compatibility
    const dateExpr = USE_PG ? "CURRENT_DATE - INTERVAL '7 days'" : 'date("now", "-7 days")';
    const queries = [
      `SELECT COUNT(*) as count FROM sleep_data WHERE user_id = ? AND date >= ${dateExpr}`,
      `SELECT COUNT(*) as count FROM activity_data WHERE user_id = ? AND date >= ${dateExpr}`,
      `SELECT COUNT(*) as count FROM mood_data WHERE user_id = ? AND date >= ${dateExpr}`,
      `SELECT COUNT(*) as count FROM nutrition_data WHERE user_id = ? AND date >= ${dateExpr}`
    ];
    const keys = ['sleep', 'activity', 'mood', 'nutrition'];
    
    const results = {};
    for (let i = 0; i < queries.length; i++) {
      const row = await getDb(queries[i], [userId]);
      results[keys[i]] = row ? Number(row.count) : 0;
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all imported Garmin data
app.get('/api/garmin-data', async (req, res) => {
  try {
    const userId = reqUserId(req);
    
    // Get all data in parallel
    const [activities, sleep, heartRateRows, stressRows] = await Promise.all([
      allDb('SELECT * FROM activity_data WHERE user_id = ? ORDER BY date DESC', [userId]),
      allDb('SELECT * FROM sleep_data WHERE user_id = ? ORDER BY date DESC', [userId]),
      allDb('SELECT date, heart_rate_avg FROM activity_data WHERE user_id = ? AND heart_rate_avg IS NOT NULL ORDER BY date DESC', [userId]),
      allDb('SELECT date, stress_score FROM mood_data WHERE user_id = ? AND stress_score IS NOT NULL ORDER BY date DESC', [userId])
    ]);

    const results = {
      activities,
      sleep,
      heartRate: heartRateRows.map(row => ({ date: row.date, heart_rate_avg: row.heart_rate_avg })),
      stress: stressRows.map(row => ({ date: row.date, stress_score: row.stress_score }))
    };

    // Calculate summary statistics
    const summary = {
      totalActivities: results.activities.length,
      totalSleepRecords: results.sleep.length,
      totalHeartRateRecords: results.heartRate.length,
      totalStressRecords: results.stress.length,
      dateRange: { earliest: null, latest: null },
      averages: { steps: null, calories: null, heartRate: null, sleepDuration: null, sleepScore: null }
    };

    // Calculate date range
    const allDates = [
      ...results.activities.map(a => a.date),
      ...results.sleep.map(s => s.date),
      ...results.heartRate.map(h => h.date),
      ...results.stress.map(s => s.date)
    ].filter(d => d).sort();

    if (allDates.length > 0) {
      summary.dateRange.earliest = allDates[0];
      summary.dateRange.latest = allDates[allDates.length - 1];
    }

    // Calculate averages
    if (results.activities.length > 0) {
      const totalSteps = results.activities.reduce((sum, a) => sum + (a.steps || 0), 0);
      const totalCalories = results.activities.reduce((sum, a) => sum + (a.calories_burned || 0), 0);
      summary.averages.steps = Math.round(totalSteps / results.activities.length);
      summary.averages.calories = Math.round(totalCalories / results.activities.length);
    }

    if (results.heartRate.length > 0) {
      const totalHR = results.heartRate.reduce((sum, h) => sum + (h.heart_rate_avg || 0), 0);
      summary.averages.heartRate = Math.round(totalHR / results.heartRate.length);
    }

    if (results.sleep.length > 0) {
      const totalDuration = results.sleep.reduce((sum, s) => sum + (s.duration_hours || 0), 0);
      const totalScore = results.sleep.reduce((sum, s) => sum + (s.score || 0), 0);
      summary.averages.sleepDuration = (totalDuration / results.sleep.length).toFixed(1);
      summary.averages.sleepScore = (totalScore / results.sleep.length).toFixed(1);
    }

    res.json({ ...results, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper function for genetic data analysis
function analyzeGeneticData(data) {
  // Placeholder analysis - in a real app, this would use proper genetic analysis libraries
  const lines = data.split('\n');
  const snpCount = lines.filter(line => line.includes('rs')).length;
  
  return {
    totalSNPs: snpCount,
    analysisDate: new Date().toISOString(),
    recommendations: [
      'Consider vitamin D supplementation based on VDR gene variants',
      'Monitor caffeine sensitivity based on CYP1A2 variants',
      'Consider omega-3 supplementation for cardiovascular health'
    ],
    riskFactors: [
      'Slightly increased risk for type 2 diabetes',
      'Normal cardiovascular risk profile'
    ]
  };
}

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  // CSRF
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  console.error('Error:', err.message);
  console.error(err.stack);
  
  // Handle multer errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  
  // Handle other errors
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  try {
    if (serverHandle) serverHandle.close(() => {});
  } catch {}

  if (!USE_PG && db) {
    db.close((err) => {
      if (err) console.error(err.message);
      console.log('Database connection closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

