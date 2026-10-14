// Phase 52 (spec D8, ruling 6). app.json, plus Firebase once it is there: the
// push token needs google-services.json, and a build without the file keeps
// working, with reminders dormant, until Victor adds it to apps/mobile.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) =>
  fs.existsSync(path.join(__dirname, 'google-services.json'))
    ? { ...config, android: { ...config.android, googleServicesFile: './google-services.json' } }
    : config;
