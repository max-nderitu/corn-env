const logsDir = process.cwd() + '/tmp/logs'

const sharedEnv = {
  NODE_ENV: 'production',

  API_PORT: 80,

  SCRAPER_PORT: 5001,

  // The name of the MongoDB database
  MONGO_DATABASE: 'popcorn-api',

  // The URI to the MongoDB database.
  MONGO_URI: '127.0.0.1',

  // The port of the MongoDB database.
  MONGO_PORT: '27017',

  // The username of the MongoDB database, disable if none.
  // MONGO_USER: '',

  // The password of the MongoDB database, disable if none.
  // MONGO_PASS: '',

  // Location where to download everything in, make sure this location exists
  // Also must be a absolute path
  DOWNLOAD_LOCATION: '/tmp/',

  // Username of your opensubtitles account
  // OPENSUBTITLES_USERNAME: '',

  // Password of your opensubtitles account
  // OPENSUBTITLES_PASSWORD: '',

  // API key for Fanart, get one here: https://fanart.tv/get-an-api-key/
  FANART_KEY: 'ce4bba4b3cc473306c6cddb4e1cb0da4',

  // API key for Omdb, get one here: http://www.omdbapi.com/apikey.aspx
  OMDB_KEY: 'some_key',

  // API key for Tmdb, get one here: https://www.themoviedb.org/settings/api/new/form?type=developer
  TMDB_KEY: 'ac92176abc89a80e6f5df9510e326601',

  // API key for Trakt, get one here: https://trakt.tv/oauth/applications/new (Use the client id)
  TRAKT_KEY: '647c69e4ed1ad13393bf6edd9d8f9fb6fe9faf405b44320a6b71ab960b4540a2',

  // API key for Tvdb, get one here: https://www.thetvdb.com/member/api
  TVDB_KEY: '80A769280C71D83B',
}

module.exports = {
  apps: [
    {
      name: 'API',
      script: 'dist/apps/api/main.js',
      instances: 1,
      max_restarts: 5,
      autorestart: true,
      watch: false,
      error_file: `${logsDir}/api/error.log`,
      out_file: `${logsDir}/api/out.log`,
      log_file: null,
      env: sharedEnv,
    },
    {
      name: 'Scraper',
      script: 'dist/apps/scraper/main.js',
      node_args: '--max-old-space-size=3072',
      instances: 1,
      max_restarts: 5,
      autorestart: true,
      watch: false,
      error_file: `${logsDir}/scraper/error.log`,
      out_file: `${logsDir}/scraper/out.log`,
      log_file: null,
      env: {
        ...sharedEnv,

        // The time between cronjobs.
        CRON_TIME: '0 0 */8 * * *',

        // The location of the temporary directory for the logs.
        TEMP_DIR: `${logsDir}/`,
      },
    },
  ],
}
