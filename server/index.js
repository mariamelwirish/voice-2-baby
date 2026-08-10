require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./config/db');
const authRoutes = require('./routes/auth'); // Imports the auth authorization routes defined in auth.js
const recordingsRoutes = require('./routes/recordings'); // Imports the recordings routes defined in recordings.js
const babiesRoutes = require('./routes/babies'); // Imports the baby recordings routes defined in babies.js
const roomsRoutes = require('./routes/rooms'); // Imports the rooms routes defined in rooms.js
const adminRoutes = require('./routes/admin'); // Imports the admin routes defined in admin.js
const devicesRoutes = require('./routes/devices'); // Imports the devices routes defined in devices.js
const { startScheduler } = require('./scheduler');
const { startIotSubscriber } = require('./iotSubscriber');
const { runMigrations } = require('./migrate');

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173'];

// Middleware
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use('/api/v1/auth', authRoutes); // Mounts the auth routes at /api/v1/auth. 
app.use('/api/v1/recordings', recordingsRoutes); // Mounts the recordings routes at /api/v1/recordings.
app.use('/api/v1/babies', babiesRoutes); // Mounts the baby recordings routes at /api/v1/babies.
app.use('/api/v1/rooms', roomsRoutes); // Mounts the rooms routes at /api/v1/rooms.
app.use('/api/v1/admin', adminRoutes); // Mounts the admin routes at /api/v1/admin.
app.use('/api/v1/devices', devicesRoutes); // Mounts the devices routes at /api/v1/devices.

// Health check route
app.get('/', (req, res) => {
  res.json({ message: 'Remote Reading API is running' });
});

// Test database connection then start server
pool.getConnection()
  .then(async connection => {
    console.log('Database connected successfully');
    connection.release();

    // Bring the schema up to date before serving traffic, so a deploy migrates
    // the DB on its own. Abort on failure — better a visible failed start than
    // the app running against a half-migrated schema. Opt out with RUN_MIGRATIONS=false.
    if (process.env.RUN_MIGRATIONS !== 'false') {
      try {
        await runMigrations();
      } catch (err) {
        console.error('Migrations failed — refusing to start:', err.message);
        process.exit(1);
      }
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    startScheduler();

    try {
      startIotSubscriber();
    } catch (err) {
      console.error('Failed to start IoT status subscriber (server continues without it):', err);
    }
  })
  .catch(err => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  });